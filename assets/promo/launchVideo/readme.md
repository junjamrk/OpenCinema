# Launch film · source

Source and build pipeline for `assets/promo/openCinemaLaunch.mp4`, the 15-second launch film. The storyboard it was built from is [`docs/launchVideoStoryboard.md`](../../../docs/launchVideoStoryboard.md).

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
| `sound.py` | NumPy sound design: 150 BPM pulse, whooshes, UI clicks, final hit; loudness-normalised to −16 LUFS with a look-ahead limiter. |
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

MP4 · 1920 × 1080 · 60 fps · H.264 High · `yuv420p` · BT.709 · AAC 48 kHz stereo 192 kb/s · 15.000 s · `+faststart`.

## Verification record

Filled in after each render; see the storyboard for the checks it answers.
