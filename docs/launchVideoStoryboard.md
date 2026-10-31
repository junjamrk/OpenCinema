# OpenCinema launch film · storyboard

A 30-second, Apple-style launch film for the OpenCinema workbench. This document is the plan the film was built from: shot list, timing grid, on-screen text, camera moves, transitions, and the sound cue sheet. Sources and the build pipeline live in [`assets/promo/launchVideo/`](../assets/promo/launchVideo/readme.md); the rendered film is [`assets/promo/openCinemaLaunch.mp4`](../assets/promo/openCinemaLaunch.mp4).

## Decisions made before building

- **Duration: 30.0 s.** The brief asked for a 15-second film. The first cut was built to that length and felt too fast in review; a 25-second cut fixed the first half, and the second half was then given more room again. The schedule below keeps each action as quick as before and lengthens the holds: readers get 1.0–3.2 s with every headline.
- **One timing grid.** Every cut lands on a beat of a 120 BPM pulse (one beat = 0.50 s), so picture and sound never drift apart.
- **One fictional project throughout:** *Harbor Chase*. A rainy-night car chase at a container harbor. The shot being fixed is always Shot 02. Every picture in the film (stills, clips, candidates, depth passes, previs) is drawn procedurally in code for this film. No photographs, no stock, and nothing produced by a video generation model.
- **Live state only.** Every interface element is a real DOM or canvas element whose state is a function of time. There are no screenshots and no pans over static images.
- **Logo.** The brand mark was redesigned during this task (see [Brand mark](#brand-mark)). The end card uses `assets/brand/logoLight.png` exactly as committed.

### Brief guide vs. final timings

| Scene | Brief (15 s) | Final (30 s) | Length |
| --- | --- | --- | --- |
| Hook: agent | 0.0–1.5 | 0.0–2.5 | 2.5 s |
| Node canvas | 1.5–3.5 | 2.5–5.5 | 3.0 s |
| Scoped control | 3.5–5.0 | 5.5–8.5 | 3.0 s |
| Image editing | 5.0–6.8 | 8.5–12.0 | 3.5 s |
| 3D previs | 6.8–8.8 | 12.0–15.5 | 3.5 s |
| Footage analysis | 8.8–10.2 | 15.5–19.0 | 3.5 s |
| Generation plan | 10.2–11.4 | 19.0–23.0 | 4.0 s |
| Review and edit | 11.4–13.0 | 23.0–27.5 | 4.5 s |
| End card | 13.0–15.0 | 27.5–30.0 | 2.5 s (complete card holds 1.55 s) |

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

Headlines land word by word (rise 36 px, blur 10 px → 0, 0.32 s each, 0.06–0.10 s stagger). The headline zone is the bottom-left 820 × 220 px; interface panels never enter it.

## Shot list

Times are seconds from the first frame. "Cut" is the transition out of the shot.

### S01 · Hook: agent · 0.00–2.50

| | |
| --- | --- |
| Picture | Off-white world. A project chip, `HARBOR CHASE · NIGHT · SHOT 02`, fades in top-left (0.05–0.40). An oversized composer panel (dark graphite, 1480 × 200) rises into the centre (0.00–0.55). |
| State changes | 0.20–1.28 the prompt types itself, one character per 40 ms: **Make the chase feel faster.** A caret blinks, and the finished prompt holds until 2.00. 2.00 the mint send button is pressed: scales 0.9 → 1.0, a mint ring expands out of it. |
| Camera | 2.10–2.50 push in on the send button, ×1 → ×60. Mint fills the frame by 2.45. |
| Text | Prompt as above. Small label under the panel: `Codex · Claude Code · Any MCP agent` (fades in 0.30). |
| Cut | **Match cut on a full-mint frame at 2.50.** |
| Sound | Pulse starts on beat 1 (0.50). Keystroke ticks per character. UI click 2.00. Rising whoosh 2.08–2.50. |

### S02 · Node canvas · 2.50–5.50

| | |
| --- | --- |
| Picture | The mint frame is the body glow of the text node at ×40. The node cools from mint to graphite and its content fades in (2.52–2.92) while the camera zooms out. |
| State changes | 2.80–4.07 seven more nodes spring into place (scale 0.7 → 1, 30 px rise, 0.12 s stagger): Image *Hero car still*, Video *Reference clip*, Image generation *Frame · Shot 02*, Audio *Rain + engine bed*, Blockout *Previs · Shot 02*, Video generation *Shot 02 · candidates*, Edit plan *Cut · 4 shots*. 3.30–4.50 mint connections draw source → target (dash offset, 0.10 s stagger), arrowheads land, and flow dots travel along each edge for the rest of the scene. Thumbnails are live: the reference clip plays, the previs loops, the waveform scrubs. |
| Camera | Zoom out ×40 → ×1 (2.50–3.40), then drift ×1.00 → ×1.02. |
| Text | **One canvas.** (3.80) **The whole film.** (4.10). Holds until 5.50. |
| Cut | None. Continuous into S03. |
| Sound | Falling whoosh 2.50–3.10. Eight soft pops, ascending pentatonic, with the nodes. Edge shimmer 3.30–4.50. Pulse. |

### S03 · Scoped control · 5.50–8.50

| | |
| --- | --- |
| Picture | Same canvas. The headline slides out (5.50–5.75). A composer bar rises at the bottom of the frame (5.50–6.00). A cursor enters from the right. |
| State changes | 5.80 click on *Video generation · Shot 02*: mint selection ring and glow; the composer shows a mint pill **1 node** and the placeholder *Describe the change for the selected node…* The selection holds until 6.40. 6.70–7.30 the cursor drags a marquee (dashed mint, 8 % fill) across *Reference clip*, *Previs · Shot 02* and *Video generation*; each node rings as the marquee reaches it; the pill rolls 1 → 2 → **3 nodes** by 7.28. |
| Camera | Slow push ×1.02 → ×1.045 toward the selection. |
| Text | **You set the scope.** (6.90). Holds until 8.50. |
| Cut | **Whip pan left at 8.50.** |
| Sound | Click 5.80. Marquee hiss 6.70–7.30. Tick 7.25. Pulse. |

### S04 · Image editing · 8.50–12.00

| | |
| --- | --- |
| Picture | 8.50–8.75 the canvas whips out to the left with horizontal motion blur and the image editor (1500 × 720 panel, tool rail on the left, Brush active) whips in from the right. The viewport holds the *Hero car still*: sedan on the wet pier, sodium lamps, cranes on the horizon, rain. |
| State changes | 8.80–9.38 three brush strokes mask the warehouse wall (mint 35 % overlay, soft edge). 9.45–9.70 only the masked region changes: a cool neon tube and a lamp come on inside the mask; every pixel outside the mask stays identical. The result holds until 10.00. Then four hard cuts inside the viewport, one per beat, each with a mono chip: 10.00 `LIGHTING` (sodium → cool), 10.50 `NEW ANGLE` (low rear three-quarter), 11.00 `PANORAMA` (viewport widens to 2.4:1), 11.50 `GRID SPLIT` (2 × 2 crops), which holds until 12.00. |
| Camera | Whip in, then drift ×1.00 → ×1.02. |
| Text | **Change only what matters.** (9.50). Holds until 12.00. |
| Cut | **Hard cut at 12.00.** |
| Sound | Whip whoosh panned left → right 8.49. Three brush swishes. Soft bloom 9.45. Four shutter clicks on the beats 10.00–11.50. Pulse. |

### S05 · 3D previs · 12.00–15.50

| | |
| --- | --- |
| Picture | Blockout viewport (dark panel 1500 × 720). White-model set: pier slab, container stacks, two lamp posts, a crane base. |
| State changes | A mannequin runs along the pier (procedural gait) for the first 1.65 s, ducks from 13.60 to 14.45 and walks on. A blockout sedan drives past right → left (12.15–14.60). A virtual camera (body + frustum) arcs around them for the whole shot. The RGB view holds until 14.50. 14.50–15.00 a wipe moves left → right turning `RGB` into `DEPTH` (grey by distance). 15.00–15.50 a second wipe turns `DEPTH` into `NORMAL` (camera-space normals). The wipe line carries the layer name. |
| Camera | Viewer camera orbits slowly the whole shot. |
| Text | Chips: `PREVIS / DEPTH REFERENCE` (top-left), `SHOT 02 · TAKE 3 · CAM B` (bottom-left), button *Freeze as shot reference* (bottom-right). |
| Cut | **Hard cut at 15.50.** |
| Sound | Accent 12.00. Car pass-by (filtered noise, pitch bend) 12.15–14.60. Two wipe swishes 14.50, 15.00. Pulse. |

### S06 · Footage analysis · 15.50–19.00

| | |
| --- | --- |
| Picture | A player holds the *Reference clip* (performer running along the pier, sedan passing) with a filmstrip bar under it. |
| State changes | 15.60–16.15 three boundary markers pop onto the strip at detected cuts; the segments separate into `S1`–`S4` and the picture changes angle at each boundary as the clip scrubs. 16.20–16.95 a pose skeleton (mint joints and bones) locks onto the performer and tracks the run; from 17.00 sparse mint arrows show 2D camera motion; chips `POSE TRACK` and `2D CAMERA MOTION`. 18.10–18.70 the picture becomes a relative depth pass (top → bottom wipe), chip `RELATIVE DEPTH`. A side chip reads `NOT A 3D SOLVE`. |
| Camera | Drift ×1.00 → ×1.02. |
| Text | **Read every frame.** (15.80). Holds until 19.00. |
| Cut | **Hard cut at 19.00.** |
| Sound | Accent 15.50. Three ticks 15.60 / 15.75 / 15.90. Lock click 16.20. Depth swoosh 18.10. Pulse. |

### S07 · Generation plan · 19.00–23.00

| | |
| --- | --- |
| Picture | A plan card (1300 × 560) drops in (19.00–19.60): *Generation plan · Shot 02*; the compiled prompt in mono; a reference row with three thumbnails and their roles: `identity` (hero car still), `composition` (previs RGB), `motion` (reference clip); footer `Provider · configured by you` and `Cost · billed by provider`; button *Generate 3 candidates*. The card holds for reading until 21.00. |
| State changes | 21.00 the button is clicked. 21.05–21.45 the card compresses upward into a summary row and three candidate tiles slide into place (21.15, 21.30, 21.45), each badged `Pending review`. They hold until 22.75. |
| Camera | Drift, then push into candidate 2 from 22.75. |
| Text | **See the plan first.** (19.30). Leaves at 22.70. |
| Cut | **Continuous push-in at 22.75–23.00.** |
| Sound | Accent 19.00. Click 21.00. Three pops 21.15 / 21.30 / 21.45. Pulse. |

### S08 · Review and edit · 23.00–27.50

| | |
| --- | --- |
| Picture | 22.90–23.00 the pushed-in candidate 2 becomes the review panel: clip on the left, checklist on the right. |
| State changes | 23.10–24.15 the six checks resolve one every 0.15 s: Direction, Action, Identity, Continuity pass (mint check); **Unexpected cuts** fails (graphite ✕); Deformation / branding passes. 24.20–24.44 the note field types `cut at 2.1 s`. 24.60 the status pill becomes **Rejected · kept**; the clip stays in the project. 25.00–25.45 a four-shot timeline rises; shots 01, 03 and 04 carry lock icons and never move; 25.30–25.65 shot 02 slides out and candidate 3 slides into its slot. 26.20–26.50 an audio track slides in under the video track. 26.70–27.40 the playhead sweeps left → right and lands on **Export**, which lights mint at 27.45. |
| Camera | Settle from the push-in, then drift. |
| Text | **Replace one shot. Keep the rest.** (25.40). Holds until 27.50. |
| Cut | **Hard cut to white at 27.50.** |
| Sound | Push whoosh 22.73. Six ticks, the fail a lower thud. Flip click 24.60. Replace whoosh 25.30. Audio slide 26.20. Rising sweep 26.70–27.40. Click 27.45. Pulse stops; accent on the cut. |

### S09 · End card · 27.50–30.00

| | |
| --- | --- |
| Picture | Off-white. |
| State changes | **Your agent.** (27.50) **Your canvas.** (27.70) **Your film.** (27.90) stack in the centre. 28.20 the lines lift to make room and the OpenCinema logo lands below them (scale 1.06 → 1, fade, 0.25 s). 28.24 `Local workbench · MIT open source` and `github.com/junjamrk/OpenCinema` fade in. |
| Camera | Static. |
| Hold | Card complete at 28.45 and untouched until 30.00: **1.55 s.** |
| Sound | The cut accent lands with line one at 27.50; soft taps for lines two and three at 27.70 / 27.90. One clean final hit 28.20 with a 1.6 s tail. Silence by 29.90. |

## Sound cue sheet

All sound is synthesised in `sound.py` with NumPy. There is no voiceover, no music and no sampled material.

| Cue | Synthesis | Times (s) |
| --- | --- | --- |
| Pulse | Sine 110 → 48 Hz over 30 ms, 140 ms exponential decay, soft clip, low-pass | every 0.50 from 0.50 to 27.00 |
| Cut accent | Pulse + 60 ms band-passed noise impact + short falling whoosh | 2.50 5.50 8.50 12.00 15.50 19.00 23.00 27.50 |
| Keystroke | 3 ms noise burst + 2–3 kHz ping, random detune | 0.20–1.24, 27 keys |
| UI click | 4 ms noise burst + 2.6 kHz ping | 2.00 5.80 7.25 16.20 21.00 24.60 27.45 |
| Whoosh | Band-passed noise, centre frequency sweep, asymmetric envelope, stereo pan | 2.08↑ 2.50↓ 8.49 (L→R) 22.73↑ 25.30 26.70–27.40↑ |
| Node pops | Short sine pings, ascending pentatonic | 2.50–3.52 (8) 21.15 21.30 21.45 (3) |
| Edge shimmer | Quiet high-passed noise with slow sweep | 3.30–4.50 |
| Marquee / brush | Soft filtered noise following the gesture | 6.70–7.32; 8.80 8.98 9.16 |
| Shutter clicks | Two-part click (down/up) | 10.00 10.50 11.00 11.50 |
| Car pass-by | Low filtered noise with pitch bend and pan | 12.15–14.60 |
| Wipe swish | Short high noise sweep | 14.50 15.00 18.10 |
| Check ticks | Short pings; the fail is a 180 Hz thud | 23.10–23.85 (6) |
| End taps | Muted pulse, −8 dB | 27.70 27.90 |
| Final hit | 72 → 44 Hz sub, 1.8 s decay + noise impact + synthetic reverb tail | 28.20 |

Master: look-ahead limiter with a −1 dBFS ceiling, integrated loudness normalised to −16 LUFS.

## Accuracy checklist

| Rule | How the film complies |
| --- | --- |
| No free access to every video model via Codex or Claude | Agents are named only as the ones giving direction. The plan card says `Provider · configured by you` and `Cost · billed by provider`. |
| Generation uses the user's own provider and may cost money | Same plan card footer. |
| Blockout is a reference, not strict control | Labelled `PREVIS / DEPTH REFERENCE`; the action is *Freeze as shot reference*. No wording about control. |
| Motion analysis is pose + 2D camera motion | Chips read `POSE TRACK`, `2D CAMERA MOTION` and `NOT A 3D SOLVE`. |
| Review is a recorded decision | A person ticks each check; one check fails with a typed observation; the status becomes *Rejected · kept*. Nothing is auto-approved. |
| 0.4.0 is unreleased | No "available now" or "download now". The end card says `Local workbench · MIT open source` and gives the repository. |
| Plain-text agent names, no third-party logos | `Codex · Claude Code · Any MCP agent` as text only. |
| No customers, testimonials, metrics, awards or private data | None appear. The only numbers are the fictional project's shot and take numbers. |
| No shot claimed to be from a video model | Every picture is drawn procedurally; candidates are labelled `Pending review`, never attributed to a model. |

## Brand mark

The logo was redesigned in this task at the user's request. The new mark is a rounded frame open on the right, a "C" for cinema that also reads as a shot frame and a node, with a mint output port sitting in the opening. The wordmark is Inter SemiBold with tight tracking. Files under `assets/brand/` keep their names and pixel sizes (`logoLight.png` and `logoDark.png` 3072 × 800, `markLogo.png` 1024 × 1024, `logo.svg`, `markLogo.svg`, plus a new `logoDark.svg`) so the readme and any consumer keep working. Vector sources contain outlined text and need no fonts installed; `buildLogo.py` and `rasterize.mjs` next to them regenerate everything.

## Deliverable

MP4, 1920 × 1080, 60 fps, H.264 High profile, `yuv420p`, BT.709, AAC 48 kHz stereo 192 kb/s, 30.000 s, `+faststart`.

Build and verification steps are in [`assets/promo/launchVideo/readme.md`](../assets/promo/launchVideo/readme.md). The readability, overlap and end-card-hold checks are recorded there after each render.
