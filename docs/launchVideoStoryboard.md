# OpenCinema launch film · storyboard

A 15-second, Apple-style launch film for the OpenCinema workbench. This document is the plan the film was built from: shot list, timing grid, on-screen text, camera moves, transitions, and the sound cue sheet. Sources and the build pipeline live in [`assets/promo/launchVideo/`](../assets/promo/launchVideo/readme.md); the rendered film is [`assets/promo/openCinemaLaunch.mp4`](../assets/promo/openCinemaLaunch.mp4).

## Decisions made before building

- **Duration: 15.0 s.** The brief names a 15-second film and lays out a 0–15 s storyboard; its deliverable line says 35 seconds. The 35 is treated as a typo for 15. A longer cut would need twenty seconds of content the brief does not describe.
- **One timing grid.** Every cut lands on a beat of a 150 BPM pulse (one beat = 0.40 s). The brief's scene boundaries were snapped to the nearest beat (at most 0.2 s of movement) so the picture and the pulse never drift apart. End-card time was taken from the previs and footage scenes so the finished card can hold for a full 1.5 s.
- **One fictional project throughout:** *Harbor Chase*. A rainy-night car chase at a container harbor. The shot being fixed is always Shot 02. Every picture in the film (stills, clips, candidates, depth passes, previs) is drawn procedurally in code for this film. No photographs, no stock, and nothing produced by a video generation model.
- **Live state only.** Every interface element is a real DOM or canvas element whose state is a function of time. There are no screenshots and no pans over static images.
- **Logo.** The brand mark was redesigned during this task (see [Brand mark](#brand-mark)). The end card uses `assets/brand/logoLight.png` exactly as committed.

### Brief guide vs. final timings

| Scene | Brief | Final | Length |
| --- | --- | --- | --- |
| Hook: agent | 0.0–1.5 | 0.0–1.6 | 1.6 s |
| Node canvas | 1.5–3.5 | 1.6–3.6 | 2.0 s |
| Scoped control | 3.5–5.0 | 3.6–5.2 | 1.6 s |
| Image editing | 5.0–6.8 | 5.2–6.8 | 1.6 s |
| 3D previs | 6.8–8.8 | 6.8–8.4 | 1.6 s |
| Footage analysis | 8.8–10.2 | 8.4–9.6 | 1.2 s |
| Generation plan | 10.2–11.4 | 9.6–10.8 | 1.2 s |
| Review and edit | 11.4–13.0 | 10.8–12.4 | 1.6 s |
| End card | 13.0–15.0 | 12.4–15.0 | 2.6 s (complete card holds 1.55 s) |

## Visual system

| Role | Value |
| --- | --- |
| World background | `#F7F7F4` |
| Text | `#101315` |
| Accent, selection, flow | `#4FDBC8`, used only for selection rings, connection flow, the send button, the Export state and pass marks |
| Product panels | `#121316` panel, `#20232A` node body, 1 px `rgba(255,255,255,.08)` edges |
| Headlines | Inter Display SemiBold, 84 px, tracking −0.025 em, bottom-left of frame, one or two short lines |
| UI text | Inter 20–26 px |
| Technical labels | JetBrains Mono 16–22 px, uppercase chips |
| Easing | `cubic-bezier(0.16, 1, 0.3, 1)` for every entrance, zoom and camera move; `cubic-bezier(0.4, 0, 1, 1)` for exits |
| Camera | Continuous: push in, zoom out, whip pan, slow drift on every held shot |
| Shutter | 180° motion blur, four temporal samples per frame |

Headlines land word by word (rise 36 px, blur 10 px → 0, 0.32 s each, 0.07 s stagger). The headline zone is the bottom-left 820 × 220 px; interface panels never enter it.

## Shot list

Times are seconds from the first frame. "Cut" is the transition out of the shot.

### S01 · Hook: agent · 0.00–1.60

| | |
| --- | --- |
| Picture | Off-white world. A project chip, `HARBOR CHASE · NIGHT · SHOT 02`, fades in top-left (0.00–0.30). An oversized composer panel (dark graphite, 1480 × 200) rises into the centre (0.00–0.40). |
| State changes | 0.15–1.05 the prompt types itself, one character per 33 ms: **Make the chase feel faster.** A caret blinks. 1.20 the mint send button is pressed: scales 0.9 → 1.0, a mint ring expands out of it. |
| Camera | 1.28–1.60 push in on the send button, ×1 → ×60. Mint fills the frame by 1.55. |
| Text | Prompt as above. Small label under the panel: `Codex · Claude Code · Any MCP agent` (fades in 0.30). |
| Cut | **Match cut on a full-mint frame at 1.60.** |
| Sound | Pulse starts on beat 1 (0.40). Keystroke ticks per character. UI click 1.20. Rising whoosh 1.28–1.60. |

### S02 · Node canvas · 1.60–3.60

| | |
| --- | --- |
| Picture | The mint frame is the body glow of the text node at ×40. The node cools from mint to graphite (1.60–1.95) while the camera zooms out. |
| State changes | 1.85–2.45 eight nodes spring into place (scale 0.7 → 1, 30 px rise, 0.09 s stagger): Text *Chase brief*, Image *Hero car still*, Audio *Rain + engine bed*, Video *Reference clip*, Blockout *Previs · Shot 02*, Image generation *Frame · Shot 02*, Video generation *Shot 02 · candidates*, Edit plan *Cut · 4 shots*. 2.25–3.35 mint connections draw source → target (dash offset, 0.09 s stagger), arrowheads land, and flow dots travel along each edge for the rest of the scene. |
| Camera | Zoom out ×40 → ×1 (1.60–2.40), then drift ×1.00 → ×1.02. |
| Text | **One canvas.** (2.70) **The whole film.** (2.90) |
| Cut | None. Continuous into S03. |
| Sound | Falling whoosh 1.60–2.15. Eight soft pops, ascending pentatonic, with the nodes. Edge shimmer 2.25–3.05. Pulse. |

### S03 · Scoped control · 3.60–5.20

| | |
| --- | --- |
| Picture | Same canvas. The headline slides out (3.60–3.80). A composer bar rises at the bottom of the frame (3.60–3.90). A cursor enters from the right. |
| State changes | 3.80 click on *Video generation · Shot 02*: mint selection ring and glow; the composer shows a mint pill **1 node** and the placeholder *Describe the change for the selected node…* 4.20–4.60 the cursor drags a marquee (dashed mint, 8 % fill) across *Reference clip*, *Previs · Shot 02* and *Video generation*; each node rings as the marquee reaches it; at 4.60 the pill rolls to **3 nodes**. |
| Camera | Slow push ×1.02 → ×1.06 toward the selection. |
| Text | **You set the scope.** (4.40) |
| Cut | **Whip pan left at 5.20.** |
| Sound | Click 3.80. Marquee hiss 4.20–4.60. Tick 4.60. Pulse. |

### S04 · Image editing · 5.20–6.80

| | |
| --- | --- |
| Picture | 5.20–5.40 the canvas whips out to the left with horizontal motion blur and the image editor (1500 × 720 panel, tool rail on the left, Brush active) whips in from the right. The viewport holds the *Hero car still*: sedan on the wet pier, two sodium lamps, cranes on the horizon, rain. |
| State changes | 5.40–5.80 three brush strokes mask the warehouse wall (mint 35 % overlay, soft edge). 5.85–6.00 only the masked region changes: a cool neon tube and a lamp come on inside the mask; every pixel outside the mask stays identical. 6.00 / 6.20 / 6.40 / 6.60 four hard cuts inside the viewport, each with a mono chip: `LIGHTING` (sodium → cool), `NEW ANGLE` (low rear three-quarter), `PANORAMA` (viewport widens to 2.4:1), `GRID SPLIT` (2 × 2 crops). |
| Camera | Whip in, then drift ×1.00 → ×1.02. |
| Text | **Change only what matters.** (5.95) |
| Cut | **Hard cut at 6.80.** |
| Sound | Whip whoosh panned left → right 5.20. Three brush swishes. Soft bloom 5.85. Four shutter clicks on eighth notes 6.00–6.60. Pulse. |

### S05 · 3D previs · 6.80–8.40

| | |
| --- | --- |
| Picture | Blockout viewport (dark panel 1500 × 720). White-model set: pier slab, container stacks, two lamp posts, a crane base. |
| State changes | A mannequin runs along the pier (procedural gait) and ducks at 7.60. A blockout sedan drives past right → left (6.90–8.30). A virtual camera (body + frustum) arcs around them for the whole shot. 7.60–8.00 a wipe moves left → right turning `RGB` into `DEPTH` (grey by distance). 8.00–8.40 a second wipe turns `DEPTH` into `NORMAL` (camera-space normals). The wipe line carries the layer name. |
| Camera | Viewer camera orbits slowly the whole shot. |
| Text | Chips: `PREVIS / DEPTH REFERENCE` (top-left), `SHOT 02 · TAKE 3 · CAM B` (bottom-left), button *Freeze as shot reference* (bottom-right). |
| Cut | **Hard cut at 8.40.** |
| Sound | Accent 6.80. Car pass-by (filtered noise, pitch bend) 6.90–8.10. Two wipe swishes 7.60, 8.00. Pulse. |

### S06 · Footage analysis · 8.40–9.60

| | |
| --- | --- |
| Picture | A player holds the *Reference clip* (performer running along the pier, sedan passing) with a filmstrip bar under it. |
| State changes | 8.45–8.70 three boundary markers pop onto the strip at detected cuts; the segments separate into `S1`–`S4` and the picture changes angle at each boundary as the clip scrubs. 8.70–9.15 a pose skeleton (mint joints and bones) locks onto the performer and tracks the run; sparse mint arrows show 2D camera motion; chips `POSE TRACK` and `2D CAMERA MOTION`. 9.10–9.60 the picture becomes a relative depth pass (top → bottom wipe), chip `RELATIVE DEPTH`. |
| Camera | Drift ×1.00 → ×1.02. |
| Text | **Read every frame.** (8.60) |
| Cut | **Hard cut at 9.60.** |
| Sound | Accent 8.40. Three ticks 8.50 / 8.56 / 8.62. Lock click 8.75. Depth swoosh 9.10. Pulse. |

### S07 · Generation plan · 9.60–10.80

| | |
| --- | --- |
| Picture | A plan card (1100 × 560) drops in: *Generation plan · Shot 02*; the compiled prompt in mono; a reference row with three thumbnails and their roles: `identity` (hero car still), `composition` (previs RGB), `motion` (reference clip); footer `Provider · configured by you` and `Cost · billed by provider`; button *Generate 3 candidates*. |
| State changes | 10.00 the button is clicked. 10.05–10.40 the card compresses upward and three candidate tiles slide into place (0.10 s stagger), each badged `Pending review`. |
| Camera | Drift. |
| Text | **See the plan first.** (9.80) |
| Cut | **Continuous push-in at 10.80.** |
| Sound | Accent 9.60. Click 10.00. Three pops 10.10 / 10.20 / 10.30. Pulse. |

### S08 · Review and edit · 10.80–12.40

| | |
| --- | --- |
| Picture | 10.80–11.00 push into candidate 2, which becomes the review panel: clip on the left, checklist on the right. |
| State changes | 10.95–11.35 the six checks resolve one every 0.08 s: Direction, Action, Identity, Continuity pass (mint check); **Unexpected cuts** fails (graphite ✕); Deformation / branding passes. The note field types `cut at 2.1 s`. 11.40 the status pill becomes **Rejected · kept**; the clip stays in the project. 11.45–11.70 a four-shot timeline rises; shots 01, 03 and 04 carry lock icons and never move; shot 02 slides out and candidate 3 slides into its slot. 11.90–12.05 an audio track slides in under the video track. 12.10–12.40 the playhead sweeps left → right and lands on **Export**, which lights mint at 12.40. |
| Camera | Push in, then drift. |
| Text | **Replace one shot. Keep the rest.** (11.55) |
| Cut | **Hard cut to white at 12.40.** |
| Sound | Accent and push whoosh 10.80. Six ticks, the fail a lower thud. Flip click 11.40. Replace whoosh 11.50. Audio slide 11.90. Rising sweep 12.10–12.40. Click 12.40. Pulse stops. |

### S09 · End card · 12.40–15.00

| | |
| --- | --- |
| Picture | Off-white. |
| State changes | **Your agent.** (12.40) **Your canvas.** (12.60) **Your film.** (12.80) stack in the centre. 13.20 the lines lift to make room and the OpenCinema logo lands below them (scale 1.06 → 1, fade, 0.25 s). 13.24 `Local workbench · MIT open source` and `github.com/junjamrk/OpenCinema` fade in. |
| Camera | Static. |
| Hold | Card complete at 13.45 and untouched until 15.00: **1.55 s.** |
| Sound | The cut accent lands with line one at 12.40; soft taps for lines two and three at 12.60 / 12.80. One clean final hit 13.20 with a 1.6 s tail. Silence by 14.90. |

## Sound cue sheet

All sound is synthesised in `sound.py` with NumPy. There is no voiceover, no music and no sampled material.

| Cue | Synthesis | Times (s) |
| --- | --- | --- |
| Pulse | Sine 110 → 48 Hz over 30 ms, 140 ms exponential decay, soft clip, low-pass | every 0.40 from 0.40 to 12.00 |
| Cut accent | Pulse + 60 ms band-passed noise impact + short falling whoosh | 1.60 3.60 5.20 6.80 8.40 9.60 10.80 12.40 |
| Keystroke | 3 ms noise burst + 2–3 kHz ping, random detune | 0.15–1.05, 27 keys |
| UI click | 4 ms noise burst + 2.6 kHz ping | 1.20 3.80 4.60 8.75 10.00 11.40 12.40 |
| Whoosh | Band-passed noise, centre frequency sweep, asymmetric envelope, stereo pan | 1.28↑ 1.60↓ 5.20 (L→R) 10.80↑ 11.50 12.10–12.40↑ |
| Node pops | Short sine pings, ascending pentatonic | 1.85–2.45 (8) 10.10 10.20 10.30 (3) |
| Edge shimmer | Quiet high-passed noise with slow sweep | 2.25–3.05 |
| Marquee / brush | Soft filtered noise following the gesture | 4.20–4.60; 5.40 5.55 5.70 |
| Shutter clicks | Two-part click (down/up) | 6.00 6.20 6.40 6.60 |
| Car pass-by | Low filtered noise with pitch bend and pan | 6.90–8.10 |
| Wipe swish | Short high noise sweep | 7.60 8.00 9.10 |
| Check ticks | Short pings; the fail is a 180 Hz thud | 10.95–11.35 (6) |
| End taps | Muted pulse, −8 dB | 12.60 12.80 |
| Final hit | 72 → 44 Hz sub, 1.8 s decay + noise impact + synthetic reverb tail | 13.20 |

Master: look-ahead limiter with a −1 dBFS ceiling, integrated loudness normalised to −16 LUFS.

## Accuracy checklist

| Rule | How the film complies |
| --- | --- |
| No free access to every video model via Codex or Claude | Agents are named only as the ones giving direction. The plan card says `Provider · configured by you` and `Cost · billed by provider`. |
| Generation uses the user's own provider and may cost money | Same plan card footer. |
| Blockout is a reference, not strict control | Labelled `PREVIS / DEPTH REFERENCE`; the action is *Freeze as shot reference*. No wording about control. |
| Motion analysis is pose + 2D camera motion | Chips read `POSE TRACK` and `2D CAMERA MOTION`. No 3D solve is shown or named. |
| Review is a recorded decision | A person ticks each check; one check fails with a typed observation; the status becomes *Rejected · kept*. Nothing is auto-approved. |
| 0.4.0 is unreleased | No "available now" or "download now". The end card says `Local workbench · MIT open source` and gives the repository. |
| Plain-text agent names, no third-party logos | `Codex · Claude Code · Any MCP agent` as text only. |
| No customers, testimonials, metrics, awards or private data | None appear. The only numbers are the fictional project's shot and take numbers. |
| No shot claimed to be from a video model | Every picture is drawn procedurally; candidates are labelled `Pending review`, never attributed to a model. |

## Brand mark

The logo was redesigned in this task at the user's request. The new mark is a rounded frame open on the right, a "C" for cinema that also reads as a shot frame and a node, with a mint output port sitting in the opening. The wordmark is Inter SemiBold with tight tracking. Files under `assets/brand/` keep their names and pixel sizes (`logoLight.png` and `logoDark.png` 3072 × 800, `markLogo.png` 1024 × 1024, `logo.svg`, `markLogo.svg`, plus a new `logoDark.svg`) so the readme and any consumer keep working. Vector sources contain outlined text and need no fonts installed; `buildLogo.py` and `rasterize.mjs` next to them regenerate everything.

## Deliverable

MP4, 1920 × 1080, 60 fps, H.264 High profile, `yuv420p`, BT.709, AAC 48 kHz stereo 192 kb/s, 15.000 s, `+faststart`.

Build and verification steps are in [`assets/promo/launchVideo/readme.md`](../assets/promo/launchVideo/readme.md). The readability, overlap and end-card-hold checks are recorded there after each render.
