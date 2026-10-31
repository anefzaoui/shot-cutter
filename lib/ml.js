// The `ml` detector: TransNetV2 (a shot-boundary network) through the optional Python helper
// tools/transnetv2_runner.py. Never a hard dependency: nothing here runs unless mode is `ml` or `hybrid`.
//   python   SHOT_CUTTER_PYTHON or opts.python   (default python3, or python on Windows)
//   runner   SHOT_CUTTER_ML_RUNNER or opts.mlRunner (default: the helper shipped in this repo)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, FFMPEG } from './ffmpeg.js';

export const ML_DEFAULTS = { mlThreshold: 0.5, device: 'cpu' };
export const DEFAULT_RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'transnetv2_runner.py');
const NOT_INSTALLED = 3;

export const INSTALL_HINT = `TransNetV2 is optional and installs in its own venv, for example:
  python3 -m venv ~/.shot-cutter-ml
  ~/.shot-cutter-ml/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
  ~/.shot-cutter-ml/bin/pip install transnetv2-pytorch
then point shot-cutter at it: SHOT_CUTTER_PYTHON=~/.shot-cutter-ml/bin/python (or --python / opts.python).`;

export class MlUnavailableError extends Error {
  constructor(detail) {
    super(`ml mode needs the TransNetV2 helper, which is not available (${detail}).\n${INSTALL_HINT}`);
    this.name = 'MlUnavailableError'; this.code = 'ML_UNAVAILABLE';
  }
}

const resolve = (o = {}) => ({
  python: o.python || process.env.SHOT_CUTTER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
  runner: o.mlRunner || process.env.SHOT_CUTTER_ML_RUNNER || DEFAULT_RUNNER,
});

function explain(err, python) {
  const msg = String(err?.message || err);
  if (/ENOENT/.test(msg)) return new MlUnavailableError(`${python} not found`);
  if (new RegExp(`exited ${NOT_INSTALLED}:`).test(msg)) return new MlUnavailableError(msg.replace(/^.*?exited \d+: /, ''));
  return err;
}

/** Is the helper usable? Never throws: { ok, backend?, device?, python, error? } */
export async function mlAvailable(opts = {}) {
  const { python, runner } = resolve(opts);
  try {
    const { stdout } = await run(python, [runner, '--check'], { capture: true, signal: opts.signal });
    return { ...JSON.parse(stdout.toString()), python };
  } catch (err) {
    return { ok: false, python, error: explain(err, python).message };
  }
}

/** Per-frame TransNetV2 predictions for `file`: { backend, device, frames, times, single, many, elapsedMs } */
export async function runTransNet(file, opts = {}, { signal } = {}) {
  const { python, runner } = resolve(opts);
  const args = [runner, file, '--ffmpeg', FFMPEG, '--device', opts.device || ML_DEFAULTS.device];
  try {
    const { stdout } = await run(python, args, { capture: true, signal });
    return JSON.parse(stdout.toString());
  } catch (err) {
    throw explain(err, python);
  }
}

/**
 * Predictions → boundary candidates. A run of frames whose single-frame probability is over the threshold is one
 * transition. Its length is taken from the many-hot output (which covers every frame of a transition, while the
 * single-frame output only peaks at a dissolve's centre): short transitions (a cut, a quick dissolve) give one
 * boundary on the frame after the peak (TransNetV2 marks the last frame of the outgoing shot); transitions longer
 * than `shortTransition` are gradual and only cut (at their middle) when `dissolves` is set.
 */
export function mlCandidates(pred, fps, opts = {}) {
  const thr = opts.mlThreshold ?? ML_DEFAULTS.mlThreshold;
  const K = Math.max(2, Math.min(12, Math.round((opts.shortTransition ?? 0.3) * (fps || 25))));
  const { single, times } = pred;
  const many = pred.many?.length === single.length ? pred.many : null;
  const N = Math.min(single.length, times.length);
  const out = [];
  for (let i = 0; i < N;) {
    if (!(single[i] > thr)) { i++; continue; }
    let j = i, peak = i;
    while (j + 1 < N && single[j + 1] > thr) { j++; if (single[j] > single[peak]) peak = j; }
    let a = i, b = j;
    if (many) { while (a > 0 && many[a - 1] > thr) a--; while (b + 1 < N && many[b + 1] > thr) b++; }
    const L = b - a + 1;
    i = Math.max(j, b) + 1;
    const gradual = L > K;
    if (gradual && !opts.dissolves) continue;
    const at = gradual ? a + Math.floor(L / 2) : Math.min(N - 1, peak + 1);
    out.push({ time: times[at], detector: 'transnetv2', score: +Number(single[peak]).toFixed(3), frames: L, ...(gradual ? { gradual: true } : {}) });
  }
  return out;
}
