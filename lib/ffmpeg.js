// ffmpeg/ffprobe process helpers shared by the library and the CLI.
// - Line-streaming stderr parser (bounded memory: only the tail is kept for error messages)
// - AbortSignal support, progress from `-progress pipe:1`
import { spawn } from 'node:child_process';
import path from 'node:path';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const TAIL = 16 * 1024;

/**
 * Run a binary. Options:
 *  onLine(line)      called for every stderr line (streaming, nothing accumulated)
 *  onProgress(sec)   fed from `-progress pipe:1` out_time
 *  capture           resolve with stdout as a Buffer
 *  onData(buf)       stream raw stdout (e.g. PCM) without accumulating it
 *  signal            AbortSignal → kills the process, rejects with AbortError
 */
export function run(bin, args, { onLine, onProgress, onData, capture = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let tail = '', partial = '', progressBuf = '';
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-TAIL);
      if (!onLine) return;
      partial += s;
      let i;
      while ((i = partial.indexOf('\n')) >= 0) { onLine(partial.slice(0, i)); partial = partial.slice(i + 1); }
    });
    child.stdout.on('data', (d) => {
      if (capture) chunks.push(d);
      onData?.(d);
      if (!onProgress) return;
      progressBuf += d.toString();
      let i;
      while ((i = progressBuf.indexOf('\n')) >= 0) {
        const line = progressBuf.slice(0, i); progressBuf = progressBuf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) onProgress(Number(m[1]) / 1e6);
      }
    });
    child.on('error', (e) => reject(new Error(`${path.basename(bin)}: ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (partial && onLine) onLine(partial);
      if (signal?.aborted) return reject(abortError());
      if (code === 0) resolve({ stdout: Buffer.concat(chunks) });
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${tail.split('\n').filter(Boolean).slice(-4).join(' | ')}`));
    });
  });
}

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

/** Probe a media file. fps uses avg_frame_rate (correct for variable-frame-rate phone footage). */
export async function probeVideo(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { capture: true });
  const data = JSON.parse(stdout.toString());
  const v = (data.streams || []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = (data.streams || []).find((s) => s.codec_type === 'audio');
  const frac = (s) => { const [n, d] = String(s || '0/1').split('/').map(Number); return d ? n / d : null; };
  return {
    duration: Number(data.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0,
    width: v?.width ?? null, height: v?.height ?? null,
    fps: frac(v?.avg_frame_rate) || frac(v?.r_frame_rate),
    videoCodec: v?.codec_name ?? null, audioCodec: a?.codec_name ?? null,
    hasVideo: !!v, hasAudio: !!a,
    sizeBytes: Number(data.format?.size) || null,
  };
}
