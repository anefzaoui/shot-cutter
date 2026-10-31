// Shot-boundary detection. Mode `fast` (default): two independent ffmpeg detectors (select 'scene' + scdet),
// reconciled into consensus boundaries, exactly as in v1.0/v1.1. Modes `sensitive`, `ml` and `hybrid` (v1.2) add
// adaptive and/or TransNetV2 detectors (lib/modes.js) and go through the same reconcile/gap/min-shot rules.
import { run, FFMPEG, probeVideo } from './ffmpeg.js';
import { MODES, MODE_DEFAULTS, PREFER, modeCandidates, tagAgreement } from './modes.js';

export const SHOT_DEFAULTS = { threshold: 0.3, scdet: 10, minShot: 0.5, gap: 0.12, tolerance: 0.06 };

const PRIMARY_RE = /Parsed_showinfo_\S*.*?pts_time:\s*([0-9]+(?:\.[0-9]+)?)/;
const SCDET_RE = /lavfi\.scd\.score:\s*([0-9]+(?:\.[0-9]+)?),\s*lavfi\.scd\.time:\s*([0-9]+(?:\.[0-9]+)?)/;

/**
 * Cluster near-identical detector reports into consensus boundaries.
 * Optional (v1.2): `prefer` = detector names in time-preference order (default: select-scene, else the first report);
 * `withScores` = also return `scores` {detector: best score} per boundary.
 */
export function reconcileBoundaries(candidates, duration, { tolerance, gap, prefer, withScores = false }) {
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
    let primary;
    if (prefer) { for (const d of prefer) if ((primary = cl.reports.find((r) => r.detector === d))) break; }
    else primary = cl.reports.find((r) => r.detector === 'select-scene'); // frame-accurate timestamp preferred
    const time = primary ? primary.time : cl.reports[0].time;
    const score = cl.reports.find((r) => r.score != null)?.score ?? null;
    if (time <= gap || time >= duration - gap) continue;
    const prev = boundaries.at(-1);
    if (prev && time - prev.time < gap) continue;
    const b = { time, detectors, consensus: detectors.length > 1, score };
    if (withScores) {
      b.scores = {};
      for (const r of cl.reports) if (r.score != null && !(r.score <= b.scores[r.detector])) b.scores[r.detector] = r.score;
    }
    boundaries.push(b);
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
 * @param {object} [opts]  threshold, scdet, minShot, gap, tolerance, duration (skip probe if known);
 *   mode: 'fast' (default) | 'sensitive' | 'ml' | 'hybrid', plus the mode options in MODE_DEFAULTS
 *   (adaptiveThreshold, adaptiveWindow, minContent, minHist, shortTransition, returnWindow, returnRatio, dissolves,
 *   maxDissolve, analysisSize, mlThreshold, device, python, mlRunner) and `probe` (skip probing if known).
 * @param {{onProgress?:(fraction:number)=>void, signal?:AbortSignal}} [ctl]
 * @returns {Promise<{boundaries, shots, mergeCount, primaryCount, auditCount, elapsedMs, mode?, ...}>}
 */
export async function detectShots(file, opts = {}, ctl = {}) {
  const mode = opts.mode ?? 'fast';
  if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}" (use ${MODES.join(', ')})`);
  if (mode !== 'fast') return detectShotsMode(file, mode, opts, ctl);
  const { onProgress, signal } = ctl;
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

const FAST_DETECTORS = new Set(['select-scene', 'scdet']);
const strength = (b) => [b.detectors.length, b.detectors.some((d) => FAST_DETECTORS.has(d)) ? 1 : 0, Math.max(0, ...Object.values(b.scores || {}))];
const stronger = (a, b) => { const x = strength(a), y = strength(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return true; };

/** Drop the weaker of any two boundaries closer than minShot (non-fast modes). */
export function thinBoundaries(boundaries, minShot) {
  const kept = [];
  let thinned = 0;
  for (const b of boundaries) {
    const last = kept.at(-1);
    if (last && b.time - last.time < minShot) { thinned++; if (!stronger(last, b)) kept[kept.length - 1] = b; }
    else kept.push(b);
  }
  return { boundaries: kept, thinned };
}

/** sensitive / ml / hybrid: candidates from lib/modes.js, then the same reconcile, gap and min-shot rules as fast. */
async function detectShotsMode(file, mode, opts, { onProgress, signal } = {}) {
  const o = { ...SHOT_DEFAULTS, ...MODE_DEFAULTS, ...opts };
  const started = Date.now();
  const probe = o.probe ?? await probeVideo(file);
  const dur = o.duration ?? probe.duration;
  const c = await modeCandidates(file, mode, o, { ...probe, duration: dur }, { onProgress, signal });
  // Reports for one cut can sit a frame or two apart across detectors; boundaries closer than `gap` are dropped
  // anyway, so cluster within the gap and keep every detector's evidence on the surviving boundary.
  let boundaries = reconcileBoundaries(c.candidates, dur, { tolerance: Math.max(o.tolerance, o.gap), gap: o.gap, prefer: PREFER, withScores: true });
  if (mode === 'hybrid') boundaries = tagAgreement(boundaries);
  // Two boundaries closer than minShot: keep the stronger one (fast's merge-into-previous could drop a real cut
  // in favour of a weak report right after it). Edge shots are still merged by mergeShortShots.
  let thinned = 0;
  ({ boundaries, thinned } = thinBoundaries(boundaries, o.minShot));
  const merged = mergeShortShots(buildShots(boundaries, dur), o.minShot);
  const { shots } = merged, mergeCount = merged.mergeCount + thinned;
  return {
    mode, boundaries, shots, mergeCount, primaryCount: c.primaryCount, auditCount: c.auditCount,
    adaptiveCount: c.adaptiveCount, mlCount: c.mlCount, frames: c.frames, timings: c.timings,
    vetoed: c.vetoed.map((v) => ({ time: v.time, detector: v.detector, score: v.score ?? null, reason: v.reason })),
    ...(c.ml ? { ml: c.ml } : {}), ...(c.analysis ? { analysis: c.analysis } : {}),
    elapsedMs: Date.now() - started,
  };
}
