// Cut modes beyond `fast` (which stays in shots.js, unchanged):
//   sensitive  fast's two ffmpeg detectors + adaptive detectors (and fades through dark) on per-frame thumbnails, in the SAME decode pass
//   ml         TransNetV2 through the optional Python helper (tools/transnetv2_runner.py)
//   hybrid     sensitive ∪ ml, each boundary tagged with which side found it (`agreement`)
import { run, FFMPEG } from './ffmpeg.js';
import { FrameAnalyzer } from './frames.js';
import { adaptiveCandidates, dipCandidates, returnVeto, lagsNeeded, structLagsNeeded, ADAPTIVE_DEFAULTS } from './adaptive.js';
import { runTransNet, mlCandidates, ML_DEFAULTS } from './ml.js';

export const MODES = ['fast', 'sensitive', 'ml', 'hybrid'];
export const MODE_DEFAULTS = { ...ADAPTIVE_DEFAULTS, ...ML_DEFAULTS, analysisSize: 64 };

const SCDET_RE = /lavfi\.scd\.score:\s*([0-9]+(?:\.[0-9]+)?),\s*lavfi\.scd\.time:\s*([0-9]+(?:\.[0-9]+)?)/;
// select-scene reports come from metadata=print here (gives the scene score too): a frame line, then its score line
const SELECT_FRAME_RE = /^\[Parsed_metadata_\S* @ [^\]]*\]\s*frame:\s*\d+\s+pts:\s*\S+\s+pts_time:\s*([0-9]+(?:\.[0-9]+)?)/;
const SELECT_SCORE_RE = /^\[Parsed_metadata_\S* @ [^\]]*\]\s*lavfi\.scene_score=([0-9.]+)/;
const FRAME_RE = /^\[showinfo@frames @ [^\]]*\]\s*n:\s*(\d+)\s.*?pts_time:\s*(-?[0-9.]+(?:e-?\d+)?)/;
const PROGRESS_RE = /^out_time_us=(\d+)/;

/** Which side of `hybrid` a detector belongs to. */
export const detectorFamily = (d) => (d === 'transnetv2' ? 'ml' : 'sensitive');

/** Time preference when several detectors report the same cut (frame-accurate ones first). */
export const PREFER = ['select-scene', 'scdet', 'adaptive-content', 'adaptive-hist', 'transnetv2', 'adaptive-short', 'dissolve', 'dip'];

/** Thumbnail size for the per-frame analysis (long side = analysisSize, aspect kept). */
export function analysisDims(width, height, size = 64) {
  if (!width || !height) return { w: size, h: size };
  const r = width / height;
  return r >= 1 ? { w: size, h: Math.max(8, Math.round(size / r)) } : { w: Math.max(8, Math.round(size * r)), h: size };
}

/**
 * The ffmpeg arguments of the sensitive pass (one decode: select-scene + scdet as in fast mode, + rgb thumbnails).
 * `rawOut` is where the thumbnails go: 'pipe:1' (default) or a file path, for callers that run ffmpeg elsewhere
 * (e.g. on another machine) and hand the log and the file to detectShotsFromLog().
 */
export function sensitiveArgs(file, probe, opts = {}, rawOut = 'pipe:1') {
  const o = { ...MODE_DEFAULTS, threshold: 0.3, scdet: 10, ...opts };
  const { w, h } = analysisDims(probe.width, probe.height, o.analysisSize);
  // The two fast detectors end in nullsink (they only log); mapping them to a null output would fail
  // ("nothing was written") on a clip where neither passes a single frame.
  const filter = `[0:v]split=3[p][a][r];[p]select='gt(scene,${o.threshold})',metadata=print:key=lavfi.scene_score,nullsink;[a]scdet=t=${o.scdet}:s=1,nullsink;`
    + `[r]scale=${w}:${h}:flags=area,format=rgb24,showinfo@frames[raw]`;
  return ['-hide_banner', '-nostats', '-loglevel', 'info', '-progress', 'pipe:2', '-i', file, '-filter_complex', filter,
    '-map', '[raw]', '-fps_mode', 'passthrough', '-f', 'rawvideo', ...(rawOut === 'pipe:1' ? [] : ['-y']), rawOut];
}

/** Collects one sensitive pass: feed it ffmpeg's stderr lines and the raw thumbnails, then finish(). */
export function sensitiveCollector(o, probe, { onProgress } = {}) {
  const dur = probe.duration;
  const { w, h } = analysisDims(probe.width, probe.height, o.analysisSize);
  const analyzer = new FrameAnalyzer({ width: w, height: h, maxLag: lagsNeeded(probe.fps, o), signatures: !!o.dissolves,
    structLags: o.setupFilter === false ? 0 : structLagsNeeded(probe.fps, o) });
  const primary = [], audit = [], frameTimes = [];
  const onLine = (line) => {
    let m = FRAME_RE.exec(line);
    if (m) { frameTimes[Number(m[1])] = Number(m[2]); return; }
    m = SELECT_FRAME_RE.exec(line);
    if (m) { primary.push({ time: Number(m[1]), detector: 'select-scene' }); return; }
    m = SELECT_SCORE_RE.exec(line);
    if (m && primary.length) { primary.at(-1).score = +(Number(m[1]) * 100).toFixed(3); return; }
    m = SCDET_RE.exec(line);
    if (m) { audit.push({ time: Number(m[2]), detector: 'scdet', score: Number(m[1]) }); return; }
    m = PROGRESS_RE.exec(line);
    if (m && onProgress) onProgress(dur ? Math.min(1, Number(m[1]) / 1e6 / dur) : 0);
  };
  return { onLine, onData: (chunk) => analyzer.push(chunk), finish: () => finishSensitive(analyzer, primary, audit, frameTimes, probe, o, { w, h }) };
}

/** One decode pass here: select-scene + scdet (as in fast mode) + rgb thumbnails for the adaptive detectors. */
export async function sensitivePass(file, o, probe, { onProgress, signal } = {}) {
  const started = Date.now();
  const col = sensitiveCollector(o, probe, { onProgress });
  await run(FFMPEG, sensitiveArgs(file, probe, o), { signal, onData: col.onData, onLine: col.onLine });
  return { ...col.finish(), elapsedMs: Date.now() - started };
}

function finishSensitive(analyzer, primary, audit, frameTimes, probe, o, { w, h }) {
  const series = analyzer.result();
  // pts per distinct frame (fallback: constant frame rate, if a log line was ever missed)
  const srcFps = probe.fps || 25;
  const times = series.index.map((n) => (Number.isFinite(frameTimes[n]) ? frameTimes[n] : (frameTimes[0] || 0) + n / srcFps));
  // windows are in seconds: convert them with the rate of DISTINCT frames (repeated frames are not analyzed)
  const span = times.length > 1 ? times.at(-1) - times[0] : 0;
  const fps = span > 0 ? Math.min(srcFps, (times.length - 1) / span) : srcFps;
  const adaptive = adaptiveCandidates(series, times, fps, o);
  const dips = dipCandidates(series, times, fps, o);
  // the series is returned for the vetoes of the other detectors' reports
  return {
    primary, audit, adaptive, dips, series, times, fps, frames: series.decoded,
    analysis: { width: w, height: h, distinctFrames: series.frames, repeatedFrames: series.duplicates, distinctFps: +fps.toFixed(3) },
  };
}

/**
 * Candidates for a non-fast mode. Returns every detector's raw reports plus timings.
 * @returns {Promise<{candidates:Array, primaryCount:number, auditCount:number, adaptiveCount:number, mlCount:number, frames:number, timings:object, ml?:object, analysis?:object}>}
 */
export async function modeCandidates(file, mode, o, probe, { onProgress, signal, sensitive, predictions } = {}) {
  const wantSensitive = mode === 'sensitive' || mode === 'hybrid';
  const wantMl = mode === 'ml' || mode === 'hybrid';
  let sens = sensitive ?? null, pred = predictions ?? null, mlMs = 0;
  // one failure (or the caller's abort) stops the other process too
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const tasks = [];
  if (wantSensitive && !sens) tasks.push(sensitivePass(file, o, probe, { signal: ac.signal, onProgress: (f) => onProgress?.(wantMl ? 0.9 * f : f) }).then((r) => { sens = r; }));
  if (wantMl && !pred) {
    const t = Date.now();
    tasks.push(runTransNet(file, o, { signal: ac.signal }).then((r) => { pred = r; mlMs = Date.now() - t; }));
  }
  try {
    await Promise.all(tasks.map((p) => p.catch((err) => { ac.abort(); throw err; })));
  } catch (err) {
    await Promise.allSettled(tasks);
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  onProgress?.(1);
  const ml = pred ? mlCandidates(pred, probe.fps, o) : [];
  let others = [...(sens ? [...sens.primary, ...sens.audit] : []), ...ml], vetoed = [];
  if (sens && (o.flashFilter || o.setupFilter)) ({ kept: others, vetoed } = returnVeto(others, sens.series, sens.times, sens.fps, o));
  const found = [...others, ...(sens ? sens.adaptive : [])];
  // a fade through dark that another detector already cut (anywhere in its fall, hold or rise) adds nothing; this also
  // keeps a black card that is a shot of its own from being split at its darkest frame
  const pad = o.gap ?? 0.12;
  const dips = (sens?.dips ?? []).filter((d) => !found.some((c) => c.time >= d.dipStart - pad && c.time <= d.dipEnd + pad));
  const candidates = [...found, ...dips];
  return {
    candidates, vetoed,
    primaryCount: sens?.primary.length ?? 0, auditCount: sens?.audit.length ?? 0,
    adaptiveCount: sens?.adaptive.length ?? 0, dipCount: dips.length, mlCount: ml.length,
    frames: sens?.frames ?? pred?.frames ?? 0,
    timings: { ...(sens?.elapsedMs != null ? { sensitiveMs: sens.elapsedMs } : {}), ...(pred ? { mlMs, mlModelMs: pred.elapsedMs } : {}) },
    ...(pred ? { ml: { backend: pred.backend, device: pred.device } } : {}),
    ...(sens ? { analysis: sens.analysis } : {}),
  };
}

/** Tag hybrid boundaries with which side found them. */
export function tagAgreement(boundaries) {
  return boundaries.map((b) => {
    const fams = new Set(b.detectors.map(detectorFamily));
    return { ...b, agreement: fams.size > 1 ? 'both' : [...fams][0] };
  });
}

