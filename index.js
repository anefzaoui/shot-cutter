// shot-cutter library entry. Importing this module has no side effects (no CLI, no process.exit).
export { probeVideo, run, FFMPEG, FFPROBE } from './lib/ffmpeg.js';
export { detectShots, detectShotsFromLog, reconcileBoundaries, buildShots, mergeShortShots, thinBoundaries, SHOT_DEFAULTS } from './lib/shots.js';
export { detectStale, analyzeEnvelope, audioEnvelope, quietestPoint, levels, STALE_DEFAULTS } from './lib/stale.js';
export { cutSegments, renderKeep } from './lib/cut.js';
export { MODES, MODE_DEFAULTS, sensitivePass, sensitiveArgs, modeCandidates, analysisDims } from './lib/modes.js';
export { FrameAnalyzer, contentDiff, histDiff } from './lib/frames.js';
export { adaptiveCandidates, dipCandidates, returnVeto, ADAPTIVE_DEFAULTS } from './lib/adaptive.js';
export { mlAvailable, runTransNet, mlCandidates, MlUnavailableError, ML_DEFAULTS, DEFAULT_RUNNER as ML_RUNNER } from './lib/ml.js';
export const VERSION = '1.3.0';
