// Stale-part (dead air) detection from audio energy.
//
// 1. Stream mono 16 kHz PCM from ffmpeg and compute an RMS level (dBFS) per frame (default 20 ms) — constant memory.
// 2. Adaptive threshold: noise floor = 10th percentile, speech level = 95th percentile of frame levels;
//    threshold = floor + max(minContrastDb, contrast × (speech − floor)). Works for quiet phone takes (-35 LUFS)
//    and mastered audio alike. A fixed `thresholdDb` can override it.
// 3. Hysteresis (enter above threshold, leave below threshold − hysteresisDb), merge short gaps, drop blips.
// 4. Pad kept ranges with asymmetric margins (breath before, decay after — auto-editor style), then snap each cut
//    to the quietest frame nearby so cuts never land mid-syllable.
import { run, FFMPEG, probeVideo } from './ffmpeg.js';

export const STALE_DEFAULTS = {
  frameMs: 20,
  thresholdDb: null,      // null = adaptive
  speechBand: true,       // measure energy in 150 Hz–4 kHz (drops rumble, chair creaks, footsteps)
  contrast: 0.45,
  minContrastDb: 6,
  hysteresisDb: 3,
  minSpeech: 0.12,        // ignore sound islands shorter than this (clicks, bumps)
  minSilence: 0.35,       // gaps shorter than this stay inside the kept range (natural pauses)
  marginBefore: 0.12,
  marginAfter: 0.18,
  minKeep: 0.3,
  snapWindow: 0.08,
};

const SR = 16000;

/** RMS envelope in dBFS per frame. Returns { frameSec, db: Float32Array, duration }. */
export async function audioEnvelope(file, { frameMs = 20, speechBand = true, signal, onProgress, duration } = {}) {
  const frame = Math.round((SR * frameMs) / 1000);
  const dur = duration ?? (await probeVideo(file)).duration;
  const out = [];
  let acc = 0, n = 0, carry = null;
  const af = speechBand ? ['-af', 'highpass=f=150,lowpass=f=4000'] : [];
  await run(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'error', '-i', file, '-vn', ...af, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], {
    signal,
    onData: (buf) => {
      if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
      const even = buf.length & ~1;
      if (even < buf.length) carry = buf.subarray(even);
      for (let i = 0; i < even; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        acc += v * v;
        if (++n === frame) {
          out.push(10 * Math.log10(acc / n + 1e-12));
          acc = 0; n = 0;
          if (onProgress && out.length % 500 === 0) onProgress(Math.min(1, (out.length * frameMs) / 1000 / dur));
        }
      }
    },
  });
  if (n) out.push(10 * Math.log10(acc / n + 1e-12));
  return { frameSec: frameMs / 1000, db: Float32Array.from(out), duration: dur };
}

function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

/** Adaptive levels for an envelope. */
export function levels(env, o = STALE_DEFAULTS) {
  const floor = percentile(env.db, 0.1);
  const speech = percentile(env.db, 0.95);
  const auto = floor + Math.max(o.minContrastDb, o.contrast * (speech - floor));
  const threshold = o.thresholdDb ?? Math.min(auto, speech - 3);
  return { noiseFloorDb: +floor.toFixed(1), speechDb: +speech.toFixed(1), thresholdDb: +threshold.toFixed(1) };
}

/** Time (s) of the quietest frame in [from, to]. */
export function quietestPoint(env, from, to) {
  const a = Math.max(0, Math.floor(from / env.frameSec)), b = Math.min(env.db.length - 1, Math.ceil(to / env.frameSec));
  let best = a, min = Infinity;
  for (let i = a; i <= b; i++) if (env.db[i] < min) { min = env.db[i]; best = i; }
  return (best + 0.5) * env.frameSec;
}

/** Pure analysis on an envelope (exported for reuse/tests). */
export function analyzeEnvelope(env, opts = {}) {
  const o = { ...STALE_DEFAULTS, ...opts };
  const lv = levels(env, o);
  const f = env.frameSec;
  // 1. hysteresis → sound islands
  const islands = [];
  let on = false, start = 0;
  for (let i = 0; i < env.db.length; i++) {
    const d = env.db[i];
    if (!on && d >= lv.thresholdDb) { on = true; start = i; }
    else if (on && d < lv.thresholdDb - o.hysteresisDb) { on = false; islands.push([start * f, i * f]); }
  }
  if (on) islands.push([start * f, env.db.length * f]);
  // 2. merge short gaps, drop blips
  const merged = [];
  for (const s of islands) {
    const last = merged.at(-1);
    if (last && s[0] - last[1] < o.minSilence) last[1] = s[1]; else merged.push([...s]);
  }
  const speech = merged.filter(([a, b]) => b - a >= o.minSpeech);
  // 3. margins + snap to quiet frames (never into the speech itself)
  const keep = [];
  for (const [a, b] of speech) {
    let s = Math.max(0, a - o.marginBefore), e = Math.min(env.duration, b + o.marginAfter);
    s = Math.min(a, quietestPoint(env, s - o.snapWindow, s + o.snapWindow));
    e = Math.max(b, quietestPoint(env, e - o.snapWindow, e + o.snapWindow));
    const last = keep.at(-1);
    if (last && s <= last.end) last.end = Math.max(last.end, e); else keep.push({ start: s, end: e });
  }
  const kept = keep.filter((k) => k.end - k.start >= o.minKeep).map((k) => ({ start: +Math.max(0, k.start).toFixed(3), end: +Math.min(env.duration, k.end).toFixed(3) }));
  // 4. stale = complement
  const stale = [];
  let t = 0;
  for (const k of kept) { if (k.start - t > 0.01) stale.push({ start: +t.toFixed(3), end: k.start, reason: 'silence' }); t = k.end; }
  if (env.duration - t > 0.01) stale.push({ start: +t.toFixed(3), end: +env.duration.toFixed(3), reason: 'silence' });
  const keptSeconds = kept.reduce((s, k) => s + k.end - k.start, 0);
  return {
    keep: kept, stale, levels: lv, settings: o,
    stats: { sourceSeconds: +env.duration.toFixed(3), keptSeconds: +keptSeconds.toFixed(3), removedSeconds: +(env.duration - keptSeconds).toFixed(3), keptRatio: +(keptSeconds / (env.duration || 1)).toFixed(3), segments: kept.length },
  };
}

/**
 * Detect stale (silent / dead-air) parts of a media file.
 * @returns {Promise<{keep:{start,end}[], stale:{start,end,reason}[], levels, stats, envelope}>}
 */
export async function detectStale(file, opts = {}, { onProgress, signal } = {}) {
  const env = await audioEnvelope(file, { frameMs: opts.frameMs ?? STALE_DEFAULTS.frameMs, speechBand: opts.speechBand ?? STALE_DEFAULTS.speechBand, signal, onProgress, duration: opts.duration });
  return { ...analyzeEnvelope(env, opts), envelope: env };
}
