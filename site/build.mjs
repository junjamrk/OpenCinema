// Build the static landing page: site/index.html, site/zh/index.html, sitemap and robots.
//   node site/build.mjs
// Zero dependencies. The output is committed, so Vercel serves the folder as-is.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { renderPage } from "./src/page.mjs";
import { renderMarketPage } from "./src/marketPage.mjs";
import { buildMarket } from "./buildMarket.mjs";

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

// the plugin market: copies built packages, writes market/index.json
const market = buildMarket();

const langs = ["en", "zh"];
const pages = [];
const write = (dir, html, loc, alternates) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.html"), html);
  pages.push({ loc, alternates });
  console.log(`wrote ${path.relative(here, path.join(dir, "index.html"))} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
};
for (const code of langs) {
  const t = JSON.parse(readFileSync(path.join(here, "src/i18n", `${code}.json`), "utf8"));
  write(path.join(here, t.dir), renderPage(t, v), `${SITE}/${t.dir}`, { en: `${SITE}/`, "zh-CN": `${SITE}/zh/` });
  write(path.join(here, t.dir, "market"), renderMarketPage(t, market, v), `${SITE}/${t.dir}market/`, { en: `${SITE}/market/`, "zh-CN": `${SITE}/zh/market/` });
}
const today = new Date().toISOString().slice(0, 10);
writeFileSync(path.join(here, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
  pages.map(({ loc, alternates }) => `  <url><loc>${loc}</loc><lastmod>${today}</lastmod>` +
    Object.entries(alternates).map(([lang, href]) => `<xhtml:link rel="alternate" hreflang="${lang}" href="${href}"/>`).join("") + `</url>`).join("\n") + `\n</urlset>\n`);
writeFileSync(path.join(here, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
console.log(`assets version ${v}`);
