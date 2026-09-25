# shot-cutter

CLI **and importable library** that splits a video into its individual shots, cut on
detected shot boundaries — one file per shot, plus a JSON manifest describing everything
it found and did. Since v1.1 it can also find a recording's **stale parts** (dead air
between takes) from the audio and render a tightened version.

I built this to prepare training datasets for micro-drama video LoRAs. Trainers for
models like Wan 2.x or SkyReels want short single-shot clips, not full episodes, and
not clips that straddle a hard cut mid-file. Slicing an episode every N seconds cuts
blindly across scene changes; cutting on the actual shot boundaries gives you clean
single-shot clips ready to pair with caption files. It works just as well for anything
else that needs shot-level segmentation: highlight extraction, editing prep, dataset
curation, shot-by-shot analysis.

## Requirements

- Node.js 20 or newer
- `ffmpeg` and `ffprobe` on PATH, or point `FFMPEG_PATH` / `FFPROBE_PATH` at them
- No npm dependencies. The CLI (`shot-cutter.js`) sits on top of the library
  (`index.js` + `lib/`); keep them together.

Works on macOS, Linux, and Windows. Paths go through `node:path`, external tools are
spawned without a shell, and colored output falls back to plain text on consoles
without ANSI support (`--no-color`, or the standard `NO_COLOR` env var).

## Usage

```bash
node shot-cutter.js episode.mp4 --out ./episodes
```

For an input `showxepx.mp4` this produces:

```
<out>/showxepx/
├── original.mp4        # untouched copy of the source
├── shots/
│   ├── 1.mp4           # frame-accurate, re-encoded per-shot files
│   ├── 2.mp4
│   └── ...
└── showxepx.json       # the manifest, see below
```

To preview the detected shots without cutting anything:

```bash
node shot-cutter.js episode.mp4 --dry-run
```

## How detection works

Two independent ffmpeg detectors run in a single decode pass:

1. Primary: `select='gt(scene,T)'` with `showinfo`, frame-difference scene scoring
   with frame-accurate timestamps.
2. Audit: `scdet`, ffmpeg's dedicated scene-change detector, with scores.

Their reports are clustered within a small tolerance window and reconciled into
boundaries. Each boundary records which detectors saw it and whether both agreed
(`consensus: true`). A boundary reported independently by both detectors is very
rarely a false positive. Boundaries closer together than `--gap` are dropped, and
shots shorter than `--min-shot` are merged into a neighbor instead of silently
deleted.

Cutting re-encodes with libx264 and AAC in a **single ffmpeg pass**: keyframes are
forced at every boundary and the segment muxer splits there (with half a frame of
tolerance so rounding can never skip a split). Shot starts almost never fall on
keyframes, so stream-copying would shift cuts by up to a GOP. After cutting, every
output is probed and its real duration checked against plan; anything drifting more
than 0.25s gets a warning. (v1.0 ran one ffmpeg process per shot; one pass is
several times faster on shot-dense videos.)

## Stale mode: find the dead air

```bash
node shot-cutter.js raw-take.mp4 --stale            # manifest only
node shot-cutter.js raw-take.mp4 --stale --render   # + raw-take.tight.mp4
```

Designed for talking-head raws full of pauses between takes:

1. Audio is decoded to 16 kHz mono PCM and measured in 20 ms frames (RMS, dBFS) in the
   **speech band** (150 Hz–4 kHz, so chair creaks and footsteps don't count). Constant
   memory, fast (a 3-minute take analyzes in ~0.2 s).
2. The threshold **adapts to the recording**: noise floor (10th percentile) and speech
   level (95th percentile) are measured, and the threshold sits between them. A quiet
   phone take at -35 LUFS and a mastered track both work without tuning
   (`--threshold-db` fixes it if you want).
3. Hysteresis, short pauses kept (`--min-silence`), blips dropped, asymmetric padding
   (`--margin-before` / `--margin-after`, like auto-editor), and every cut is snapped
   to the quietest frame nearby so it never lands mid-syllable.

`<basename>.stale.json` holds `keep` and `stale` ranges, the measured levels and stats.

## As a library

```js
import { detectShots, detectStale, cutSegments, renderKeep, probeVideo } from 'shot-cutter';

const ac = new AbortController();
const { keep, stale, levels, stats } = await detectStale('take.mp4', { minSilence: 0.4 },
  { onProgress: (f) => console.log(Math.round(f * 100) + '%'), signal: ac.signal });
await renderKeep('take.mp4', keep, 'tight.mp4');

const { boundaries, shots } = await detectShots('episode.mp4', { threshold: 0.3 });
await cutSegments('episode.mp4', shots.slice(1).map((s) => s.start), './shots');
```

Importing has no side effects (no CLI parsing, no `process.exit`). Every long call takes
`{ onProgress, signal }`. `detectStale` also returns the energy `envelope`, and
`quietestPoint(envelope, from, to)` helps snap your own cut points.

Install from git: `npm i github:anefzaoui/shot-cutter`.

## Tests

`npm test` generates synthetic clips with ffmpeg (tone bursts over a noise floor, three
solid-color shots) and checks stale detection, shot detection, one-pass cutting and
rendering.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--out <dir>` | cwd | Output root; the tool creates `<out>/<basename>/` |
| `--threshold <n>` | 0.3 | Primary detector scene threshold (0..1, lower means more cuts) |
| `--scdet <n>` | 10 | Audit detector threshold (0..100) |
| `--min-shot <sec>` | 0.5 | Merge shots shorter than this into a neighbor |
| `--gap <sec>` | 0.12 | Minimum spacing between boundaries |
| `--tolerance <sec>` | 0.06 | Window in which the two detectors count as agreeing |
| `--crf <n>` | 18 | x264 quality for the cut files |
| `--preset <p>` | medium | x264 preset |
| `--strip-audio` | off | Write video-only shot files |
| `--dry-run` | off | Detect, print the shot table, write the manifest, cut nothing |
| `--force` | off | Ignore a previous run, redo detection and all cuts |
| `--json` | off | Print the full manifest to stdout at the end |
| `--quiet` / `--no-color` | off | Terminal behavior |
| `--stale` | off | Stale mode (see above) |
| `--render` | off | With `--stale`: write `<basename>.tight.mp4` |
| `--threshold-db <dB>` | adaptive | Fixed speech threshold |
| `--min-silence <sec>` | 0.35 | Pauses shorter than this are kept |
| `--margin-before <sec>` / `--margin-after <sec>` | 0.12 / 0.18 | Padding around speech |
| `--min-keep <sec>` | 0.3 | Drop kept ranges shorter than this |

## The manifest (`<basename>.json`)

Everything about the run, for downstream tooling:

```jsonc
{
  "tool": "shot-cutter", "version": "1.1.0", "createdAt": "...",
  "source": {
    "path": "...", "file": "original.mp4",
    "fingerprint": { "sizeBytes": 57809109, "mtimeMs": 1756130000000 },
    "probe": { "duration": 198.023, "width": 1080, "height": 1920, "fps": 25,
               "videoCodec": "h264", "audioCodec": "aac" }
  },
  "settings": { "threshold": 0.3, "scdet": 10, "minShot": 0.5, "...": "..." },
  "boundaries": [ { "time": 2.06, "detectors": ["scdet","select-scene"],
                    "consensus": true, "score": 55.1 } ],
  "shots": [ { "index": 2, "file": "shots/2.mp4", "start": 2.06, "end": 3.18,
               "duration": 1.12, "openedBy": { "...boundary..." },
               "cutStatus": "cut", "actualDuration": 1.12, "sizeBytes": 812345 } ],
  "stats": { "shotCount": 86, "consensusBoundaries": 84, "mergedShortShots": 5,
             "totalShotSeconds": 198.023, "averageShotSeconds": 2.303 }
}
```

Manifest `file` entries use forward slashes on every OS.

## Resuming

The manifest stores a source fingerprint (size + mtime) and the exact settings.
Rerunning the same command reuses the previous detection and skips every shot file
that already exists with matching timings, so an interrupted run continues where it
stopped. A dry-run followed by a real run reuses the dry-run's detection. Change the
source or any setting and it re-detects. `--force` redoes everything.

## Testing notes

Tested on vertical drama episodes (1080x1920 at 25fps, 49s and 198s). On the longer
one: 90 boundaries, 84 confirmed by both detectors, 86 shots, total cut duration
within 0.02s of the source, max per-shot drift 17ms (under one frame at 25fps), and
boundary frames manually checked as true scene changes with no frame bleed.
