// Per-frame analysis for the `sensitive` mode (pure JS, no dependencies).
// Frames arrive as small rgb24 thumbnails (ffmpeg scales them in the same decode pass).
// Near-duplicate frames (content difference to the last kept frame under `dupThreshold`) are skipped: many web
// videos repeat frames (frame-rate conversion, low-fps sources), and a series that alternates real motion with
// zeros makes every ordinary motion frame look like a spike against its neighbours. For every DISTINCT frame u:
//   index[u]   its frame number in the decoded stream
//   lag[k][u]  HSV content difference between distinct frames u-k and u (k = 1..maxLag), ContentDetector style
//   hist[u]    luma/chroma histogram distance between distinct frames u-1 and u (0..100)
//   sig[u]     optional 16x16 luma signature (only when dissolve detection is asked; long-range comparisons)
//   luma[u]    mean luma (0..255) and yuv[u] its luma/chroma histograms, grid[u] an 8x8 block-mean luma picture
//              (a few hundred bytes per frame; the dip detector compares frames up to a second apart)
//   simY[k][u], simG[k][u]  (k = 2..structLags) normalized cross-correlation of the luma picture and of its edge
//              (gradient) picture between distinct frames u-k and u: brightness-independent "is this the same camera
//              set-up" evidence (lightning, flicker and encoder pulses keep the edges; a cut does not)
// Memory is bounded: only the last maxLag thumbnails are held; the rest are a few numbers per frame.

const HUE_BINS = 256;

/** RGB thumbnail → HSV planes (H 0..255 circular, S/V 0..255) + YUV histograms. */
function convert(rgb, n) {
  const hsv = new Uint8Array(n * 3);
  const hy = new Float32Array(32), hu = new Float32Array(16), hv = new Float32Array(16);
  let ysum = 0;
  for (let p = 0, q = 0; p < n; p++, q += 3) {
    const r = rgb[q], g = rgb[q + 1], b = rgb[q + 2];
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d + 6) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * HUE_BINS / 6) & 255;
    }
    hsv[q] = h; hsv[q + 1] = max ? Math.round((255 * d) / max) : 0; hsv[q + 2] = max;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    ysum += y;
    const u = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const v = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    hy[Math.min(31, y >> 3)]++; hu[Math.min(15, Math.max(0, u) >> 4)]++; hv[Math.min(15, Math.max(0, v) >> 4)]++;
  }
  for (const h of [hy, hu, hv]) for (let i = 0; i < h.length; i++) h[i] /= n;
  return { hsv, hist: [hy, hu, hv], luma: ysum / n };
}

/** 8x8 block-mean luma picture (0..255), for comparing frames far apart (dip detector). */
function grid8(rgb, w, h) {
  const out = new Float32Array(64), cnt = new Uint16Array(64);
  for (let y = 0; y < h; y++) {
    const by = Math.min(7, Math.floor((y * 8) / h));
    for (let x = 0; x < w; x++) {
      const b = by * 8 + Math.min(7, Math.floor((x * 8) / w)), q = (y * w + x) * 3;
      out[b] += 0.299 * rgb[q] + 0.587 * rgb[q + 1] + 0.114 * rgb[q + 2]; cnt[b]++;
    }
  }
  for (let b = 0; b < 64; b++) out[b] = cnt[b] ? out[b] / cnt[b] : 0;
  return out;
}

/** Zero-mean, unit-norm vector (null when the picture is flat: no structure to compare). */
function normalize(v) {
  let m = 0; for (let i = 0; i < v.length; i++) m += v[i]; m /= v.length;
  let ss = 0; for (let i = 0; i < v.length; i++) { v[i] -= m; ss += v[i] * v[i]; }
  if (ss / v.length < 1) return null; // under 1 grey level of variation
  const k = 1 / Math.sqrt(ss); for (let i = 0; i < v.length; i++) v[i] *= k;
  return v;
}

/** Luma and edge-magnitude pictures, normalized for cross-correlation. */
function structure(rgb, w, h) {
  const n = w * h, y = new Float32Array(n), g = new Float32Array(n);
  for (let p = 0, q = 0; p < n; p++, q += 3) y[p] = 0.299 * rgb[q] + 0.587 * rgb[q + 1] + 0.114 * rgb[q + 2];
  for (let r = 1; r < h - 1; r++) for (let c = 1; c < w - 1; c++) {
    const i = r * w + c; g[i] = Math.abs(y[i + 1] - y[i - 1]) + Math.abs(y[i + w] - y[i - w]);
  }
  return { ny: normalize(y), ng: normalize(g) };
}

const dot = (a, b) => { if (!a || !b) return 0; let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/**
 * Mean HSV difference (0..255). Hue is circular and weighted by saturation, so hue noise in grey/dark pixels
 * (common in dim, low-saturation footage) does not drown real changes.
 */
export function contentDiff(a, b, n) {
  let dh = 0, ds = 0, dv = 0;
  for (let q = 0; q < n * 3; q += 3) {
    let h = Math.abs(a[q] - b[q]); if (h > 128) h = 256 - h;
    const s = a[q + 1] < b[q + 1] ? a[q + 1] : b[q + 1];
    dh += (2 * h * s) / 255; ds += Math.abs(a[q + 1] - b[q + 1]); dv += Math.abs(a[q + 2] - b[q + 2]);
  }
  return (dh + ds + dv) / (3 * n);
}

/** Histogram distance 0..100 (half L1, luma weighted 1/2, each chroma 1/4). */
export function histDiff(a, b) {
  const l1 = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]); return s / 2; };
  return 100 * (0.5 * l1(a[0], b[0]) + 0.25 * l1(a[1], b[1]) + 0.25 * l1(a[2], b[2]));
}

/** Streaming analyzer: push thumbnails (any chunking), read the per-frame series at the end. */
export class FrameAnalyzer {
  constructor({ width, height, maxLag = 16, signatures = false, dupThreshold = 0.5, structLags = 0 }) {
    this.dupThreshold = dupThreshold; this.duplicates = 0; this.index = [];
    this.structLags = Math.min(structLags, maxLag);
    this.simY = Array.from({ length: this.structLags + 1 }, () => []);
    this.simG = Array.from({ length: this.structLags + 1 }, () => []);
    this.w = width; this.h = height; this.n = width * height; this.frameBytes = this.n * 3;
    this.maxLag = maxLag; this.signatures = signatures;
    this.ring = []; // last maxLag frames: { hsv, hist }
    this.lag = Array.from({ length: maxLag + 1 }, () => []); // lag[k][i]; lag[0] unused
    this.hist = [];
    this.luma = []; this.yuv = []; this.grid = [];
    this.sig = signatures ? [] : null;
    this.count = 0;
    this.pending = null; this.pendingLen = 0;
  }

  /** Feed raw rgb24 bytes (stdout chunks). */
  push(chunk) {
    let off = 0;
    if (this.pending) {
      const take = Math.min(this.frameBytes - this.pendingLen, chunk.length);
      chunk.copy(this.pending, this.pendingLen, 0, take);
      this.pendingLen += take; off = take;
      if (this.pendingLen < this.frameBytes) return;
      this.frame(this.pending); this.pending = null; this.pendingLen = 0;
    }
    while (chunk.length - off >= this.frameBytes) { this.frame(chunk.subarray(off, off + this.frameBytes)); off += this.frameBytes; }
    if (off < chunk.length) { this.pending = Buffer.alloc(this.frameBytes); chunk.copy(this.pending, 0, off); this.pendingLen = chunk.length - off; }
  }

  frame(rgb) {
    const cur = convert(rgb, this.n);
    const frameNo = this.count++;
    const last = this.ring.at(-1);
    const d1 = last ? contentDiff(last.hsv, cur.hsv, this.n) : 0;
    if (last && d1 < this.dupThreshold) { this.duplicates++; return; }
    const i = this.index.length;
    this.index.push(frameNo);
    this.lag[1][i] = d1;
    for (let k = 2; k <= this.maxLag; k++) {
      const prev = this.ring[this.ring.length - k];
      this.lag[k][i] = prev ? contentDiff(prev.hsv, cur.hsv, this.n) : 0;
    }
    this.hist[i] = last ? histDiff(last.hist, cur.hist) : 0;
    this.luma[i] = cur.luma; this.yuv[i] = cur.hist; this.grid[i] = grid8(rgb, this.w, this.h);
    if (this.structLags >= 2) {
      Object.assign(cur, structure(rgb, this.w, this.h));
      for (let k = 2; k <= this.structLags; k++) {
        const prev = this.ring[this.ring.length - k];
        this.simY[k][i] = prev ? dot(prev.ny, cur.ny) : 0;
        this.simG[k][i] = prev ? dot(prev.ng, cur.ng) : 0;
      }
    }
    if (this.sig) this.sig[i] = signature(cur.hsv, this.w, this.h);
    this.ring.push(cur);
    if (this.ring.length > this.maxLag) this.ring.shift();
  }

  /** Series for the candidate finder: `frames` distinct frames, `index` maps them to decoded frame numbers. */
  result() {
    return {
      frames: this.index.length, decoded: this.count, duplicates: this.duplicates, index: this.index,
      lag: this.lag, hist: this.hist, luma: this.luma, yuv: this.yuv, grid: this.grid, sig: this.sig, simY: this.simY, simG: this.simG,
    };
  }
}

/** 16x16 block-mean luma (V) signature for long-range (dissolve) comparisons. */
function signature(hsv, w, h) {
  const out = new Float32Array(256), cnt = new Uint16Array(256);
  for (let y = 0; y < h; y++) {
    const by = Math.min(15, Math.floor((y * 16) / h));
    for (let x = 0; x < w; x++) {
      const b = by * 16 + Math.min(15, Math.floor((x * 16) / w));
      out[b] += hsv[(y * w + x) * 3 + 2]; cnt[b]++;
    }
  }
  for (let b = 0; b < 256; b++) out[b] = cnt[b] ? out[b] / cnt[b] : 0;
  return out;
}

export const sigDiff = (a, b) => { let s = 0; for (let i = 0; i < 256; i++) s += Math.abs(a[i] - b[i]); return s / 256; };
