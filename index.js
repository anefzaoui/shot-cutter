// shot-cutter library entry. Importing this module has no side effects (no CLI, no process.exit).
export { probeVideo, run, FFMPEG, FFPROBE } from './lib/ffmpeg.js';
export { detectShots, reconcileBoundaries, buildShots, mergeShortShots, SHOT_DEFAULTS } from './lib/shots.js';
export { detectStale, analyzeEnvelope, audioEnvelope, quietestPoint, levels, STALE_DEFAULTS } from './lib/stale.js';
export { cutSegments, renderKeep } from './lib/cut.js';
export const VERSION = '1.1.0';
