// Frame renderer: drives scene.html through Chromium, one deterministic
// seek() per sub-frame, pipes PNG frames into ffmpeg.
//
//   node render.mjs --out film.mp4 [--audio sound.wav] [--fps 60] [--samples 4]
//                  [--shutter 0.5] [--start 0] [--end 15] [--crf 16] [--scale 1]
//   node render.mjs --stills "0.5,1.2,3.0" --stillsDir frames/   (PNG stills)
//
// With --samples N, N sub-frames spanning `shutter` of a frame interval are
// averaged by ffmpeg's tmix filter, which gives true motion blur.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
  return acc;
}, []));
const fps = Number(args.fps || 60);
const samples = Number(args.samples || 1);
const shutter = Number(args.shutter || 0.5);
const start = Number(args.start || 0);
const end = Number(args.end || 15);
const scale = Number(args.scale || 1);
const crf = Number(args.crf || 16);
const W = Math.round(1920 * scale), H = Math.round(1080 * scale);

const browser = await chromium.launch({ args: ["--font-render-hinting=none", "--disable-lcd-text"] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => { console.error("page error:", e.message); });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.error("console:", m.text()); });
await page.goto(pathToFileURL(path.join(here, "scene.html")).href);
await page.waitForFunction(() => window.sceneReady === true, null, { timeout: 30000 });
if (scale !== 1) await page.evaluate((s) => { document.documentElement.style.setProperty("--scale", String(s)); }, scale);

async function frame(t) {
  await page.evaluate((tt) => window.seek(tt), t);
  return page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
}

if (args.stills) {
  const dir = args.stillsDir || path.join(os.tmpdir(), "launchVideoStills");
  fs.mkdirSync(dir, { recursive: true });
  for (const s of args.stills.split(",")) {
    const t = Number(s);
    const buf = await frame(t);
    const name = path.join(dir, `t${t.toFixed(3).replace(".", "_")}.png`);
    fs.writeFileSync(name, buf);
    console.log("wrote", name);
  }
  await browser.close();
  process.exit(0);
}

const out = args.out || path.join(here, "film.mp4");
const total = Math.round((end - start) * fps);
const inRate = fps * samples;
const vf = [];
if (samples > 1) vf.push(`tmix=frames=${samples}:weights='${Array(samples).fill(1).join(" ")}'`, `select='eq(mod(n\\,${samples})\\,${samples - 1})'`, `setpts=N/(${fps}*TB)`);
if (scale !== 1) vf.push("scale=1920:1080:flags=lanczos");
vf.push("format=yuv420p");
const ff = [
  "-y", "-hide_banner", "-loglevel", "error", "-stats",
  "-f", "image2pipe", "-framerate", String(inRate), "-i", "pipe:0",
];
if (args.audio) ff.push("-i", args.audio);
ff.push("-vf", vf.join(","), "-r", String(fps),
  "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-profile:v", "high", "-level", "4.2", "-pix_fmt", "yuv420p",
  "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
  "-movflags", "+faststart");
if (args.audio) ff.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
ff.push("-t", String(end - start), out);
const enc = spawn("ffmpeg", ff, { stdio: ["pipe", "inherit", "inherit"] });
const done = new Promise((res, rej) => enc.on("exit", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`)))));

const t0 = Date.now();
for (let i = 0; i < total; i++) {
  for (let k = 0; k < samples; k++) {
    const t = start + (i + (k / samples) * shutter) / fps;
    const buf = await frame(t);
    if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once("drain", r));
  }
  if (i % 60 === 0) {
    const el = (Date.now() - t0) / 1000;
    process.stderr.write(`\nframe ${i}/${total}  ${el.toFixed(0)}s elapsed, ~${((el / Math.max(1, i)) * (total - i)).toFixed(0)}s left\n`);
  }
}
enc.stdin.end();
await done;
await browser.close();
console.log(`\nwrote ${out} (${total} frames @ ${fps} fps, ${samples} samples/frame)`);
