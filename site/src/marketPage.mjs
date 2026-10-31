// Renders one language of the plugin market page from the strings table and the generated index.
// Pure function: (strings, index, assetsVersion) → HTML. Same visual system as the landing page.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const REPO = "https://github.com/junjamrk/OpenCinema";
const SITE = "https://opencinema.site";
const icons = {
  arrow: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  github: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z"/></svg>',
  download: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9m0 0l-3.5-3.5M10 12l3.5-3.5M4 15.5h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  box: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5l7 3.8v7.4l-7 3.8-7-3.8V6.3z M3 6.3l7 3.8 7-3.8 M10 10.1v7.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};
const mib = (n) => `${(n / 1024 ** 2).toFixed(2)} MiB`;

export function renderMarketPage(t, index, v) {
  const m = t.market;
  const lang = t.lang === "en" ? "en" : "zh-CN";
  const dir = `${t.dir}market/`;
  const url = `${SITE}/${dir}`;
  const alt = t.otherLang;
  const altHref = `${alt.href}market/`;
  const jsonLd = {
    "@context": "https://schema.org", "@type": "CollectionPage", name: m.metaTitle, url, description: m.metaDescription, isPartOf: { "@type": "WebSite", name: "OpenCinema", url: SITE },
    hasPart: index.plugins.map((p) => ({ "@type": "SoftwareApplication", name: p.name, softwareVersion: p.version, applicationCategory: "MultimediaApplication", license: p.license, author: p.author, description: p.description[lang] ?? p.description.en, downloadUrl: `${SITE}/market/${p.url}` })),
  };
  const card = (p) => `<article class="pluginCard reveal">
      <div class="pluginCardHead">
        <span class="pluginIcon" aria-hidden="true">${icons.box}</span>
        <div><h3>${esc(p.displayName?.[lang] ?? p.name)}</h3><p class="mono pluginId">${esc(p.id)} · v${esc(p.version)}</p></div>
      </div>
      <p class="pluginDesc">${esc(p.description[lang] ?? p.description.en)}</p>
      <ul class="tagRow">${p.tags.map((tag) => `<li>${esc(tag)}</li>`).join("")}${p.agentGuide ? `<li class="tagMint">${icons.check}${esc(m.agentGuide)}</li>` : ""}</ul>
      <dl class="pluginMeta">
        <div><dt>${esc(m.size)}</dt><dd>${mib(p.size)}</dd></div>
        <div><dt>${esc(m.requires)}</dt><dd>${Object.keys(p.requires).map(esc).join(", ") || "—"}</dd></div>
        <div><dt>License</dt><dd>${esc(p.license || "—")} · ${esc(p.author)}</dd></div>
        <div><dt>SHA-256</dt><dd class="mono sha" title="${esc(p.sha256)}">${esc(p.sha256.slice(0, 16))}…</dd></div>
      </dl>
      <div class="pluginActions">
        <a class="btn btnInk btnSm" href="/market/${esc(p.url)}" download="${esc(p.id)}-${esc(p.version)}.install.json">${icons.download}<span>${esc(m.installJson)}</span></a>
        ${p.homepage ? `<a class="btn btnGhost btnSm" href="${esc(p.homepage)}" rel="noopener">${esc(m.readme)}</a>` : ""}
        ${p.repository ? `<a class="textLink" href="${esc(p.repository)}" rel="noopener">${esc(m.source)} ${icons.arrow}</a>` : ""}
      </div>
    </article>`;
  return `<!doctype html>
<html lang="${t.lang}" class="noJs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.metaTitle)}</title>
<meta name="description" content="${esc(m.metaDescription)}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="en" href="${SITE}/market/">
<link rel="alternate" hreflang="zh-CN" href="${SITE}/zh/market/">
<link rel="alternate" hreflang="x-default" href="${SITE}/market/">
<link rel="alternate" type="application/json" href="${SITE}/market/index.json" title="${esc(m.indexNote)}">
<meta name="theme-color" content="#F7F7F4">
<meta name="color-scheme" content="light">
<meta property="og:type" content="website">
<meta property="og:site_name" content="OpenCinema">
<meta property="og:title" content="${esc(m.metaTitle)}">
<meta property="og:description" content="${esc(m.metaDescription)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/assets/img/og.png?v=${v}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/img/mark.svg" type="image/svg+xml">
<link rel="icon" href="/assets/img/icon32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/assets/img/icon180.png">
<link rel="preload" href="/assets/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/site.css?v=${v}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav" id="nav">
  <div class="wrap navRow">
    <a class="brand" href="/${t.dir}" aria-label="OpenCinema"><img src="/assets/img/logo.svg" alt="OpenCinema" width="151" height="40"></a>
    <nav class="navLinks" aria-label="Primary">
      <a href="/${t.dir}#features">${esc(t.nav.features)}</a>
      <a href="/${t.dir}#how">${esc(t.nav.how)}</a>
      <a href="/${dir}" aria-current="page">${esc(t.nav.market)}</a>
      <a href="${REPO}#readme" rel="noopener">${esc(t.nav.docs)}</a>
    </nav>
    <div class="navActions">
      <a class="lang" href="${altHref}" lang="${alt.code}" hreflang="${alt.code}">${esc(alt.label)}</a>
      <a class="iconLink" href="${REPO}" rel="noopener" aria-label="GitHub">${icons.github}<span class="stars" data-stars hidden></span></a>
      <a class="btn btnInk btnSm" href="/${t.dir}#start">${esc(t.nav.cta)}</a>
    </div>
  </div>
</header>

<main id="main">
  <section class="hero heroCompact">
    <div class="wrap heroText">
      <p class="eyebrow mono reveal">${esc(m.eyebrow)}</p>
      <h1 class="heroTitle reveal"><span class="line" style="--i:0">${esc(m.title)}</span></h1>
      <p class="lede reveal">${esc(m.lede)}</p>
    </div>
  </section>

  <section class="how marketHow">
    <div class="wrap">
      <p class="label mono reveal">${esc(m.stepsLabel)}</p>
      <ol class="steps stepsText">
        ${m.steps.map((s) => `<li class="step reveal"><p class="mono stepN">${esc(s.n)}</p><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></li>`).join("")}
      </ol>
    </div>
  </section>

  <section class="plugins" id="plugins">
    <div class="wrap">
      <p class="label mono reveal">${esc(m.listLabel)} · ${index.plugins.length}</p>
      <h2 class="h2 reveal">${esc(m.listTitle)}</h2>
      <div class="marketGrid">${index.plugins.length ? index.plugins.map(card).join("") : `<p class="sectionLede reveal">${esc(m.empty)}</p>`}</div>
      <p class="indexLink reveal mono"><a href="/market/index.json">${esc(m.indexNote)} · /market/index.json</a> · <a href="${esc(m.schemaHref)}" rel="noopener">${esc(m.schema)}</a></p>
    </div>
  </section>

  <section class="start" id="publish">
    <div class="wrap">
      <p class="label mono reveal">${esc(m.publishLabel)}</p>
      <h2 class="h2 reveal">${esc(m.publishTitle)}</h2>
      <p class="sectionLede reveal">${esc(m.publishText)}</p>
      <div class="codeGrid codeGridSingle">
        <div class="codeCard reveal">
          <p class="mono codeTitle">${esc(m.publishCodeTitle)}</p>
          <pre><code>${esc(m.publishCode)}</code></pre>
          <p class="codeNote">${esc(m.publishNote)}</p>
        </div>
      </div>
      <ul class="docLinks reveal">
        <li><a href="${esc(m.guideHref)}" rel="noopener">${esc(m.guide)} ${icons.arrow}</a></li>
        <li><a href="${REPO}/blob/main/packages/nodeScaffold/readme.md" rel="noopener">Node SDK ${icons.arrow}</a></li>
        <li><a href="${REPO}/blob/main/contributing.md" rel="noopener">${esc(m.contributing)} ${icons.arrow}</a></li>
      </ul>
    </div>
  </section>

  <section class="honest">
    <div class="wrap"><ul class="honestList mono">${m.honest.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
  </section>
</main>

<footer class="footer">
  <div class="wrap footerGrid">
    <div class="footerBrand">
      <img src="/assets/img/logo.svg" alt="OpenCinema" width="151" height="40">
      <p>${esc(t.footer.tagline)}</p>
      <a class="lang" href="${altHref}" lang="${alt.code}" hreflang="${alt.code}">${esc(alt.label)}</a>
    </div>
    ${t.footer.columns.map((c) => `<div class="footerCol"><p class="mono">${esc(c.title)}</p><ul>${c.links.map((l) => `<li><a href="${l.href}" rel="noopener">${esc(l.label)}</a></li>`).join("")}</ul></div>`).join("")}
  </div>
  <div class="wrap footerLegal">
    <p>${esc(t.footer.license)}</p>
    <p>© <span data-year></span> ${esc(t.footer.copyright)}</p>
  </div>
</footer>
<script src="/assets/site.js?v=${v}" defer></script>
</body>
</html>
`;
}
