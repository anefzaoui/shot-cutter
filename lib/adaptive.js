// Adaptive shot-boundary candidates (the `sensitive` mode), computed from FrameAnalyzer series.
//
// A frame is a cut when its difference stands out against the ROLLING MEDIAN of its neighbours
// (PySceneDetect AdaptiveDetector idea), not against a fixed threshold. That is what finds a cut between
// two similar-looking shots (same palette, same light): the absolute score is small, but next to the
// near-zero scores around it, it is a spike. A fast pan is the opposite: every frame scores high, so no
// single frame stands out.
//
// Detectors:
//   adaptive-content  one-frame HSV content spike vs the median of W neighbours on each side
//   adaptive-hist     the same on a luma/chroma histogram distance
//   adaptive-short    a 2..K-frame transition (quick dissolve, dip, motion-blurred cut): the difference
//                     between the frame before and the frame after the window, vs the same-lag difference
//                     on both sides of it (both sides must be calm)
//   dissolve          (only with `dissolves: true`) a longer cross-fade, cut once at its middle
// Every candidate passes a "return" check: if the picture before the spike comes back within
// `returnWindow` seconds (camera flash, hand or body passing the lens), it is not a cut.
import { sigDiff } from './frames.js';

export const ADAPTIVE_DEFAULTS = {
  adaptiveThreshold: 3,   // spike / neighbour-median ratio
  adaptiveWindow: 3,      // neighbours on each side (frames)
  minContent: 4,          // HSV content difference floor (0..255)
  minHist: 3,             // histogram distance floor (0..100)
  shortTransition: 0.3,   // seconds; longer gradual changes are motion or dissolves, never split by default
  returnWindow: 0.5,      // seconds checked for the old picture coming back
  returnRatio: 0.5,       // "came back" = difference under this share of the spike
  dissolves: false,       // also cut long dissolves (once, at the middle)
  flashFilter: true,      // drop any detector's report whose old picture comes back within returnWindow
  setupFilter: true,      // drop any detector's report where the camera set-up did not change (edges/luma correlate)
  sameSetupEdges: 0.75,   // edge-picture correlation at or above this...
  sameSetupLuma: 0.7,     // ...and luma-picture correlation at or above this = same set-up (lighting change)
  maxDissolve: 2.5,       // seconds
};

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Lags (in distinct frames) the analyzer must keep the edge/luma correlations for. */
export function structLagsNeeded(fps, o = {}) {
  return windows(fps, { ...ADAPTIVE_DEFAULTS, ...o }).K + 1;
}

/**
 * Frames of look-back the analyzer must keep for these options at this fps. The windows are counted in distinct
 * frames and computed at the full fps here, so footage with repeated frames is always covered.
 */
export function lagsNeeded(fps, o = {}) {
  const { K, M } = windows(fps, { ...ADAPTIVE_DEFAULTS, ...o });
  return K + M;
}

function windows(fps, o) {
  const f = fps && Number.isFinite(fps) ? fps : 25;
  return { K: Math.max(2, Math.min(12, Math.round(o.shortTransition * f))), M: Math.max(2, Math.min(12, Math.round(o.returnWindow * f))) };
}

/**
 * @param {{frames:number, lag:number[][], hist:number[], sig?:Float32Array[]}} series  FrameAnalyzer.result()
 * @param {number[]} times  pts time of each DISTINCT frame (series index)
 * @param {number} fps      rate of distinct frames (windows in seconds are converted with it)
 * @param {object} [opts]  ADAPTIVE_DEFAULTS overrides
 * @returns {Array<{time:number, detector:string, score:number, content?:number, frames?:number}>}
 */
export function adaptiveCandidates(series, times, fps, opts = {}) {
  const o = { ...ADAPTIVE_DEFAULTS, ...opts };
  const { lag, hist } = series;
  const N = Math.min(series.frames, times.length);
  const maxLag = lag.length - 1;
  const { K, M } = windows(fps, o);
  const W = Math.max(1, o.adaptiveWindow | 0);
  const D = (k, i) => (k >= 1 && k <= maxLag && i >= k && i < N ? lag[k][i] : null);
  const minBase = 0.5, minHistBase = 0.3;

  const returned = returnCheck(D, M, o.returnRatio);
  const sameSetup = setupCheck(series, N, o);

  const out = [];
  // content: one frame (L=1) and short transitions (L=2..K), best window wins (non-max suppression)
  const found = [];
  for (let b = 1; b < N; b++) {
    for (let L = 1; L <= K && b - L >= 0; L++) {
      const span = D(L, b);
      if (span == null || span < o.minContent) continue;
      let base;
      if (L === 1) {
        const nb = [];
        for (let j = b - W; j <= b + W; j++) if (j !== b && j >= 1 && j < N) nb.push(lag[1][j]);
        base = median(nb);
      } else {
        const before = [], after = [];
        for (let j = b - L - W + 1; j <= b - L; j++) { const v = D(L, j); if (v != null) before.push(v); }
        for (let j = b + L; j < b + L + W; j++) { const v = D(L, j); if (v != null) after.push(v); }
        if (!before.length && !after.length) continue;
        base = Math.max(median(before), median(after)); // both sides must be calm: a long dissolve or pan never is
      }
      const ratio = span / Math.max(base, minBase);
      if (ratio < o.adaptiveThreshold) continue;
      if (returned(b - L, b, span) || sameSetup(b - L, b)) continue;
      found.push({ b, L, span, ratio });
    }
  }
  found.sort((x, y) => y.ratio - x.ratio || x.L - y.L);
  const taken = [];
  for (const f of found) {
    const lo = f.b - f.L, hi = f.b;
    if (taken.some(([a, c]) => lo <= c + 1 && hi >= a - 1)) continue;
    taken.push([lo, hi]);
    const at = f.L === 1 ? f.b : f.b - Math.floor(f.L / 2);
    out.push({ time: times[at], detector: f.L === 1 ? 'adaptive-content' : 'adaptive-short', score: +f.ratio.toFixed(2), content: +f.span.toFixed(2), frames: f.L });
  }

  // histogram: one frame
  for (let b = 1; b < N; b++) {
    const hd = hist[b];
    if (hd < o.minHist) continue;
    const nb = [];
    for (let j = b - W; j <= b + W; j++) if (j !== b && j >= 1 && j < N) nb.push(hist[j]);
    const ratio = hd / Math.max(median(nb), minHistBase);
    if (ratio < o.adaptiveThreshold) continue;
    if (returned(b - 1, b, Math.max(lag[1][b], 1e-6)) || sameSetup(b - 1, b)) continue;
    out.push({ time: times[b], detector: 'adaptive-hist', score: +ratio.toFixed(2), hist: +hd.toFixed(2), frames: 1 });
  }

  if (o.dissolves && series.sig) out.push(...dissolveCandidates(series, times, fps, o, K));
  return out.sort((x, y) => x.time - y.time);
}

// old frame `a`, new frame `b`: does the old picture come back right after, or was the new one there right before?
function returnCheck(D, M, ratio) {
  return (a, b, span) => {
    const limit = ratio * span;
    for (let m = 1; m <= M; m++) {
      const fwd = D(b + m - a, b + m); if (fwd != null && fwd < limit) return true;
      const back = D(b - a + m, b); if (back != null && back < limit) return true;
    }
    return false;
  };
}

// old frame `a`, new frame `b`: compare `a` with the frame AFTER `b` (skipping the boundary frame itself, which may
// be blurred or mid-transition). Same set-up = edges and luma pattern still correlate: only the light changed.
function setupCheck(series, N, o) {
  const { simY, simG } = series;
  const maxK = simY ? simY.length - 1 : 0;
  return (a, b) => {
    if (!o.setupFilter || !maxK) return false;
    const c = b + 1, k = c - a;
    if (c >= N || k < 2 || k > maxK) return false;
    return simG[k][c] >= o.sameSetupEdges && simY[k][c] >= o.sameSetupLuma;
  };
}

/**
 * Vetoes for reports from the other detectors (select-scene, scdet, transnetv2): the frame with the biggest one-frame
 * change within ±1 frame of the report is taken as the cut; the report is dropped if the old picture comes back (or the
 * new one was already there) within `returnWindow` (flashFilter: flash, occlusion), or if the camera set-up did not
 * change (setupFilter: lightning, flicker, encoder pulses). Returns { kept, vetoed } (each vetoed has a `reason`).
 */
export function returnVeto(candidates, series, times, fps, opts = {}) {
  const o = { ...ADAPTIVE_DEFAULTS, ...opts };
  const { lag } = series;
  const N = Math.min(series.frames, times.length);
  const maxLag = lag.length - 1;
  const { M } = windows(fps, o);
  const D = (k, i) => (k >= 1 && k <= maxLag && i >= k && i < N ? lag[k][i] : null);
  const returned = returnCheck(D, M, o.returnRatio);
  const sameSetup = setupCheck(series, N, o);
  const frameAt = (t) => {
    let lo = 0, hi = N - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
    return lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t) ? lo - 1 : lo;
  };
  const kept = [], vetoed = [];
  for (const c of candidates) {
    if (!N) { kept.push(c); continue; }
    if (c.start != null && c.end != null && c.end > c.start) {
      // a reported multi-frame transition (TransNetV2): compare the frame before it with the frame after it
      const a = Math.max(0, frameAt(c.start) - 1), b = frameAt(c.end);
      const span = D(b - a, b);
      if (b - a >= 2 && span != null) {
        if (o.flashFilter && returned(a, b, span)) vetoed.push({ ...c, reason: 'returned' });
        else if (sameSetup(a, b)) vetoed.push({ ...c, reason: 'same-setup' });
        else kept.push(c);
        continue;
      }
      if (b - a >= 2) { kept.push(c); continue; } // longer than the analyzed look-back: cannot judge, keep
    }
    const b0 = frameAt(c.time);
    let e = -1, span = -1;
    for (let b = b0 - 1; b <= b0 + 1; b++) { const v = D(1, b); if (v != null && v > span) { span = v; e = b; } }
    if (e > 0 && span > 0 && o.flashFilter && returned(e - 1, e, span)) vetoed.push({ ...c, reason: 'returned' });
    else if (e > 0 && sameSetup(e - 1, e)) vetoed.push({ ...c, reason: 'same-setup' });
    else kept.push(c);
  }
  return { kept, vetoed };
}

/**
 * Long cross-fades: a run of consecutive changing frames, longer than a short transition, whose middle frames
 * are blends of the frame before and the frame after the run (a pan or a walk-in is not a blend, so it never matches).
 */
function dissolveCandidates(series, times, fps, o, K) {
  const { lag, sig } = series;
  const N = Math.min(series.frames, times.length);
  const f = fps || 25;
  const maxLen = Math.round(o.maxDissolve * f), win = Math.round(2 * f);
  const step = lag[1];
  const out = [];
  // calm baseline: 20th percentile of the per-frame change in a ±2 s window
  const elevated = new Uint8Array(N);
  for (let i = 1; i < N; i++) {
    const nb = [];
    for (let j = Math.max(1, i - win); j < Math.min(N, i + win); j += 2) nb.push(step[j]);
    nb.sort((a, b) => a - b);
    const calm = nb[Math.floor(nb.length * 0.2)] ?? 0;
    elevated[i] = step[i] >= 0.3 && step[i] >= 2 * Math.max(calm, 0.15) ? 1 : 0;
  }
  for (let i = 1; i < N;) {
    if (!elevated[i]) { i++; continue; }
    let j = i;
    while (j + 1 < N && (elevated[j + 1] || (j + 2 < N && elevated[j + 2]))) j++; // allow 1-frame gaps
    const a = i - 1, b = j, L = b - a;
    i = j + 1;
    if (L <= K || L > maxLen) continue;
    const A = sig[a], B = sig[b], total = sigDiff(A, B);
    if (total < 6) continue;
    let errSum = 0, prevAlpha = -1, monotone = 0, best = a + 1, bestGap = 1;
    let dd = 0; for (let p = 0; p < 256; p++) dd += (B[p] - A[p]) ** 2;
    for (let m = a + 1; m < b; m++) {
      const s = sig[m];
      let dot = 0; for (let p = 0; p < 256; p++) dot += (s[p] - A[p]) * (B[p] - A[p]);
      const alpha = Math.min(1, Math.max(0, dot / dd));
      let err = 0; for (let p = 0; p < 256; p++) err += Math.abs(s[p] - (A[p] + alpha * (B[p] - A[p])));
      errSum += err / 256;
      if (alpha >= prevAlpha - 0.05) monotone++;
      prevAlpha = alpha;
      if (Math.abs(alpha - 0.5) < bestGap) { bestGap = Math.abs(alpha - 0.5); best = m; }
    }
    const inner = b - a - 1;
    const blendErr = errSum / inner / total;
    if (blendErr > 0.25 || monotone < 0.8 * inner) continue;
    out.push({ time: times[best], detector: 'dissolve', score: +(1 - blendErr).toFixed(2), content: +total.toFixed(2), frames: L });
  }
  return out;
}
