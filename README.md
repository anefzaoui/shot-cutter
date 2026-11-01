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

`--mode` picks the detector set (default `fast`, unchanged since v1.0). See
[Cut modes](#cut-modes-v12) for `sensitive`, `ml` and `hybrid`.

In `fast` mode two independent ffmpeg detectors run in a single decode pass:

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

## Cut modes (v1.2)

| Mode | What runs | Use it for |
|---|---|---|
| `fast` (default) | `select 'scene'` + `scdet`, fixed thresholds, one decode pass | v1.0/v1.1 behavior, fastest, very few false cuts |
| `sensitive` | `fast` + adaptive detectors on per-frame thumbnails, **same single decode pass**, + flash and same-set-up vetoes, + fades through dark (v1.3) | cuts between similar-looking shots (same palette and light), quick dissolves, time-jump fades |
| `ml` | TransNetV2 (shot-boundary network) through an optional Python helper | a learned second opinion; needs the helper installed |
| `hybrid` | `sensitive` and `ml` together, boundaries = union, each tagged with who found it | the most complete list, with a per-boundary agreement flag to review |

```bash
node shot-cutter.js episode.mp4 --mode sensitive --dry-run
node shot-cutter.js episode.mp4 --mode hybrid --python ~/.shot-cutter-ml/bin/python
```

**Why fast misses some cuts.** Its thresholds are absolute: a cut between two dark
blue-teal close-ups scores `scene` 0.21–0.24 and `scdet` 8–9, under the 0.3 / 10
thresholds, even though the frames around it score ~0.002.

**`sensitive`** keeps both fast detectors and adds, from 64-px rgb thumbnails decoded in the
same ffmpeg pass (pure JS, no extra dependency):

- **Repeated frames are skipped first.** Many web videos repeat frames (frame-rate
  conversion, low-fps sources): the test originals repeat about every other frame. A series
  that alternates motion with zeros makes every ordinary motion frame look like a spike, so
  only distinct frames are compared and the time windows use the distinct-frame rate
  (`detection.analysis` reports both counts).

- `adaptive-content`: the HSV content difference between a frame and the previous one
  (PySceneDetect ContentDetector style, hue weighted by saturation so noise in dark grey
  pixels does not count), divided by the **rolling median of its neighbours** (3 frames on
  each side, PySceneDetect AdaptiveDetector style). A cut is a spike over its neighbourhood,
  so a small absolute change still stands out; a pan or a walk is high on every frame and
  never does. Fires at ratio ≥ `--adaptive-threshold` (3) and content ≥ `--min-content` (4).
- `adaptive-hist`: the same on a luma (32-bin) + chroma (2×16-bin) histogram distance
  (`--min-hist` 3). Catches a change of light or palette even under sensor noise.
- `adaptive-short`: a 2-frame to 0.3 s transition (a quick dissolve, a dip, a motion-blurred
  cut): the frame before vs the frame after the window, against the same-lag difference on
  **both** sides of it, which must be calm. A long dissolve or a pan is never calm on both sides.
- flash veto (`--no-flash-filter` to disable): any report, fast detectors' included, whose
  old picture comes back within 0.5 s (a camera flash, a body passing the lens), or whose new
  picture was already there just before, is dropped and listed in `detection.vetoed`
  (`reason: "returned"`).
- same-set-up veto (`--no-setup-filter`): the frame before the cut and the frame after it are
  compared as brightness-normalized pictures (cross-correlation of luma, and of the edge
  picture). If both still correlate (edges ≥ 0.75 and luma ≥ 0.7) the camera did not move,
  only the light changed: lightning, a lamp, flicker, an encoder keyframe pulse. Dropped with
  `reason: "same-setup"`. On the test footage every real cut scored ≤ 0.65 on edges and every
  lighting change ≥ 0.75. A jump cut inside one fixed set-up is dropped too, by design.
- `dip` (v1.3, `--no-dips` to disable): a fade through dark (fade-out, fade-in), the usual
  time-jump transition of micro-dramas. Its frames change gradually, so no spike detector
  sees it, and the scene before the jump stayed glued to the scene after it. The per-frame
  mean luma of the same thumbnails is searched for valleys: the darkest frame is ≤ 40% of the
  median of the 0.5 s before the fall (and that reference is ≥ 20 of 255), it stays dark
  ≤ 0.5 s (longer = a black card, a shot of its own), the whole frame darkens (its brightest
  8x8 block too: a pan across a dark area keeps bright parts), and within 0.8 s the luma is
  back to ≥ 2x the minimum. It cuts at the darkest frame only if the picture 0.3 s before the
  fall and the one 0.3 s after the rise differ: luma/chroma histogram distance ≥ 20 or mean
  8x8 block-luma difference ≥ 15. A face going into shadow and out again keeps both, and is
  not cut. A dip whose span already holds another detector's cut adds nothing (this also
  keeps a black card's own cuts as they are). Measured on the 40 originals of one series:
  one fade found that no other detector cut (a night close-up fading into "Eighteen Years
  Later"), every other cut unchanged.
- `dissolve` (only with `--dissolves`): a longer cross-fade, cut once at its middle. Its
  middle frames must be blends of the frames before and after it, which a pan never is.
  Without `--dissolves` a long dissolve is never split.

The usual `--gap` / `--min-shot` rules apply to every mode, with one difference outside
`fast`: when two boundaries are closer than `--min-shot`, the **stronger** one is kept (more
detectors, then a fast detector, then score) instead of always merging the short shot into
the previous one, which in `fast` can keep a weak report and drop the real cut a few frames
before it. Reports of one cut from
different detectors are clustered within `max(--tolerance, --gap)` and the boundary keeps
all of them: `detectors`, `consensus` (two or more detectors), and `scores` per detector.

### ML mode (optional TransNetV2 helper)

`tools/transnetv2_runner.py` runs [TransNetV2](https://github.com/soCzech/TransNetV2)
on all frames (48x27, the model's input, decoded by ffmpeg in one pass) and returns
per-frame transition probabilities. shot-cutter never needs it unless `--mode ml|hybrid`
is asked for, and then fails with a clear message and these install steps if it is missing.
Install it isolated, in its own venv (or a `pip --target` dir on `PYTHONPATH`):

```bash
python3 -m venv ~/.shot-cutter-ml            # no ensurepip? python3 -m venv --without-pip + get-pip.py
~/.shot-cutter-ml/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
~/.shot-cutter-ml/bin/pip install transnetv2-pytorch   # MIT port, weights included
export SHOT_CUTTER_PYTHON=~/.shot-cutter-ml/bin/python   # or --python / opts.python
node shot-cutter.js --ml-check
```

The original TensorFlow `transnetv2` package also works if it is importable instead.
`SHOT_CUTTER_ML_RUNNER` / `opts.mlRunner` point at another runner with the same JSON
output. The model runs on CPU by default (`--device cuda|auto` to change); it holds every
48x27 frame in memory (~4 KB per frame, ~0.7 GB for two hours at 24 fps).

A run of frames over `--ml-threshold` (0.5) is one transition; its length comes from the
model's many-hot output. A short one is a cut on the frame after the peak (TransNetV2 marks
the last frame of the outgoing shot); a long one is a dissolve, split only with `--dissolves`.
`ml` alone has no frame data, so no vetoes; `hybrid` applies both vetoes to the model's
reports too, and marks every boundary `agreement: both | sensitive | ml`.

### Trade-offs

Measured on three originals of a vertical micro-drama (540x960, 24 fps, 100–125 s each,
dark blue/teal hospital scenes, lightning, burned-in subtitles, repeated frames), against
`fast`'s output, every disagreement checked by eye on the frames around it:

| Mode | Real cuts `fast` missed (15) | Real cuts lost | False cuts added | `fast`'s false cuts removed (4) | Time per episode* |
|---|---|---|---|---|---|
| `fast` | 0 | – | – | 0 | 3–5 s |
| `sensitive` | 14 | 0 | 1 | 2 | 5–6 s |
| `ml` (CPU) | 13 | 4 | 1 | 1 | 62–74 s |
| `hybrid` | 15 | 0 | 1 | 2 | 70–190 s |

\* 4-core server under other load; the ml model itself is most of its time (CPU, no GPU).

- `sensitive` is the default to reach for: a few seconds more than `fast`, no dependency, and
  it also put two of `fast`'s late cuts on the right frame (fast's short-shot merge had kept a
  report 4–6 frames after the real cut). Its one miss was a slow fade from black (longer than
  `shortTransition`); its one false cut was a lightning flicker over a short window.
- `ml` saw the fade from black, but lost real cuts in fast action (falls, slaps) and two
  flash/flare transitions, kept lightning, and is 15–20x slower on CPU.
- `hybrid` = `sensitive` plus what only the model sees (here: the fade), at the model's cost.
- Two real cuts closer than `--min-shot` (a 0.25 s insert during a slap) still become one
  boundary in every mode; lower `--min-shot` if such inserts matter.

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

// v1.2 modes: same call, same result shape, plus mode details
const s = await detectShots('episode.mp4', { mode: 'sensitive' });   // or 'ml' / 'hybrid' (+ { python })
s.boundaries[0];  // { time, detectors, consensus, score, scores: { 'adaptive-hist': 12.4, ... }, agreement? }
s.vetoed;         // reports dropped by the flash veto
const ok = await mlAvailable();  // { ok, backend, device } or { ok: false, error }
```

When ffmpeg has to run somewhere else (a job runner, another machine) and only its log and
output files come back, split the sensitive pass in two:

```js
const probe = await probeVideo(file);
const args = sensitiveArgs(file, probe, {}, '/tmp/thumbs.rgb');  // run `ffmpeg ...args` anywhere, keep stderr
const r = await detectShotsFromLog({ log: stderr, raw: fs.readFileSync('/tmp/thumbs.rgb'), probe });
// hybrid: add `predictions` (the JSON printed by tools/transnetv2_runner.py)
```

The thumbnails are small (64 px long side: ~7 KB per frame, ~17 MB for 100 s at 24 fps).

`detectShots(file, opts)` without `mode` is the v1.1 call, unchanged. The building blocks
are exported too (`FrameAnalyzer`, `adaptiveCandidates`, `runTransNet`, `mlCandidates`,
`reconcileBoundaries` with optional `prefer` / `withScores`).

Importing has no side effects (no CLI parsing, no `process.exit`). Every long call takes
`{ onProgress, signal }`. `detectStale` also returns the energy `envelope`, and
`quietestPoint(envelope, from, to)` helps snap your own cut points.

Install from git: `npm i github:anefzaoui/shot-cutter`.

## Tests

`npm test` generates synthetic clips with ffmpeg (tone bursts over a noise floor, three
solid-color shots; for the modes: a hard cut, a low-contrast cut between two near-identical
teal shots, a 1 s dissolve, a fast pan, a white flash, a fade through dark between two shots
and within one shot, a black card) and checks stale detection, every cut
mode, one-pass cutting and rendering. The `ml`/`hybrid` plumbing is tested with a stub runner;
the real-model test runs only when `SHOT_CUTTER_PYTHON` has TransNetV2.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--out <dir>` | cwd | Output root; the tool creates `<out>/<basename>/` |
| `--threshold <n>` | 0.3 | Primary detector scene threshold (0..1, lower means more cuts) |
| `--scdet <n>` | 10 | Audit detector threshold (0..100) |
| `--min-shot <sec>` | 0.5 | Merge shots shorter than this into a neighbor |
| `--gap <sec>` | 0.12 | Minimum spacing between boundaries |
| `--tolerance <sec>` | 0.06 | Window in which the two detectors count as agreeing |
| `--mode <m>` | fast | `fast`, `sensitive`, `ml` or `hybrid` (see Cut modes) |
| `--dissolves` | off | Non-fast modes: cut long dissolves once, at the middle |
| `--adaptive-threshold <n>` | 3 | Spike / neighbour-median ratio |
| `--min-content <n>` / `--min-hist <n>` | 4 / 3 | Adaptive floors (0..255 / 0..100) |
| `--no-dips` | off | Do not cut fades through dark (sensitive, hybrid) |
| `--no-flash-filter` | off | Keep reports whose old picture comes back within 0.5 s |
| `--no-setup-filter` | off | Keep reports where the camera set-up did not change |
| `--ml-threshold <n>` | 0.5 | TransNetV2 transition probability |
| `--python <path>` | `$SHOT_CUTTER_PYTHON` or python3 | Python with TransNetV2 |
| `--device <d>` | cpu | TransNetV2 device (`cpu`, `cuda`, `auto`) |
| `--ml-check` | | Check the ml helper and exit |
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
  "tool": "shot-cutter", "version": "1.2.0", "createdAt": "...",
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

Manifest `file` entries use forward slashes on every OS. In non-fast modes `settings` also
holds `mode` and the mode options, `detection` holds `mode`, candidate counts, `timings`,
`vetoed` and (ml) the backend, and each boundary adds `scores` (and `agreement` in hybrid).
A fast-mode manifest is identical to v1.1's.

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
