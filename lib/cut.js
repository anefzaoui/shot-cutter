// Cutting.
// - cutSegments: ONE ffmpeg pass (segment muxer + forced keyframes at every boundary) instead of one process per shot.
// - renderKeep: concatenate kept ranges (e.g. from detectStale) into a single tightened file (select/aselect).
import fs from 'node:fs';
import path from 'node:path';
import { run, FFMPEG } from './ffmpeg.js';

/**
 * Split `input` at `times` (seconds, ascending, excluding 0/end) into outDir/<pattern>.
 * Frame-accurate: keyframes are forced at each boundary and the segment muxer splits there.
 */
export async function cutSegments(input, times, outDir, { crf = 18, preset = 'medium', stripAudio = false, pattern = '%d.mp4', duration, fps = 30, onProgress, signal } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const list = times.map((t) => t.toFixed(3)).join(',');
  // Half a frame of tolerance so rounding never makes the muxer skip a forced keyframe (ffmpeg docs, segment muxer).
  const delta = (0.5 / (fps || 30)).toFixed(4);
  const args = ['-y', '-hide_banner', '-nostats', '-loglevel', 'error', '-i', input,
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    ...(times.length ? ['-force_key_frames', list] : []),
    ...(stripAudio ? ['-an'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-f', 'segment', ...(times.length ? ['-segment_times', list, '-segment_time_delta', delta] : ['-segment_time', '999999']),
    '-reset_timestamps', '1', '-segment_start_number', '1', '-segment_format_options', 'movflags=+faststart',
    '-progress', 'pipe:1', path.join(outDir, pattern)];
  await run(FFMPEG, args, { signal, onProgress: (t) => duration && onProgress?.(Math.min(1, t / duration)) });
}

/**
 * Render only the kept ranges ([{start,end}]) back-to-back into `output`.
 * trim/atrim per range + concat: audio and video are cut identically (aselect is not reliable for this).
 */
export async function renderKeep(input, keep, output, { crf = 18, preset = 'medium', hasAudio = true, onProgress, signal } = {}) {
  if (!keep.length) throw new Error('Nothing to keep');
  const total = keep.reduce((s, k) => s + k.end - k.start, 0);
  const parts = [], labels = [];
  keep.forEach((k, i) => {
    const s = k.start.toFixed(3), e = k.end.toFixed(3);
    parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    if (hasAudio) parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}]${hasAudio ? `[a${i}]` : ''}`);
  });
  const graph = `${parts.join(';')};${labels.join('')}concat=n=${keep.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`;
  await run(FFMPEG, ['-y', '-hide_banner', '-nostats', '-loglevel', 'error', '-i', input, '-filter_complex', graph,
    '-map', '[v]', ...(hasAudio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-progress', 'pipe:1', output], { signal, onProgress: (t) => onProgress?.(Math.min(1, t / total)) });
}
