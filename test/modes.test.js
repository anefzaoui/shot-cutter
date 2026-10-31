// Cut modes on synthetic clips made by ffmpeg lavfi (generated into a temp dir). Run: npm test
//   hard      testsrc2 → cellauto, hard cut at 3 s
//   low       two near-identical teal shots (same palette, shape moved, sensor noise), cut at 3 s
//   dissolve  testsrc2 → cellauto, 1 s cross-fade from 2 s to 3 s
//   pan       a fast pan (28 px/frame on a 180 px frame) over one still image, 1 s → 2.5 s
//   flash     one shot with a 2-frame white flash at 2 s
// The ml/hybrid plumbing runs against a stub runner (node script standing in for Python), so these tests need no
// TransNetV2. With SHOT_CUTTER_PYTHON pointing at a Python that has it, the real-model tests run too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  run, FFMPEG, probeVideo, detectShots, detectShotsFromLog, sensitiveArgs, reconcileBoundaries, mlCandidates, mlAvailable,
  MlUnavailableError, MODES,
} from '../index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// checked before any test is registered (a later top-level await would register tests after the cleanup hook ran)
const realMl = await mlAvailable();
let dir; const clip = {};
const near = (bs, t, tol = 0.1) => bs.some((b) => Math.abs(b.time - t) <= tol);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-cutter-modes-'));
  const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-y', '-loglevel', 'error'];
  const A = 'testsrc2=s=180x320:r=25:d=3,format=yuv420p', B = 'cellauto=s=180x320:r=25:rule=18,trim=duration=3,format=yuv420p,settb=1/25';
  const make = (name, args) => { clip[name] = path.join(dir, `${name}.mp4`); return run(FFMPEG, [...args, ...enc, clip[name]]); };
  await Promise.all([
    // (trim/format/settb inside the lavfi inputs: ffmpeg 7.0 loses cellauto's frame rate after trim in a filtergraph)
    make('hard', ['-f', 'lavfi', '-i', A, '-f', 'lavfi', '-i', B, '-filter_complex', '[0]settb=1/25[a];[a][1]concat=n=2:v=1:a=0']),
    make('low', ['-f', 'lavfi', '-i', 'color=c=0x2a6670:s=180x320:r=25:d=3', '-f', 'lavfi', '-i', 'color=c=0x2c6a74:s=180x320:r=25:d=3',
      '-filter_complex', "[0]drawbox=x='20+t*6':y=100:w=60:h=140:color=0x1d4a52:t=fill,noise=alls=4:allf=t[a];"
        + "[1]drawbox=x='110-t*6':y=120:w=55:h=150:color=0x1f4e57:t=fill,noise=alls=4:allf=t[b];[a][b]concat=n=2:v=1:a=0"]),
    make('dissolve', ['-f', 'lavfi', '-i', A, '-f', 'lavfi', '-i', B, '-filter_complex', '[0]settb=1/25[a];[a][1]xfade=transition=fade:duration=1:offset=2']),
    make('flash', ['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=25:d=4',
      '-vf', "drawbox=enable='between(n,50,51)':x=0:y=0:w=iw:h=ih:color=white:t=fill"]),
    (async () => {
      const still = path.join(dir, 'big.png');
      await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1200x320:r=1:d=1', '-frames:v', '1', '-update', '1', still]);
      await make('pan', ['-loop', '1', '-framerate', '25', '-t', '4', '-i', still, '-vf', "crop=180:320:x='clip((t-1)*700,0,1020)':y=0"]);
    })(),
  ]);
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('MODES lists the four modes; unknown modes are rejected', async () => {
  assert.deepEqual(MODES, ['fast', 'sensitive', 'ml', 'hybrid']);
  await assert.rejects(detectShots(clip.hard, { mode: 'nope' }), /unknown mode/);
});

test('fast (default) keeps v1.1 behavior: hard cut found, low-contrast cut missed, boundaries without new fields', async () => {
  const hard = await detectShots(clip.hard);
  assert.equal(hard.boundaries.length, 1);
  assert.ok(near(hard.boundaries, 3));
  assert.deepEqual(Object.keys(hard.boundaries[0]).sort(), ['consensus', 'detectors', 'score', 'time']);
  assert.equal(hard.mode, undefined);
  assert.equal((await detectShots(clip.low, { mode: 'fast' })).boundaries.length, 0);
});

test('sensitive: hard cut found by several detectors, with per-detector scores', async () => {
  const r = await detectShots(clip.hard, { mode: 'sensitive' });
  assert.equal(r.mode, 'sensitive');
  assert.equal(r.boundaries.length, 1, JSON.stringify(r.boundaries));
  const b = r.boundaries[0];
  assert.ok(Math.abs(b.time - 3) < 0.05);
  assert.ok(b.detectors.includes('select-scene') && b.detectors.some((d) => d.startsWith('adaptive-')));
  assert.equal(b.consensus, true);
  for (const d of b.detectors) assert.equal(typeof b.scores[d], 'number', d);
  assert.equal(r.frames, 150);
});

test('sensitive: low-contrast cut between near-identical shots is found', async () => {
  const r = await detectShots(clip.low, { mode: 'sensitive' });
  assert.equal(r.boundaries.length, 1, JSON.stringify(r.boundaries));
  assert.ok(near(r.boundaries, 3, 0.05));
});

test('sensitive: a dissolve is not split mid-way, unless dissolves:true (then once, near its middle)', async () => {
  assert.equal((await detectShots(clip.dissolve, { mode: 'sensitive' })).boundaries.length, 0);
  const r = await detectShots(clip.dissolve, { mode: 'sensitive', dissolves: true });
  assert.equal(r.boundaries.length, 1, JSON.stringify(r.boundaries));
  assert.ok(r.boundaries[0].time > 2.3 && r.boundaries[0].time < 2.7, String(r.boundaries[0].time));
  assert.deepEqual(r.boundaries[0].detectors, ['dissolve']);
});

test('sensitive: a fast pan is not split (also with dissolves:true)', async () => {
  assert.equal((await detectShots(clip.pan, { mode: 'fast' })).boundaries.length, 0);
  assert.equal((await detectShots(clip.pan, { mode: 'sensitive' })).boundaries.length, 0);
  assert.equal((await detectShots(clip.pan, { mode: 'sensitive', dissolves: true })).boundaries.length, 0);
});

test('sensitive: a white flash inside a shot is vetoed (fast mode cuts there)', async () => {
  assert.ok(near((await detectShots(clip.flash)).boundaries, 2));
  const r = await detectShots(clip.flash, { mode: 'sensitive' });
  assert.equal(r.boundaries.length, 0, JSON.stringify(r.boundaries));
  assert.ok(r.vetoed.length >= 1 && r.vetoed.every((v) => v.reason === 'returned'));
  // the same-set-up check alone also rejects it (edges before and after the flash correlate)
  const setupOnly = await detectShots(clip.flash, { mode: 'sensitive', flashFilter: false });
  assert.equal(setupOnly.boundaries.length, 0);
  assert.ok(setupOnly.vetoed.every((v) => v.reason === 'same-setup'));
  const kept = await detectShots(clip.flash, { mode: 'sensitive', flashFilter: false, setupFilter: false });
  assert.ok(near(kept.boundaries, 2));
});

test('sensitiveArgs + detectShotsFromLog (ffmpeg run elsewhere) give the same result as detectShots', async () => {
  for (const name of ['hard', 'low', 'flash']) {
    const probe = await probeVideo(clip[name]);
    const rawFile = path.join(dir, `${name}.rgb`), lines = [];
    await run(FFMPEG, sensitiveArgs(clip[name], probe, {}, rawFile), { onLine: (l) => lines.push(l) });
    const viaLog = await detectShotsFromLog({ log: lines.join('\n'), raw: fs.readFileSync(rawFile), probe });
    const direct = await detectShots(clip[name], { mode: 'sensitive' });
    assert.deepEqual(viaLog.boundaries, direct.boundaries, name);
    assert.deepEqual(viaLog.vetoed, direct.vetoed, name);
  }
});

test('min-shot and gap rules still apply in sensitive mode', async () => {
  const r = await detectShots(clip.hard, { mode: 'sensitive', minShot: 3.5 });
  assert.equal(r.shots.length, 1);
  assert.equal(r.mergeCount, 1);
});

test('reconcileBoundaries: prefer + withScores are opt-in; default output unchanged', () => {
  const c = [{ time: 1.04, detector: 'adaptive-content', score: 9 }, { time: 1.0, detector: 'scdet', score: 30 }, { time: 1.08, detector: 'transnetv2', score: 0.9 }];
  const plain = reconcileBoundaries(c, 10, { tolerance: 0.12, gap: 0.12 });
  assert.deepEqual(plain, [{ time: 1.0, detectors: ['adaptive-content', 'scdet', 'transnetv2'], consensus: true, score: 30 }]);
  const pref = reconcileBoundaries(c, 10, { tolerance: 0.12, gap: 0.12, prefer: ['adaptive-content', 'scdet'], withScores: true });
  assert.equal(pref[0].time, 1.04);
  assert.deepEqual(pref[0].scores, { 'adaptive-content': 9, scdet: 30, transnetv2: 0.9 });
});

test('mlCandidates: cut on the frame after the peak; long transitions (many-hot) only with dissolves', () => {
  const times = Array.from({ length: 150 }, (_, i) => i / 25);
  const single = new Array(150).fill(0.001), many = new Array(150).fill(0.001);
  single[74] = 0.99; many[74] = 0.97;                         // hard cut at frame 75
  single[110] = 0.8; for (let i = 100; i <= 124; i++) many[i] = 0.9; // 25-frame dissolve
  assert.deepEqual(mlCandidates({ single, many, times }, 25).map((c) => c.time), [3]);
  const withD = mlCandidates({ single, many, times }, 25, { dissolves: true });
  assert.equal(withD.length, 2);
  assert.ok(withD[1].gradual && Math.abs(withD[1].time - 112 / 25) < 1e-9);
});

// ---- ml / hybrid through a stub runner (node stands in for python) ----
function stubRunner(exitCode = 0) {
  const file = path.join(dir, `stub-runner-${exitCode}.mjs`);
  fs.writeFileSync(file, `
const args = process.argv.slice(2);
if (${exitCode}) { console.error('TransNetV2 is not installed (stub)'); process.exit(${exitCode}); }
if (args[0] === '--check') { console.log(JSON.stringify({ ok: true, backend: 'stub', device: 'cpu' })); process.exit(0); }
const name = args[0].split(/[\\\\/]/).pop();
const n = 150, times = Array.from({ length: n }, (_, i) => i / 25);
const single = new Array(n).fill(0.001), many = new Array(n).fill(0.001);
if (name === 'hard.mp4') { single[74] = 0.99; many[74] = 0.98; }
if (name === 'dissolve.mp4') { single[62] = 0.72; single[63] = 0.87; for (let i = 52; i <= 74; i++) many[i] = 0.95; }
process.stdout.write(JSON.stringify({ backend: 'stub', device: 'cpu', frames: n, times, single, many, elapsedMs: 1 }));
`);
  return { python: process.execPath, mlRunner: file };
}

test('ml (stub runner): hard cut at 3 s, dissolve not split unless asked', async () => {
  const s = stubRunner();
  const hard = await detectShots(clip.hard, { mode: 'ml', ...s });
  assert.equal(hard.boundaries.length, 1);
  assert.ok(Math.abs(hard.boundaries[0].time - 3) < 1e-6);
  assert.deepEqual(hard.boundaries[0].detectors, ['transnetv2']);
  assert.deepEqual(hard.ml, { backend: 'stub', device: 'cpu' });
  assert.equal((await detectShots(clip.dissolve, { mode: 'ml', ...s })).boundaries.length, 0);
  assert.equal((await detectShots(clip.dissolve, { mode: 'ml', dissolves: true, ...s })).boundaries.length, 1);
});

test('hybrid (stub runner): union with per-boundary agreement', async () => {
  const s = stubRunner();
  const hard = await detectShots(clip.hard, { mode: 'hybrid', ...s });
  assert.equal(hard.boundaries.length, 1);
  assert.equal(hard.boundaries[0].agreement, 'both');
  assert.ok(hard.boundaries[0].detectors.includes('transnetv2') && hard.boundaries[0].detectors.includes('select-scene'));
  const low = await detectShots(clip.low, { mode: 'hybrid', ...s });
  assert.equal(low.boundaries.length, 1);
  assert.equal(low.boundaries[0].agreement, 'sensitive');
});

test('ml without the helper fails with a clear MlUnavailableError (missing python, or package not installed)', async () => {
  await assert.rejects(detectShots(clip.hard, { mode: 'ml', python: path.join(dir, 'no-such-python') }),
    (e) => e instanceof MlUnavailableError && e.code === 'ML_UNAVAILABLE' && /pip install transnetv2-pytorch/.test(e.message));
  await assert.rejects(detectShots(clip.hard, { mode: 'hybrid', ...stubRunner(3) }), (e) => e instanceof MlUnavailableError && /not installed/.test(e.message));
  const a = await mlAvailable({ python: path.join(dir, 'no-such-python') });
  assert.equal(a.ok, false);
});

test('CLI: fast manifest settings keep the v1.1 shape; --mode adds mode and per-detector scores', () => {
  const out = path.join(dir, 'cli');
  const cli = (...a) => execFileSync(process.execPath, [path.join(ROOT, 'shot-cutter.js'), ...a, '--dry-run', '--quiet', '--out', out]);
  cli(clip.hard);
  const fast = JSON.parse(fs.readFileSync(path.join(out, 'hard', 'hard.json'), 'utf8'));
  assert.deepEqual(Object.keys(fast.settings), ['threshold', 'scdet', 'minShot', 'gap', 'tolerance', 'crf', 'preset', 'stripAudio']);
  cli(clip.low, '--mode', 'sensitive');
  const sens = JSON.parse(fs.readFileSync(path.join(out, 'low', 'low.json'), 'utf8'));
  assert.equal(sens.settings.mode, 'sensitive');
  assert.equal(sens.detection.mode, 'sensitive');
  assert.equal(sens.boundaries.length, 1);
  assert.equal(typeof sens.boundaries[0].scores, 'object');
});

// ---- the real model, only where it is installed ----
test('ml (real TransNetV2): hard cut found, dissolve and pan not split', { skip: realMl.ok ? false : 'TransNetV2 helper not installed (set SHOT_CUTTER_PYTHON)' }, async () => {
  const hard = await detectShots(clip.hard, { mode: 'ml' });
  assert.ok(near(hard.boundaries, 3, 0.05), JSON.stringify(hard.boundaries));
  assert.equal((await detectShots(clip.dissolve, { mode: 'ml' })).boundaries.length, 0);
  assert.equal((await detectShots(clip.pan, { mode: 'ml' })).boundaries.length, 0);
  const hy = await detectShots(clip.flash, { mode: 'hybrid' });
  assert.equal(hy.boundaries.length, 0, JSON.stringify(hy.boundaries));
});
