#!/usr/bin/env node
/**
 * shot-cutter: standalone shot-boundary video splitter
 *
 * Detects shot boundaries in a video using two independent ffmpeg detectors
 * (`select='gt(scene,t)'` and `scdet`), reconciles them into consensus
 * boundaries, and cuts the video into frame-accurate per-shot files.
 *
 * For an input `showxepx.mp4` it produces:
 *   <out>/showxepx/original.mp4     copy of the source
 *   <out>/showxepx/shots/1.mp4 ...  one file per shot
 *   <out>/showxepx/showxepx.json    manifest: probe, settings, boundaries,
 *                                   per-shot timing + detection evidence
 *
 * Requirements: Node.js >= 20, ffmpeg + ffprobe on PATH (or FFMPEG_PATH /
 * FFPROBE_PATH env vars). No npm dependencies.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = '1.0.0';
const TOOL = 'shot-cutter';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// ---------- terminal helpers ----------

const isTTY = process.stdout.isTTY;
let useColor = isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  dim: paint('2'), bold: paint('1'), green: paint('32'), yellow: paint('33'),
  red: paint('31'), cyan: paint('36'), magenta: paint('35'),
};

let quiet = false;
const log = (...a) => { if (!quiet) console.log(...a); };
const die = (msg, code = 2) => { console.error(c.red(`error: `) + msg); process.exit(code); };

// ANSI erase-line when colors are on; plain \r with padding otherwise, so
// legacy consoles without VT support (old Windows cmd.exe) degrade cleanly.
let lastProgressLen = 0;
function progressLine(text) {
  if (quiet || !isTTY) return;
  if (useColor) process.stdout.write(`\r\x1b[2K${text}`);
  else process.stdout.write('\r' + text.padEnd(lastProgressLen));
  lastProgressLen = Math.max(lastProgressLen, text.length);
}
function endProgress() {
  if (quiet || !isTTY) return;
  if (useColor) process.stdout.write('\r\x1b[2K');
  else process.stdout.write('\r' + ' '.repeat(lastProgressLen) + '\r');
  lastProgressLen = 0;
}

const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};

// ---------- CLI ----------

const HELP = `
${c.bold('shot-cutter')} v${VERSION} - split a video into its shots on detected boundaries

${c.bold('Usage:')}
  shot-cutter.js <video> [options]

${c.bold('Output:')} <out>/<basename>/{original.mp4, shots/1.mp4..., <basename>.json}

${c.bold('Options:')}
  --out <dir>         Output root directory (default: current directory)
  --threshold <n>     Primary detector scene threshold 0..1 (default: 0.3)
  --scdet <n>         Audit detector (scdet) threshold 0..100 (default: 10)
  --min-shot <sec>    Merge shots shorter than this into a neighbor (default: 0.5)
  --gap <sec>         Minimum gap between boundaries (default: 0.12)
  --tolerance <sec>   Detector agreement window (default: 0.06)
  --crf <n>           x264 quality for cuts (default: 18)
  --preset <p>        x264 preset (default: medium)
  --strip-audio       Cut shots without audio track
  --dry-run           Detect + report + write manifest, but cut nothing
  --force             Redo everything, ignore resumable previous run
  --json              Print the manifest JSON to stdout when done
  --quiet             Errors only
  --no-color          Disable colored output
  --version, --help

${c.bold('Resume:')} rerunning on the same source skips shots already cut
(verified by manifest fingerprint + file presence); use --force to redo.
`;

function parseArgs(argv) {
  const opts = {
    input: null, out: process.cwd(), threshold: 0.3, scdet: 10, minShot: 0.5,
    gap: 0.12, tolerance: 0.06, crf: 18, preset: 'medium', stripAudio: false,
    dryRun: false, force: false, json: false,
  };
  const takesValue = new Set(['--out', '--threshold', '--scdet', '--min-shot', '--gap', '--tolerance', '--crf', '--preset']);
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inlineVal = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) { inlineVal = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    const next = () => {
      if (inlineVal != null) return inlineVal;
      if (i + 1 >= argv.length) die(`${arg} requires a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--help': case '-h': console.log(HELP); process.exit(0); break;
      case '--version': case '-v': console.log(VERSION); process.exit(0); break;
      case '--out': opts.out = next(); break;
      case '--threshold': opts.threshold = Number(next()); break;
      case '--scdet': opts.scdet = Number(next()); break;
      case '--min-shot': opts.minShot = Number(next()); break;
      case '--gap': opts.gap = Number(next()); break;
      case '--tolerance': opts.tolerance = Number(next()); break;
      case '--crf': opts.crf = Number(next()); break;
      case '--preset': opts.preset = next(); break;
      case '--strip-audio': opts.stripAudio = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--force': opts.force = true; break;
      case '--json': opts.json = true; break;
      case '--quiet': quiet = true; break;
      case '--no-color': useColor = false; break;
      default:
        if (arg.startsWith('-')) die(`unknown option ${arg}\n${HELP}`);
        if (opts.input) die('only one input video is accepted per run');
        opts.input = arg;
    }
  }
  if (!opts.input) { console.log(HELP); process.exit(2); }
  for (const [k, v] of Object.entries({ threshold: opts.threshold, scdet: opts.scdet, 'min-shot': opts.minShot, gap: opts.gap, tolerance: opts.tolerance, crf: opts.crf })) {
    if (!Number.isFinite(v) || v < 0) die(`--${k} must be a non-negative number`);
  }
  return opts;
}

// ---------- external tools ----------

function preflight() {
  for (const bin of [FFMPEG, FFPROBE]) {
    try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); }
    catch { die(`${bin} not found. Install ffmpeg or set FFMPEG_PATH/FFPROBE_PATH`); }
  }
}

function run(bin, args, { onStderr, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '';
    child.stderr.on('data', (d) => {
      const s = d.toString();
      if (stderr.length < 64 * 1024 * 1024) stderr += s;
      onStderr?.(s);
    });
    child.stdout.on('data', (d) => { stdout += d.toString(); onStdout?.(d.toString()); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.split('\n').filter(Boolean).slice(-4).join(' | ')}`));
    });
  });
}

async function probeVideo(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ]);
  const data = JSON.parse(stdout);
  const v = (data.streams || []).find((s) => s.codec_type === 'video');
  const a = (data.streams || []).find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('no video stream found');
  const [num, den] = String(v.r_frame_rate || '0/1').split('/').map(Number);
  return {
    duration: Number(data.format?.duration) || Number(v.duration) || 0,
    width: v.width, height: v.height,
    fps: den ? num / den : null,
    videoCodec: v.codec_name, audioCodec: a?.codec_name || null,
    sizeBytes: Number(data.format?.size) || null,
  };
}

// ---------- detection ----------

function parsePrimaryCandidates(stderr) {
  // frames passing select='gt(scene,t)' are reported by showinfo
  const out = [];
  const re = /Parsed_showinfo_\S*.*?pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g;
  for (const m of stderr.matchAll(re)) out.push({ time: Number(m[1]), detector: 'select-scene' });
  return out;
}

function parseScdetCandidates(stderr) {
  const out = [];
  const re = /lavfi\.scd\.score:\s*([0-9]+(?:\.[0-9]+)?),\s*lavfi\.scd\.time:\s*([0-9]+(?:\.[0-9]+)?)/g;
  for (const m of stderr.matchAll(re)) out.push({ time: Number(m[2]), detector: 'scdet', score: Number(m[1]) });
  return out;
}

/** Cluster near-identical detector reports into consensus boundaries. */
function reconcileBoundaries(candidates, duration, { tolerance, gap }) {
  const sorted = [...candidates].sort((x, y) => x.time - y.time);
  const clusters = [];
  for (const cand of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && cand.time - last.reports[last.reports.length - 1].time <= tolerance) {
      last.reports.push(cand);
    } else {
      clusters.push({ reports: [cand] });
    }
  }
  const boundaries = [];
  for (const cl of clusters) {
    const detectors = [...new Set(cl.reports.map((r) => r.detector))].sort();
    // prefer the frame-accurate primary detector's timestamp when present
    const primary = cl.reports.find((r) => r.detector === 'select-scene');
    const time = primary ? primary.time : cl.reports[0].time;
    const score = cl.reports.find((r) => r.score != null)?.score ?? null;
    if (time <= gap || time >= duration - gap) continue;
    const prev = boundaries[boundaries.length - 1];
    if (prev && time - prev.time < gap) continue;
    boundaries.push({ time, detectors, consensus: detectors.length > 1, score });
  }
  return boundaries;
}

function buildShots(boundaries, duration) {
  const times = [0, ...boundaries.map((b) => b.time), duration];
  const shots = [];
  for (let i = 0; i < times.length - 1; i++) {
    shots.push({
      start: times[i], end: times[i + 1], duration: times[i + 1] - times[i],
      openedBy: i === 0 ? null : boundaries[i - 1],
    });
  }
  return shots;
}

/** Merge shots shorter than minShot into a neighbor (previous preferred). */
function mergeShortShots(shots, minShot) {
  const merged = [...shots];
  let mergeCount = 0;
  let idx;
  while (merged.length > 1 && (idx = merged.findIndex((s) => s.duration < minShot)) !== -1) {
    const short = merged[idx];
    if (idx > 0) {
      merged[idx - 1] = { ...merged[idx - 1], end: short.end, duration: short.end - merged[idx - 1].start };
    } else {
      merged[1] = { ...merged[1], start: short.start, duration: merged[1].end - short.start, openedBy: null };
    }
    merged.splice(idx, 1);
    mergeCount++;
  }
  return { shots: merged, mergeCount };
}

async function detectShots(file, probe, opts) {
  const filter =
    `[0:v]split=2[primary-in][audit-in];` +
    `[primary-in]select='gt(scene,${opts.threshold})',showinfo[primary];` +
    `[audit-in]scdet=t=${opts.scdet}:s=1[audit]`;
  let collected = '';
  const started = Date.now();
  await run(FFMPEG, [
    '-hide_banner', '-nostats', '-i', file,
    '-filter_complex', filter,
    '-map', '[primary]', '-map', '[audit]',
    '-an', '-f', 'null', '-progress', 'pipe:1', '-',
  ], {
    onStderr: (s) => { collected += s; },
    onStdout: (s) => {
      const m = s.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m && probe.duration) {
        const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        const pct = Math.min(100, (t / probe.duration) * 100);
        progressLine(`${c.cyan('detecting')} ${pct.toFixed(0).padStart(3)}%  ${fmtTime(t)} / ${fmtTime(probe.duration)}`);
      }
    },
  });
  endProgress();
  const primary = parsePrimaryCandidates(collected);
  const audit = parseScdetCandidates(collected);
  const boundaries = reconcileBoundaries([...primary, ...audit], probe.duration, opts);
  return {
    boundaries, primaryCount: primary.length, auditCount: audit.length,
    elapsedMs: Date.now() - started,
  };
}

// ---------- cutting ----------

async function cutShot(source, outFile, shot, opts) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    // -ss before -i: fast keyframe seek, then ffmpeg decodes forward and
    // discards to the exact time; frame-accurate because we re-encode.
    '-ss', shot.start.toFixed(3), '-i', source,
    '-t', shot.duration.toFixed(3),
    '-c:v', 'libx264', '-preset', opts.preset, '-crf', String(opts.crf),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ];
  if (opts.stripAudio) args.push('-an');
  else args.push('-c:a', 'aac', '-b:a', '192k');
  args.push(outFile);
  await run(FFMPEG, args);
}

// ---------- manifest ----------

function fingerprint(file) {
  const st = fs.statSync(file);
  return { sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs) };
}

function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function settingsOf(opts) {
  const { threshold, scdet, minShot, gap, tolerance, crf, preset, stripAudio } = opts;
  return { threshold, scdet, minShot, gap, tolerance, crf, preset, stripAudio };
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  preflight();

  const input = path.resolve(opts.input);
  if (!fs.existsSync(input)) die(`input not found: ${input}`);
  const name = path.basename(input, path.extname(input));
  const outDir = path.resolve(opts.out, name);
  const shotsDir = path.join(outDir, 'shots');
  const manifestFile = path.join(outDir, `${name}.json`);
  const originalFile = path.join(outDir, 'original' + path.extname(input));

  log(`${c.bold(TOOL)} v${VERSION}`);
  log(`${c.dim('input   ')} ${input}`);
  log(`${c.dim('output  ')} ${outDir}`);

  const probe = await probeVideo(input);
  log(`${c.dim('source  ')} ${probe.width}x${probe.height} @ ${probe.fps?.toFixed(2)}fps · ${fmtTime(probe.duration)} · ${probe.videoCodec}${probe.audioCodec ? '+' + probe.audioCodec : ' (no audio)'}`);

  const srcFp = fingerprint(input);

  // resume: reuse previous detection if source + settings unchanged
  let previous = null;
  if (!opts.force && fs.existsSync(manifestFile)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const same = m.tool === TOOL &&
        JSON.stringify(m.source?.fingerprint) === JSON.stringify(srcFp) &&
        JSON.stringify(m.settings) === JSON.stringify(settingsOf(opts));
      if (same) { previous = m; log(c.yellow('resume  ') + ' matching previous run found, reusing detection, skipping finished shots'); }
      else log(c.yellow('note    ') + ' previous manifest differs (source or settings changed), re-detecting');
    } catch { /* corrupt manifest: re-detect */ }
  }

  fs.mkdirSync(shotsDir, { recursive: true });

  let boundaries, detection;
  if (previous) {
    boundaries = previous.boundaries;
    detection = previous.detection;
  } else {
    const d = await detectShots(input, probe, opts);
    boundaries = d.boundaries;
    detection = { primaryCandidates: d.primaryCount, auditCandidates: d.auditCount, elapsedMs: d.elapsedMs };
    log(`${c.cyan('detect  ')} ${d.primaryCount} primary + ${d.auditCount} audit candidates → ${boundaries.length} boundaries (${(d.elapsedMs / 1000).toFixed(1)}s)`);
  }

  const built = buildShots(boundaries, probe.duration);
  const { shots, mergeCount } = mergeShortShots(built, opts.minShot);
  if (mergeCount) log(`${c.yellow('merge   ')} ${mergeCount} shot(s) shorter than ${opts.minShot}s merged into neighbors`);
  const consensus = boundaries.filter((b) => b.consensus).length;
  log(`${c.bold('shots   ')} ${shots.length} shots · ${consensus}/${boundaries.length} boundaries confirmed by both detectors`);

  // copy original
  if (!fs.existsSync(originalFile) || opts.force || fingerprint(originalFile).sizeBytes !== srcFp.sizeBytes) {
    if (!opts.dryRun) { fs.copyFileSync(input, originalFile); log(`${c.dim('copy    ')} original${path.extname(input)}`); }
  }

  // cut
  const results = [];
  const started = Date.now();
  let cut = 0, skipped = 0;
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const file = path.join(shotsDir, `${i + 1}.mp4`);
    const rel = `shots/${i + 1}.mp4`;
    const entry = {
      index: i + 1, file: rel,
      start: Number(shot.start.toFixed(3)), end: Number(shot.end.toFixed(3)),
      duration: Number(shot.duration.toFixed(3)),
      openedBy: shot.openedBy
        ? { time: Number(shot.openedBy.time.toFixed(3)), detectors: shot.openedBy.detectors, consensus: shot.openedBy.consensus, score: shot.openedBy.score }
        : null,
    };
    if (opts.dryRun) {
      log(`  ${c.dim(String(i + 1).padStart(3))}  ${fmtTime(shot.start)} → ${fmtTime(shot.end)}  ${c.dim(shot.duration.toFixed(2) + 's')}  ${shot.openedBy ? (shot.openedBy.consensus ? c.green('consensus') : c.yellow(shot.openedBy.detectors.join(','))) : ''}`);
      results.push({ ...entry, cutStatus: 'dry-run' });
      continue;
    }
    const prevEntry = previous?.shots?.find((s) => s.index === i + 1);
    if (!opts.force && prevEntry && prevEntry.start === entry.start && prevEntry.end === entry.end &&
        fs.existsSync(file) && fs.statSync(file).size > 0) {
      results.push({ ...entry, cutStatus: 'kept', actualDuration: prevEntry.actualDuration ?? null, sizeBytes: fs.statSync(file).size });
      skipped++;
      continue;
    }
    progressLine(`${c.cyan('cutting ')} shot ${i + 1}/${shots.length}  ${fmtTime(shot.start)} → ${fmtTime(shot.end)}`);
    await cutShot(input, file, shot, opts);
    const actual = await probeVideo(file);
    const drift = Math.abs(actual.duration - shot.duration);
    if (drift > 0.25) {
      endProgress();
      log(`${c.yellow('warn    ')} shot ${i + 1}: cut duration ${actual.duration.toFixed(2)}s differs from plan ${shot.duration.toFixed(2)}s by ${drift.toFixed(2)}s`);
    }
    results.push({ ...entry, cutStatus: 'cut', actualDuration: Number(actual.duration.toFixed(3)), sizeBytes: fs.statSync(file).size });
    cut++;
  }
  endProgress();

  const manifest = {
    tool: TOOL, version: VERSION, createdAt: new Date().toISOString(),
    source: {
      path: input, file: `original${path.extname(input)}`,
      fingerprint: srcFp, probe,
    },
    settings: settingsOf(opts),
    detection,
    boundaries: boundaries.map((b) => ({ time: Number(b.time.toFixed(3)), detectors: b.detectors, consensus: b.consensus, score: b.score })),
    shots: results,
    stats: {
      shotCount: shots.length,
      mergedShortShots: mergeCount,
      consensusBoundaries: consensus,
      totalShotSeconds: Number(shots.reduce((s, x) => s + x.duration, 0).toFixed(3)),
      sourceSeconds: Number(probe.duration.toFixed(3)),
      averageShotSeconds: Number((probe.duration / shots.length).toFixed(3)),
      dryRun: opts.dryRun,
      cutWallMs: opts.dryRun ? 0 : Date.now() - started,
    },
  };
  writeJsonAtomic(manifestFile, manifest);

  if (opts.dryRun) {
    log(`\n${c.bold('dry run complete')}. No cuts made. Manifest: ${manifestFile}`);
  } else {
    log(`${c.green('done    ')} ${cut} cut, ${skipped} kept · ${((Date.now() - started) / 1000).toFixed(1)}s · avg shot ${manifest.stats.averageShotSeconds}s`);
    log(`${c.dim('manifest')} ${manifestFile}`);
  }
  if (opts.json) console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => { endProgress(); die(err.message, 1); });
