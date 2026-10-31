# Launch film · source

Source and build pipeline for `assets/promo/openCinemaLaunch.mp4`, the 30-second launch film. The storyboard it was built from is [`docs/launchVideoStoryboard.md`](../../../docs/launchVideoStoryboard.md).

## How it is made

Everything on screen is a real DOM or canvas element whose state is a pure function of time. There are no screenshots, no recorded footage and no external media. The page is stepped through time by a headless Chromium and each sub-frame is piped to ffmpeg.

| File | Role |
| --- | --- |
| `scene.html` | Markup and styles for the nine shots (light world, dark product panels, Inter + JetBrains Mono). |
| `engine.js` | Timeline helpers: the product's `cubic-bezier(0.16, 1, 0.3, 1)` easing, segment progress, kinetic word reveal, camera transform, seeded random. |
| `harbor.js` | Procedural *Harbor Chase* imagery: rainy harbor night, sedan, lamps, neon, running performer, relative-depth variant. |
| `previs.js` | Tiny software 3D renderer for the Blockout shot: white-model set, mannequin, car, virtual camera; RGB / DEPTH / NORMAL layers. |
| `scenes.js` | The nine shots and `window.seek(t)`. |
| `render.mjs` | Playwright driver. Captures `samples` sub-frames per frame across a 180° shutter and lets ffmpeg's `tmix` average them into real motion blur, then encodes H.264. |
| `sound.py` | NumPy sound design: 120 BPM pulse, whooshes, UI clicks, final hit; loudness-normalised to −16 LUFS with a look-ahead limiter. |
| `build.sh` | Runs the whole pipeline and prints the stream facts. |

## Build

```bash
bash assets/promo/launchVideo/build.sh
```

Preview without motion blur (about four times faster):

```bash
SAMPLES=1 bash assets/promo/launchVideo/build.sh
```

Stills for checking a moment:

```bash
node assets/promo/launchVideo/render.mjs --stills "1.6,3.3,12.4,13.6" --stillsDir /tmp/stills
```

Requirements: Node 22 with Playwright and its Chromium, ffmpeg with `libx264` and `aac`, Python 3 with NumPy, and the Inter, Inter Display and JetBrains Mono fonts installed system-wide (the page uses local fonts, nothing is fetched).

## Output

MP4 · 1920 × 1080 · 60 fps · H.264 High · `yuv420p` · BT.709 · AAC 48 kHz stereo 192 kb/s · 30.000 s · `+faststart`.

## Verification record

Render of 2026-10-31, `assets/promo/openCinemaLaunch.mp4` (10 998 289 bytes), 30 s cut.

| Check | Result |
| --- | --- |
| Container and streams | MP4 `+faststart`; H.264 High, 1920 × 1080, 60/1 fps, `yuv420p`, BT.709, 1800 frames; AAC LC 48 kHz stereo 182 kb/s; duration 30.000 s |
| Loudness | Integrated −16.2 LUFS, sample peak −0.6 dBFS (limiter ceiling −1 dBFS, soft safety stage) |
| End-card hold | Source frames are pixel-identical from 28.42 s to 29.98 s. In the encoded file the frame at 28.45 s differs from the last frame by a mean of 0.005 levels with 0.002 % of pixels above 10, which is encoder refinement on a static picture. The complete card therefore holds 1.55 s. |
| Readability at full speed | Frames pulled from the encoded film at 1.50, 2.45, 4.80, 6.20, 7.90, 9.90, 10.70, 11.70 (unchanged first half) and 12.80, 13.90, 14.75, 15.90, 16.60, 17.40, 18.50, 20.60, 21.40, 22.50, 23.60, 24.40, 25.60, 26.40, 27.20, 27.90, 28.60, 29.98 s. Every headline is fully legible for at least one second; UI chips use solid backings over bright viewports; no headline overlaps a panel (panels end at y = 790–800, headlines start at y ≥ 814). |
| Live state | Every scene draws from `seek(t)`; there are no image assets besides the brand logo PNG on the end card. |

Re-run the checks with `ffprobe`, `ffmpeg -af ebur128` and frame extraction as described in the storyboard.
