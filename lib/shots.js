// Shot-boundary detection: two independent ffmpeg detectors (select 'scene' + scdet), reconciled into consensus
// boundaries. Behavior matches v1.0; stderr is now parsed as a stream (bounded memory) with a pinned log level.
import { run, FFMPEG, probeVideo } from './ffmpeg.js';

export const SHOT_DEFAULTS = { threshold: 0.3, scdet: 10, minShot: 0.5, gap: 0.12, tolerance: 0.06 };

const PRIMARY_RE = /Parsed_showinfo_\S*.*?pts_time:\s*([0-9]+(?:\.[0-9]+)?)/;
const SCDET_RE = /lavfi\.scd\.score:\s*([0-9]+(?:\.[0-9]+)?),\s*lavfi\.scd\.time:\s*([0-9]+(?:\.[0-9]+)?)/;

/** Cluster near-identical detector reports into consensus boundaries. */
export function reconcileBoundaries(candidates, duration, { tolerance, gap }) {
  const sorted = [...candidates].sort((x, y) => x.time - y.time);
  const clusters = [];
  for (const cand of sorted) {
    const last = clusters.at(-1);
    // Anchor on the cluster's FIRST report so two real cuts close together are not chained into one.
    if (last && cand.time - last.reports[0].time <= tolerance) last.reports.push(cand);
    else clusters.push({ reports: [cand] });
  }
  const boundaries = [];
  for (const cl of clusters) {
    const detectors = [...new Set(cl.reports.map((r) => r.detector))].sort();
    const primary = cl.reports.find((r) => r.detector === 'select-scene'); // frame-accurate timestamp preferred
    const time = primary ? primary.time : cl.reports[0].time;
    const score = cl.reports.find((r) => r.score != null)?.score ?? null;
    if (time <= gap || time >= duration - gap) continue;
    const prev = boundaries.at(-1);
    if (prev && time - prev.time < gap) continue;
    boundaries.push({ time, detectors, consensus: detectors.length > 1, score });
  }
  return boundaries;
}

export function buildShots(boundaries, duration) {
  const times = [0, ...boundaries.map((b) => b.time), duration];
  return times.slice(0, -1).map((t, i) => ({
    start: t, end: times[i + 1], duration: times[i + 1] - t, openedBy: i === 0 ? null : boundaries[i - 1],
  }));
}

/** Merge shots shorter than minShot into a neighbor (previous preferred). */
export function mergeShortShots(shots, minShot) {
  const merged = [...shots];
  let mergeCount = 0, idx;
  while (merged.length > 1 && (idx = merged.findIndex((s) => s.duration < minShot)) !== -1) {
    const short = merged[idx];
    if (idx > 0) merged[idx - 1] = { ...merged[idx - 1], end: short.end, duration: short.end - merged[idx - 1].start };
    else merged[1] = { ...merged[1], start: short.start, duration: merged[1].end - short.start, openedBy: null };
    merged.splice(idx, 1);
    mergeCount++;
  }
  return { shots: merged, mergeCount };
}

/**
 * Detect shot boundaries.
 * @param {string} file
 * @param {object} [opts]  threshold, scdet, minShot, gap, tolerance, duration (skip probe if known)
 * @param {{onProgress?:(fraction:number)=>void, signal?:AbortSignal}} [ctl]
 * @returns {Promise<{boundaries, shots, mergeCount, primaryCount, auditCount, elapsedMs}>}
 */
export async function detectShots(file, opts = {}, { onProgress, signal } = {}) {
  const o = { ...SHOT_DEFAULTS, ...opts };
  const dur = o.duration ?? (await probeVideo(file)).duration;
  const primary = [], audit = [];
  const started = Date.now();
  const filter = `[0:v]split=2[p][a];[p]select='gt(scene,${o.threshold})',showinfo[primary];[a]scdet=t=${o.scdet}:s=1[audit]`;
  await run(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'info', '-i', file, '-filter_complex', filter,
    '-map', '[primary]', '-map', '[audit]', '-an', '-f', 'null', '-progress', 'pipe:1', '-'], {
    signal,
    onProgress: (t) => onProgress?.(dur ? Math.min(1, t / dur) : 0),
    onLine: (line) => {
      let m = PRIMARY_RE.exec(line);
      if (m) { primary.push({ time: Number(m[1]), detector: 'select-scene' }); return; }
      m = SCDET_RE.exec(line);
      if (m) audit.push({ time: Number(m[2]), detector: 'scdet', score: Number(m[1]) });
    },
  });
  const boundaries = reconcileBoundaries([...primary, ...audit], dur, o);
  const { shots, mergeCount } = mergeShortShots(buildShots(boundaries, dur), o.minShot);
  return { boundaries, shots, mergeCount, primaryCount: primary.length, auditCount: audit.length, elapsedMs: Date.now() - started };
}
