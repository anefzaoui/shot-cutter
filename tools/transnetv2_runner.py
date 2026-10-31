#!/usr/bin/env python3
"""TransNetV2 shot-boundary helper for shot-cutter's `ml` and `hybrid` modes.

Optional: shot-cutter works without it. Install it in its own venv (see README, "ML mode"):

    python3 -m venv ~/.shot-cutter-ml
    ~/.shot-cutter-ml/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
    ~/.shot-cutter-ml/bin/pip install transnetv2-pytorch
    export SHOT_CUTTER_PYTHON=~/.shot-cutter-ml/bin/python

Usage (normally called by shot-cutter itself):
    transnetv2_runner.py --check
    transnetv2_runner.py VIDEO [--ffmpeg PATH] [--device cpu|cuda|auto]

Prints ONE JSON object on stdout:
    {"backend", "device", "frames", "times": [pts seconds per frame],
     "single": [per-frame transition probability], "many": [...], "elapsedMs"}
Exit codes: 0 ok, 3 model/package not installed, 1 any other failure. Messages go to stderr.

Backends, first found wins:
    transnetv2-pytorch  (pip install transnetv2-pytorch; weights ship inside the package)
    transnetv2          (the original TensorFlow package from github.com/soCzech/TransNetV2)
"""
import argparse
import contextlib
import json
import os
import re
import subprocess
import sys
import threading
import time

NOT_INSTALLED = 3
SHOWINFO = re.compile(r"\bn:\s*(\d+)\s.*?pts_time:\s*([-0-9.eE+]+)")


def load_backend(device):
    """Return (name, predict(frames_uint8_N_27_48_3) -> (single, many) numpy arrays, device)."""
    errors = []
    try:
        import numpy as np  # noqa: F401
    except ImportError as e:
        raise ModuleNotFoundError(f"numpy: {e}")
    try:
        import torch
        from transnetv2_pytorch import TransNetV2
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        # the package prints notices on stdout; stdout must carry only our JSON
        with contextlib.redirect_stdout(sys.stderr):
            model = TransNetV2(device=device)
        model.eval()

        def predict(frames):
            with torch.no_grad(), contextlib.redirect_stdout(sys.stderr):
                single, many = model.predict_frames(torch.from_numpy(frames).to(model.device), quiet=True)
            return single.cpu().numpy(), many.cpu().numpy()

        return "transnetv2-pytorch", predict, device
    except ImportError as e:
        errors.append(f"transnetv2-pytorch: {e}")
    try:
        with contextlib.redirect_stdout(sys.stderr):
            from transnetv2 import TransNetV2 as TFTransNetV2
            model = TFTransNetV2()

        def predict(frames):
            with contextlib.redirect_stdout(sys.stderr):
                single, many = model.predict_frames(frames)
            return single, many

        return "transnetv2-tensorflow", predict, "tf"
    except ImportError as e:
        errors.append(f"transnetv2 (tensorflow): {e}")
    raise ModuleNotFoundError("; ".join(errors))


def decode(video, ffmpeg):
    """All frames as uint8 [N, 27, 48, 3] (TransNetV2's input) + their pts times, in one ffmpeg pass."""
    import numpy as np
    args = [ffmpeg, "-hide_banner", "-nostats", "-loglevel", "info", "-i", video, "-map", "0:v:0",
            "-vf", "showinfo", "-fps_mode", "passthrough", "-s", "48x27", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    times, tail = [], []

    def read_err():
        for raw in proc.stderr:
            line = raw.decode("utf-8", "replace")
            m = SHOWINFO.search(line) if "showinfo" in line else None
            if m:
                times.append(float(m.group(2)))
            else:
                tail.append(line)
                del tail[:-20]

    t = threading.Thread(target=read_err, daemon=True)
    t.start()
    data = proc.stdout.read()
    proc.wait()
    t.join()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg exited {proc.returncode}: {' | '.join(x.strip() for x in tail[-4:])}")
    frames = np.frombuffer(data, np.uint8).reshape([-1, 27, 48, 3])
    return np.array(frames, copy=True), times[: len(frames)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", nargs="?")
    ap.add_argument("--check", action="store_true", help="only check that a backend loads")
    ap.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_PATH", "ffmpeg"))
    ap.add_argument("--device", default="cpu", help="cpu (default, deterministic), cuda or auto")
    a = ap.parse_args()
    try:
        backend, predict, device = load_backend(a.device)
    except ModuleNotFoundError as e:
        print(f"TransNetV2 is not installed for {sys.executable}: {e}", file=sys.stderr)
        return NOT_INSTALLED
    if a.check:
        print(json.dumps({"ok": True, "backend": backend, "device": device, "python": sys.executable}))
        return 0
    if not a.video:
        ap.error("a video path is required")
    started = time.time()
    frames, times = decode(a.video, a.ffmpeg)
    if len(frames) == 0:
        raise RuntimeError("no video frames decoded")
    single, many = predict(frames)
    out = {
        "backend": backend, "device": device, "frames": int(len(frames)), "times": [round(x, 6) for x in times],
        "single": [round(float(x), 4) for x in single.reshape(-1)],
        "many": [round(float(x), 4) for x in many.reshape(-1)],
        "elapsedMs": int((time.time() - started) * 1000),
    }
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"transnetv2_runner: {e}", file=sys.stderr)
        sys.exit(1)
