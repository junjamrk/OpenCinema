"""Bounded bridge to the pinned upstream Video Depth Anything temporal model.

The Go file service owns all output writes. This worker only reads frozen model
assets and RGBA stdin, then emits validated frame metadata and PNG bytes.
"""
import base64
import contextlib
import json
import os
import sys
import time

try:
    import resource
except ImportError:
    resource = None

sys.dont_write_bytecode = True
options = json.loads(os.environ["OPEN_CINEMA_DEPTH_OPTIONS"])
width, height, frameCount, fps = [options[key] for key in ("width", "height", "frameCount", "fps")]
if not all(type(value) is int for value in (width, height, frameCount)) or not (48 <= width <= 384 and 48 <= height <= 384 and 1 <= frameCount <= 360 and 2 <= fps <= 12):
    raise ValueError("Invalid bounded video depth configuration")
sys.path.insert(0, options["sourceDirectory"])
with contextlib.redirect_stdout(sys.stderr):
    import cv2
    import numpy as np
    import torch
    from video_depth_anything.video_depth import VideoDepthAnything

torch.set_num_threads(min(4, os.cpu_count() or 1))
device = options["device"]
if device not in ("cpu", "cuda", "mps") or (device == "cuda" and not torch.cuda.is_available()) or (device == "mps" and not torch.backends.mps.is_available()):
    raise ValueError("Requested Video Depth Anything device is unavailable")

def emit(value):
    print(json.dumps(value, allow_nan=False), flush=True)

expectedBytes = width * height * frameCount * 4
raw = sys.stdin.buffer.read(expectedBytes + 1)
if len(raw) != expectedBytes:
    raise ValueError("RGB decode did not produce the frozen complete frame count")
frames = np.frombuffer(raw, dtype=np.uint8).reshape(frameCount, height, width, 4)[:, :, :, :3].copy()
del raw
began = time.monotonic()
with contextlib.redirect_stdout(sys.stderr):
    model = VideoDepthAnything(encoder="vits", features=64, out_channels=[48, 96, 192, 384])
    model.load_state_dict(torch.load(options["modelPath"], map_location="cpu", weights_only=True), strict=True)
    model = model.to(device).eval()
emit({"type": "ready", "inputSize": 252, "device": device, "torchVersion": torch.__version__, "numpyVersion": np.__version__, "temporalWindow": 32, "temporalOverlap": 10})
with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
    # Use the upstream temporal inference, including overlap scale/shift alignment.
    depths, _ = model.infer_video_depth(frames, fps, input_size=252, device=device, fp32=True)
if depths.shape != (frameCount, height, width) or not np.isfinite(depths).all():
    raise ValueError("Invalid temporal depth output")
clipMin, clipMax = float(depths.min()), float(depths.max())
clipRange = clipMax - clipMin
inferenceMs = (time.monotonic() - began) * 1000
emit({"type": "normalization", "min": clipMin, "max": clipMax})
for index, depth in enumerate(depths):
    # A single clip range preserves the model's cross-frame relative scale.
    pixels = np.rint(np.clip((depth - clipMin) / clipRange, 0, 1) * 255).astype(np.uint8) if clipRange > 1e-8 else np.zeros((height, width), dtype=np.uint8)
    success, encoded = cv2.imencode(".png", pixels)
    if not success:
        raise ValueError("Depth PNG encoding failed")
    emit({"type": "artifact", "name": f"frame{index:04d}.png", "data": base64.b64encode(encoded).decode("ascii")})
    peakRss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if resource else 0
    if resource and sys.platform != "darwin":
        peakRss *= 1024
    emit({"type": "frame", "index": index, "time": index / fps, "min": float(depth.min()), "max": float(depth.max()), "mean": float(depth.mean()), "inferenceMs": inferenceMs if index == 0 else 0, "peakRss": peakRss})
emit({"type": "closed", "frames": frameCount})
