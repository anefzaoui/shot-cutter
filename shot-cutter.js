#!/usr/bin/env node
/**
 * shot-cutter CLI (v1.2). The detection/cutting logic lives in ./index.js (importable library).
 *
 * Shots mode (default, same as v1.0; --mode sensitive|ml|hybrid since v1.2):
 *   <out>/<name>/original.<ext>, shots/1.mp4…, <name>.json (probe, settings, boundaries, shots, stats)
 * Stale mode (--stale, new):
 *   <out>/<name>/<name>.stale.json (keep/stale ranges, levels, stats), and with --render: <name>.tight.mp4
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeVideo, detectShots, detectStale, cutSegments, renderKeep, mlAvailable, FFMPEG, FFPROBE, SHOT_DEFAULTS, STALE_DEFAULTS, MODES, MODE_DEFAULTS, VERSION } from './index.js';

const TOOL = 'shot-cutter';
const isTTY = process.stdout.isTTY;
let useColor = isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { dim: paint('2'), bold: paint('1'), green: paint('32'), yellow: paint('33'), red: paint('31'), cyan: paint('36') };
let quiet = false;
const log = (...a) => { if (!quiet) console.log(...a); };
class CliError extends Error {}
const fail = (msg) => { throw new CliError(msg); };

let lastLen = 0;
function progressLine(text) {
  if (quiet || !isTTY) return;
  if (useColor) process.stdout.write(`\r\x1b[2K${text}`); else process.stdout.write(`\r${text.padEnd(lastLen)}`);
  lastLen = Math.max(lastLen, text.length);
}
function endProgress() {
  if (quiet || !isTTY) return;
  if (useColor) process.stdout.write('\r\x1b[2K'); else process.stdout.write(`\r${' '.repeat(lastLen)}\r`);
  lastLen = 0;
}
const fmtTime = (s) => { const m = Math.floor(s / 60); return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; };
const bar = (label, total) => (f) => progressLine(`${c.cyan(label)} ${String(Math.round(f * 100)).padStart(3)}%  ${fmtTime(f * total)} / ${fmtTime(total)}`);

const HELP = `
${c.bold('shot-cutter')} v${VERSION} - split a video into shots, or find its stale (dead-air) parts

${c.bold('Usage:')}
  shot-cutter.js <video> [options]            shots mode (default)
  shot-cutter.js <video> --stale [options]    stale mode

${c.bold('Shots options:')}
  --out <dir>            Output root directory (default: current directory)
  --threshold <n>        Primary detector scene threshold 0..1 (default: ${SHOT_DEFAULTS.threshold})
  --scdet <n>            Audit detector (scdet) threshold 0..100 (default: ${SHOT_DEFAULTS.scdet})
  --min-shot <sec>       Merge shots shorter than this into a neighbor (default: ${SHOT_DEFAULTS.minShot})
  --gap <sec>            Minimum gap between boundaries (default: ${SHOT_DEFAULTS.gap})
  --tolerance <sec>      Detector agreement window (default: ${SHOT_DEFAULTS.tolerance})
  --mode <m>             Cut detection: fast (default) | sensitive | ml | hybrid
                           fast       select 'scene' + scdet (v1.0/v1.1 behavior)
                           sensitive  + adaptive detectors (spike vs rolling median of neighbours,
                                        histogram, short transitions), flash and same-set-up vetoes
                           ml         TransNetV2 via the optional Python helper (tools/)
                           hybrid     sensitive + ml, each boundary tagged with who found it
  --dissolves            (non-fast modes) also cut long dissolves, once, at the middle
  --adaptive-threshold <n>  Spike/median ratio for adaptive detectors (default: ${MODE_DEFAULTS.adaptiveThreshold})
  --min-content <n>      Adaptive content-difference floor 0..255 (default: ${MODE_DEFAULTS.minContent})
  --min-hist <n>         Adaptive histogram-difference floor 0..100 (default: ${MODE_DEFAULTS.minHist})
  --no-flash-filter      Keep reports whose old picture comes back within 0.5 s (flashes, passing bodies)
  --no-setup-filter      Keep reports where the camera set-up did not change (lightning, flicker)
  --ml-threshold <n>     TransNetV2 transition probability (default: ${MODE_DEFAULTS.mlThreshold})
  --python <path>        Python with TransNetV2 installed (default: $SHOT_CUTTER_PYTHON or python3)
  --device <d>           TransNetV2 device: cpu (default) | cuda | auto
  --ml-check             Report whether the ml helper is usable, then exit
  --crf <n>              x264 quality for cuts (default: 18)
  --preset <p>           x264 preset (default: medium)
  --strip-audio          Cut shots without audio track
  --dry-run              Detect + report + write manifest, but cut nothing
  --force                Redo everything, ignore resumable previous run

${c.bold('Stale options:')}
  --stale                Detect dead air from audio energy (adaptive to the recording level)
  --render               Also write <name>.tight.mp4 with only the kept ranges
  --threshold-db <dB>    Fixed speech threshold instead of adaptive (e.g. -45)
  --min-silence <sec>    Pauses shorter than this are kept (default: ${STALE_DEFAULTS.minSilence})
  --margin-before <sec>  Padding before speech (default: ${STALE_DEFAULTS.marginBefore})
  --margin-after <sec>   Padding after speech (default: ${STALE_DEFAULTS.marginAfter})
  --min-keep <sec>       Drop kept ranges shorter than this (default: ${STALE_DEFAULTS.minKeep})

${c.bold('Common:')}
  --json                 Print the manifest JSON to stdout when done
  --quiet                Errors only
  --no-color             Disable colored output
  --version, --help

${c.bold('Library:')} import { detectShots, detectStale, cutSegments, renderKeep } from 'shot-cutter'
`;

function parseArgs(argv) {
  const o = { input: null, out: process.cwd(), ...SHOT_DEFAULTS, mode: 'fast', modeOpts: {}, mlCheck: false, crf: 18, preset: 'medium', stripAudio: false, dryRun: false, force: false, json: false, stale: false, render: false, staleOpts: {} };
  const num = (flag, v) => { const n = Number(v); if (!Number.isFinite(n)) fail(`${flag} must be a number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i], inline = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) { inline = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    const next = () => { if (inline != null) return inline; if (i + 1 >= argv.length) fail(`${arg} requires a value`); return argv[++i]; };
    switch (arg) {
      case '--help': case '-h': console.log(HELP); process.exit(0); break;
      case '--version': case '-v': console.log(VERSION); process.exit(0); break;
      case '--out': o.out = next(); break;
      case '--threshold': o.threshold = num(arg, next()); break;
      case '--scdet': o.scdet = num(arg, next()); break;
      case '--min-shot': o.minShot = num(arg, next()); break;
      case '--gap': o.gap = num(arg, next()); break;
      case '--tolerance': o.tolerance = num(arg, next()); break;
      case '--mode': o.mode = next(); if (!MODES.includes(o.mode)) fail(`--mode must be one of ${MODES.join(', ')}`); break;
      case '--dissolves': o.modeOpts.dissolves = true; break;
      case '--adaptive-threshold': o.modeOpts.adaptiveThreshold = num(arg, next()); break;
      case '--min-content': o.modeOpts.minContent = num(arg, next()); break;
      case '--min-hist': o.modeOpts.minHist = num(arg, next()); break;
      case '--no-flash-filter': o.modeOpts.flashFilter = false; break;
      case '--no-setup-filter': o.modeOpts.setupFilter = false; break;
      case '--ml-threshold': o.modeOpts.mlThreshold = num(arg, next()); break;
      case '--python': o.python = next(); break;
      case '--device': o.modeOpts.device = next(); break;
      case '--ml-check': o.mlCheck = true; break;
      case '--crf': o.crf = num(arg, next()); break;
      case '--preset': o.preset = next(); break;
      case '--strip-audio': o.stripAudio = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--force': o.force = true; break;
      case '--json': o.json = true; break;
      case '--quiet': quiet = true; break;
      case '--no-color': useColor = false; break;
      case '--stale': o.stale = true; break;
      case '--render': o.render = true; break;
      case '--threshold-db': o.staleOpts.thresholdDb = num(arg, next()); break;
      case '--min-silence': o.staleOpts.minSilence = num(arg, next()); break;
      case '--margin-before': o.staleOpts.marginBefore = num(arg, next()); break;
      case '--margin-after': o.staleOpts.marginAfter = num(arg, next()); break;
      case '--min-keep': o.staleOpts.minKeep = num(arg, next()); break;
      default:
        if (arg.startsWith('-')) fail(`unknown option ${arg}\n${HELP}`);
        if (o.input) fail('only one input video is accepted per run');
        o.input = arg;
    }
  }
  if (!o.input && !o.mlCheck) { console.log(HELP); process.exit(2); }
  for (const k of ['threshold', 'scdet', 'minShot', 'gap', 'tolerance', 'crf']) if (o[k] < 0) fail(`--${k} must be non-negative`);
  return o;
}

function preflight() {
  for (const bin of [FFMPEG, FFPROBE]) {
    try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); } catch { fail(`${bin} not found. Install ffmpeg or set FFMPEG_PATH/FFPROBE_PATH`); }
  }
}

const fingerprint = (f) => { const st = fs.statSync(f); return { sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs) }; };
function writeJsonAtomic(file, data) { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file); }
// fast mode keeps the v1.1 settings object exactly (so earlier manifests still resume); other modes add theirs
const shotSettings = (o) => ({
  threshold: o.threshold, scdet: o.scdet, minShot: o.minShot, gap: o.gap, tolerance: o.tolerance, crf: o.crf, preset: o.preset, stripAudio: o.stripAudio,
  ...(o.mode && o.mode !== 'fast' ? { mode: o.mode, ...o.modeOpts } : {}),
});

async function staleMode(o, input, probe, outDir, name) {
  const r = await detectStale(input, { ...o.staleOpts, duration: probe.duration }, { onProgress: bar('analyzing', probe.duration) });
  endProgress();
  log(`${c.cyan('levels  ')} floor ${r.levels.noiseFloorDb} dB · speech ${r.levels.speechDb} dB → threshold ${r.levels.thresholdDb} dB`);
  log(`${c.bold('stale   ')} keep ${r.stats.segments} ranges, ${r.stats.keptSeconds}s of ${r.stats.sourceSeconds}s (${Math.round(r.stats.keptRatio * 100)}%) · removed ${r.stats.removedSeconds}s`);
  const { envelope, ...rest } = r;
  const manifest = { tool: TOOL, mode: 'stale', version: VERSION, createdAt: new Date().toISOString(), source: { path: input, fingerprint: fingerprint(input), probe }, ...rest };
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${name}.stale.json`);
  writeJsonAtomic(file, manifest);
  log(`${c.dim('manifest')} ${file}`);
  if (o.render) {
    const out = path.join(outDir, `${name}.tight.mp4`);
    await renderKeep(input, r.keep, out, { crf: o.crf, preset: o.preset, hasAudio: probe.hasAudio, onProgress: bar('render  ', r.stats.keptSeconds) });
    endProgress();
    log(`${c.green('render  ')} ${out}`);
  }
  return manifest;
}

// v1.1 fields; non-fast modes add per-detector `scores` and, in hybrid, `agreement` (both | sensitive | ml)
const boundaryOut = (b) => ({
  time: +b.time.toFixed(3), detectors: b.detectors, consensus: b.consensus, score: b.score,
  ...(b.scores ? { scores: b.scores } : {}), ...(b.agreement ? { agreement: b.agreement } : {}),
});

async function shotsMode(o, input, probe, outDir, name) {
  const shotsDir = path.join(outDir, 'shots');
  const manifestFile = path.join(outDir, `${name}.json`);
  const originalFile = path.join(outDir, `original${path.extname(input)}`);
  const srcFp = fingerprint(input);
  let previous = null;
  if (!o.force && fs.existsSync(manifestFile)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (m.tool === TOOL && JSON.stringify(m.source?.fingerprint) === JSON.stringify(srcFp) && JSON.stringify(m.settings) === JSON.stringify(shotSettings(o))) {
        previous = m;
        log(`${c.yellow('resume  ')} matching previous run found, reusing detection`);
      } else log(`${c.yellow('note    ')} previous manifest differs (source or settings changed), re-detecting`);
    } catch { /* corrupt manifest: re-detect */ }
  }
  let boundaries, shots, mergeCount = 0, detection;
  if (previous) {
    ({ boundaries } = previous);
    shots = previous.shots.map((s) => ({ start: s.start, end: s.end, duration: s.duration, openedBy: s.openedBy }));
    detection = previous.detection;
  } else {
    const d = await detectShots(input, { ...shotSettings(o), duration: probe.duration, probe, ...(o.python ? { python: o.python } : {}) }, { onProgress: bar('detecting', probe.duration) });
    endProgress();
    ({ boundaries, shots, mergeCount } = d);
    detection = { primaryCandidates: d.primaryCount, auditCandidates: d.auditCount, elapsedMs: d.elapsedMs };
    if (d.mode) {
      Object.assign(detection, { mode: d.mode, adaptiveCandidates: d.adaptiveCount, mlCandidates: d.mlCount, frames: d.frames, timings: d.timings, vetoed: d.vetoed });
      if (d.ml) detection.ml = d.ml;
      if (d.analysis) detection.analysis = d.analysis;
    }
    const extra = d.mode ? ` + ${d.adaptiveCount} adaptive + ${d.mlCount} ml${d.vetoed?.length ? `, ${d.vetoed.length} vetoed` : ''}` : '';
    log(`${c.cyan('detect  ')} ${d.mode ? `[${d.mode}] ` : ''}${d.primaryCount} primary + ${d.auditCount} audit${extra} candidates → ${boundaries.length} boundaries (${(d.elapsedMs / 1000).toFixed(1)}s)`);
  }
  if (mergeCount) log(`${c.yellow('merge   ')} ${mergeCount} shot(s) shorter than ${o.minShot}s merged into neighbors`);
  const consensus = boundaries.filter((b) => b.consensus).length;
  log(`${c.bold('shots   ')} ${shots.length} shots · ${consensus}/${boundaries.length} boundaries confirmed by ${o.mode && o.mode !== 'fast' ? 'two or more' : 'both'} detectors`);

  fs.mkdirSync(shotsDir, { recursive: true });
  if (!o.dryRun && (!fs.existsSync(originalFile) || o.force || fingerprint(originalFile).sizeBytes !== srcFp.sizeBytes)) {
    fs.copyFileSync(input, originalFile);
    log(`${c.dim('copy    ')} original${path.extname(input)}`);
  }

  const started = Date.now();
  const files = shots.map((_, i) => path.join(shotsDir, `${i + 1}.mp4`));
  const allPresent = files.every((f) => fs.existsSync(f) && fs.statSync(f).size > 0);
  let status = 'dry-run';
  if (!o.dryRun) {
    if (previous && allPresent && !o.force) status = 'kept';
    else {
      await cutSegments(input, shots.slice(1).map((s) => s.start), shotsDir, { crf: o.crf, preset: o.preset, stripAudio: o.stripAudio, duration: probe.duration, fps: probe.fps, onProgress: bar('cutting  ', probe.duration) });
      endProgress();
      status = 'cut';
    }
  }
  const results = [];
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const entry = {
      index: i + 1, file: `shots/${i + 1}.mp4`, start: +s.start.toFixed(3), end: +s.end.toFixed(3), duration: +s.duration.toFixed(3),
      openedBy: s.openedBy ? boundaryOut(s.openedBy) : null,
      cutStatus: status,
    };
    if (status !== 'dry-run' && fs.existsSync(files[i])) {
      const actual = await probeVideo(files[i]);
      entry.actualDuration = +actual.duration.toFixed(3);
      entry.sizeBytes = fs.statSync(files[i]).size;
      if (Math.abs(actual.duration - s.duration) > 0.25) log(`${c.yellow('warn    ')} shot ${i + 1}: ${actual.duration.toFixed(2)}s vs planned ${s.duration.toFixed(2)}s`);
    }
    if (o.dryRun) log(`  ${c.dim(String(i + 1).padStart(3))}  ${fmtTime(s.start)} → ${fmtTime(s.end)}  ${c.dim(`${s.duration.toFixed(2)}s`)}`);
    results.push(entry);
  }
  const manifest = {
    tool: TOOL, version: VERSION, createdAt: new Date().toISOString(),
    source: { path: input, file: `original${path.extname(input)}`, fingerprint: srcFp, probe },
    settings: shotSettings(o), detection,
    boundaries: boundaries.map(boundaryOut),
    shots: results,
    stats: {
      shotCount: shots.length, mergedShortShots: mergeCount, consensusBoundaries: consensus,
      totalShotSeconds: +shots.reduce((t, x) => t + x.duration, 0).toFixed(3), sourceSeconds: +probe.duration.toFixed(3),
      averageShotSeconds: +(shots.reduce((t, x) => t + x.duration, 0) / shots.length).toFixed(3),
      dryRun: o.dryRun, cutWallMs: o.dryRun ? 0 : Date.now() - started,
    },
  };
  writeJsonAtomic(manifestFile, manifest);
  log(o.dryRun ? `\n${c.bold('dry run complete')}. No cuts made. Manifest: ${manifestFile}` : `${c.green('done    ')} ${status} · ${((Date.now() - started) / 1000).toFixed(1)}s · manifest ${manifestFile}`);
  return manifest;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  preflight();
  if (o.mlCheck) {
    const r = await mlAvailable({ python: o.python });
    if (r.ok) { log(`${c.green('ml      ')} ${r.backend} on ${r.device} (${r.python})`); return; }
    fail(r.error);
  }
  if (!o.stale && (o.mode === 'ml' || o.mode === 'hybrid')) {
    const r = await mlAvailable({ python: o.python });
    if (!r.ok) fail(r.error);
  }
  const input = path.resolve(o.input);
  if (!fs.existsSync(input)) fail(`input not found: ${input}`);
  const name = path.basename(input, path.extname(input));
  const outDir = path.resolve(o.out, name);
  log(`${c.bold(TOOL)} v${VERSION}`);
  log(`${c.dim('input   ')} ${input}`);
  const probe = await probeVideo(input);
  log(`${c.dim('source  ')} ${probe.width ?? '-'}x${probe.height ?? '-'} @ ${probe.fps?.toFixed(2) ?? '-'}fps · ${fmtTime(probe.duration)} · ${probe.videoCodec ?? 'audio'}${probe.audioCodec ? `+${probe.audioCodec}` : ' (no audio)'}`);
  if (o.stale && !probe.hasAudio) fail('--stale needs an audio track');
  if (!o.stale && !probe.hasVideo) fail('no video stream found');
  const manifest = o.stale ? await staleMode(o, input, probe, outDir, name) : await shotsMode(o, input, probe, outDir, name);
  if (o.json) console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  endProgress();
  console.error(c.red('error: ') + err.message);
  process.exit(err instanceof CliError ? 2 : 1);
});
