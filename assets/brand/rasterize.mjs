// Rasterise the brand SVGs to the committed PNG sizes with Chromium.
//   node assets/brand/rasterize.mjs
// Writes logoLight.png (3072×800), logoDark.png (3072×800), markLogo.png (1024×1024)
// next to this file, all with transparent backgrounds.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

// Playwright is installed globally in the render environment; ESM resolution cannot see it.
const { chromium } = createRequire(import.meta.url)("playwright");

const here = path.dirname(fileURLToPath(import.meta.url));
const jobs = [
  { svg: "logo.svg", png: "logoLight.png", width: 3072, height: 800 },
  { svg: "logoDark.svg", png: "logoDark.png", width: 3072, height: 800 },
  { svg: "markLogo.svg", png: "markLogo.png", width: 1024, height: 1024 },
];

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const page = await browser.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
    // Inline the SVG: a page created with setContent cannot load file:// images.
    const svg = fs.readFileSync(path.join(here, job.svg), "utf8");
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">` +
        `<div style="width:${job.width}px;height:${job.height}px">${svg}</div></body></html>`,
    );
    await page.screenshot({ path: path.join(here, job.png), omitBackground: true, type: "png" });
    await page.close();
    console.log(`wrote ${job.png} ${job.width}×${job.height}`);
  }
} finally {
  await browser.close();
}
