// Render the Open Graph image (1200×630) with Chromium.
//   node site/og.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const logo = fs.readFileSync(path.join(here, "assets/img/logo.svg"), "utf8");
const canvas = fs.readFileSync(path.join(here, "assets/img/canvas.webp")).toString("base64");
const inter = fs.readFileSync(path.join(here, "assets/fonts/inter-latin-wght-normal.woff2")).toString("base64");
const mono = fs.readFileSync(path.join(here, "assets/fonts/jetbrains-mono-latin-wght-normal.woff2")).toString("base64");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Inter;font-weight:100 900;src:url(data:font/woff2;base64,${inter}) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-weight:100 800;src:url(data:font/woff2;base64,${mono}) format("woff2")}
html,body{margin:0;width:1200px;height:630px;background:#F7F7F4;font-family:Inter,sans-serif;color:#101315;overflow:hidden}
.logo{position:absolute;left:72px;top:64px;height:44px}
.logo svg{height:44px;width:auto}
.title{position:absolute;left:72px;top:150px;font-size:76px;font-weight:600;letter-spacing:-.035em;line-height:1}
.sub{position:absolute;left:72px;top:418px;width:520px;font-size:24px;line-height:1.4;color:rgba(16,19,21,.64)}
.tag{position:absolute;left:72px;top:532px;width:560px;white-space:nowrap;font-family:"JetBrains Mono",monospace;font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:rgba(16,19,21,.5)}
.tag b{color:#15756A;font-weight:500}
.shot{position:absolute;left:660px;top:120px;width:760px;border-radius:18px;overflow:hidden;background:#121316;box-shadow:0 40px 90px rgba(16,19,21,.22);border:1px solid rgba(255,255,255,.06)}
.bar{height:34px;background:#1A1D23;display:flex;align-items:center;gap:7px;padding:0 14px}
.bar i{width:10px;height:10px;border-radius:50%;background:#343941;display:block}.bar i:first-child{background:#4FDBC8}
.shot img{display:block;width:100%}
</style></head><body>
<div class="logo">${logo}</div>
<div class="title">Your agent.<br>Your canvas.<br>Your film.</div>
<div class="sub">A local, open-source video workbench your agent operates.</div>
<div class="tag"><b>opencinema.site</b> · MIT · Codex · Claude Code · MCP</div>
<div class="shot"><div class="bar"><i></i><i></i><i></i></div><img src="data:image/webp;base64,${canvas}"></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(here, "assets/img/og.png"), type: "png" });
await browser.close();
console.log("wrote assets/img/og.png");
