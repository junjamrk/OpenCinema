// Build the static landing page: site/index.html, site/zh/index.html, sitemap and robots.
//   node site/build.mjs
// Zero dependencies. The output is committed, so Vercel serves the folder as-is.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { renderPage } from "./src/page.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = "https://opencinema.site";

// cache-busting version: hash of every asset file
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const hash = createHash("sha256");
for (const f of walk(path.join(here, "assets")).sort()) hash.update(readFileSync(f));
const v = hash.digest("hex").slice(0, 10);

const langs = ["en", "zh"];
const pages = [];
for (const code of langs) {
  const t = JSON.parse(readFileSync(path.join(here, "src/i18n", `${code}.json`), "utf8"));
  const html = renderPage(t, v);
  const outDir = path.join(here, t.dir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "index.html"), html);
  pages.push(`${SITE}/${t.dir}`);
  console.log(`wrote ${path.relative(here, path.join(outDir, "index.html"))} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
}
const today = new Date().toISOString().slice(0, 10);
writeFileSync(path.join(here, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
  pages.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod>` +
    `<xhtml:link rel="alternate" hreflang="en" href="${SITE}/"/><xhtml:link rel="alternate" hreflang="zh-CN" href="${SITE}/zh/"/></url>`).join("\n") + `\n</urlset>\n`);
writeFileSync(path.join(here, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
console.log(`assets version ${v}`);
