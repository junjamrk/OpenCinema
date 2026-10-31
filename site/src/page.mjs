// Renders one language of the landing page from a strings table.
// Pure function: (strings, assets) → HTML. No runtime dependencies.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const REPO = "https://github.com/junjamrk/OpenCinema";
const SITE = "https://opencinema.site";
const IMG = {
  canvas: { w: 1600, h: 900 }, composerScope: { w: 1400, h: 320 }, imageEditor: { w: 1520, h: 978 }, mediaEditing: { w: 400, h: 675 },
  blockout: { w: 1600, h: 900 }, providers: { w: 540, h: 550 }, settingsAgent: { w: 540, h: 405 }, nodeMenu: { w: 440, h: 450 }, plugins: { w: 540, h: 740 },
};
const icons = {
  star: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.8l2.5 5.3 5.8.7-4.3 4 1.1 5.7L10 14.7l-5.1 2.8 1.1-5.7-4.3-4 5.8-.7z" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5v13l11-6.5z" fill="currentColor"/></svg>',
  arrow: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  github: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z"/></svg>',
  close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

function img(name, alt, { lazy = true, sizes = "(min-width: 1100px) 1100px, 100vw", cls = "" } = {}, v) {
  const m = IMG[name];
  return `<img class="${cls}" src="/assets/img/${name}.webp?v=${v}" width="${m.w}" height="${m.h}" alt="${esc(alt)}" ${lazy ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async" sizes="${sizes}">`;
}

export function renderPage(t, v) {
  const url = `${SITE}/${t.dir}`;
  const alt = t.otherLang;
  const altUrl = `${SITE}${alt.href}`;
  const jsonLd = {
    "@context": "https://schema.org", "@type": "SoftwareApplication", name: "OpenCinema", applicationCategory: "MultimediaApplication",
    operatingSystem: "macOS, Linux", license: `${REPO}/blob/main/LICENSE`, url: SITE, codeRepository: REPO, description: t.meta.description,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
  return `<!doctype html>
<html lang="${t.lang}" class="noJs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.meta.title)}</title>
<meta name="description" content="${esc(t.meta.description)}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="en" href="${SITE}/">
<link rel="alternate" hreflang="zh-CN" href="${SITE}/zh/">
<link rel="alternate" hreflang="x-default" href="${SITE}/">
<meta name="theme-color" content="#F7F7F4">
<meta name="color-scheme" content="light">
<meta property="og:type" content="website">
<meta property="og:site_name" content="OpenCinema">
<meta property="og:title" content="${esc(t.meta.title)}">
<meta property="og:description" content="${esc(t.meta.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/assets/img/og.png?v=${v}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="${t.lang === "en" ? "en_US" : "zh_CN"}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(t.meta.title)}">
<meta name="twitter:description" content="${esc(t.meta.description)}">
<meta name="twitter:image" content="${SITE}/assets/img/og.png?v=${v}">
<link rel="icon" href="/assets/img/mark.svg" type="image/svg+xml">
<link rel="icon" href="/assets/img/icon32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/assets/img/icon180.png">
<link rel="preload" href="/assets/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/img/canvas.webp?v=${v}" as="image" type="image/webp">
<link rel="stylesheet" href="/assets/site.css?v=${v}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav" id="nav">
  <div class="wrap navRow">
    <a class="brand" href="/${t.dir}" aria-label="OpenCinema"><img src="/assets/img/logo.svg" alt="OpenCinema" width="151" height="40"></a>
    <nav class="navLinks" aria-label="Primary">
      <a href="#features">${esc(t.nav.features)}</a>
      <a href="#how">${esc(t.nav.how)}</a>
      <a href="#film">${esc(t.nav.film)}</a>
      <a href="/${t.dir}market/">${esc(t.nav.market)}</a>
      <a href="${REPO}#readme" rel="noopener">${esc(t.nav.docs)}</a>
    </nav>
    <div class="navActions">
      <a class="lang" href="${alt.href}" lang="${alt.code}" hreflang="${alt.code}">${esc(alt.label)}</a>
      <a class="iconLink" href="${REPO}" rel="noopener" aria-label="GitHub">${icons.github}<span class="stars" data-stars hidden></span></a>
      <a class="btn btnInk btnSm" href="#start">${esc(t.nav.cta)}</a>
    </div>
  </div>
</header>

<main id="main">
  <section class="hero">
    <div class="wrap heroText">
      <p class="eyebrow mono reveal">${esc(t.hero.eyebrow)}</p>
      <h1 class="heroTitle reveal">${t.hero.title.map((l, i) => `<span class="line" style="--i:${i}">${esc(l)}</span>`).join("")}</h1>
      <p class="lede reveal">${esc(t.hero.lede)}</p>
      <div class="ctaRow reveal">
        <a class="btn btnInk" href="${REPO}" rel="noopener">${icons.github}<span>${esc(t.hero.primary)}</span><span class="stars" data-stars hidden></span></a>
        <button class="btn btnGhost" type="button" data-open-film>${icons.play}<span>${esc(t.hero.secondary)}</span></button>
      </div>
      <ul class="trust mono reveal">${t.hero.trust.map((s) => `<li>${icons.check}${esc(s)}</li>`).join("")}</ul>
    </div>
    <div class="wrap wrapWide">
      <figure class="window heroShot reveal">
        <div class="windowBar" aria-hidden="true"><i></i><i></i><i></i><span class="mono">opencinema · harbor chase · 画布1</span></div>
        ${img("canvas", t.hero.shotAlt, { lazy: false, sizes: "(min-width: 1280px) 1200px, 100vw" }, v)}
      </figure>
    </div>
  </section>

  <section class="works">
    <div class="wrap worksRow reveal">
      <p class="mono worksLabel">${esc(t.works.label)}</p>
      <ul class="worksList">${t.works.items.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
      <p class="worksNote">${esc(t.works.note)}</p>
    </div>
  </section>

  <section class="how" id="how">
    <div class="wrap">
      <p class="label mono reveal">${esc(t.how.label)}</p>
      <h2 class="h2 reveal">${esc(t.how.title)}</h2>
      <ol class="steps">
        ${t.how.steps.map((s) => `<li class="step reveal">
          <div class="stepMedia">${img(s.img, s.alt, { sizes: "(min-width: 900px) 360px, 100vw" }, v)}</div>
          <p class="mono stepN">${esc(s.n)}</p>
          <h3>${esc(s.title)}</h3>
          <p>${esc(s.text)}</p>
        </li>`).join("")}
      </ol>
    </div>
  </section>

  <section class="features" id="features">
    <div class="wrap">
      <p class="label mono reveal">${esc(t.features.label)}</p>
      <h2 class="h2 reveal">${esc(t.features.title)}</h2>
    </div>
    ${t.features.rows.map((r) => `<div class="wrap wrapWide"><article class="feature ${r.side === "left" ? "featureFlip" : ""} reveal">
      <div class="featureText">
        <p class="kicker mono">${esc(r.kicker)}</p>
        <h3>${esc(r.title)}</h3>
        <p>${esc(r.text)}</p>
        <ul class="points">${r.points.map((p) => `<li>${icons.check}${esc(p)}</li>`).join("")}</ul>
      </div>
      <figure class="featureMedia window ${IMG[r.img].h > IMG[r.img].w * 0.8 ? "windowFit" : ""}">
        <div class="windowBar" aria-hidden="true"><i></i><i></i><i></i></div>
        ${img(r.img, r.alt, { sizes: "(min-width: 1100px) 640px, 100vw" }, v)}
      </figure>
    </article></div>`).join("")}
  </section>

  <section class="review">
    <div class="wrap">
      <p class="label mono reveal">${esc(t.review.label)}</p>
      <h2 class="h2 reveal">${esc(t.review.title)}</h2>
      <div class="cards">${t.review.cards.map((c, i) => `<article class="card reveal"><p class="mono cardN">0${i + 1}</p><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p></article>`).join("")}</div>
    </div>
  </section>

  <section class="film" id="film">
    <div class="wrap">
      <p class="label mono reveal">${esc(t.film.label)}</p>
      <h2 class="h2 reveal">${esc(t.film.title)}</h2>
      <p class="sectionLede reveal">${esc(t.film.text)}</p>
    </div>
    <div class="wrap wrapWide">
      <figure class="filmFrame reveal">
        <video id="filmVideo" controls preload="none" playsinline poster="/assets/media/launchPoster.jpg?v=${v}" width="1280" height="720">
          <source src="/assets/media/launch720.mp4?v=${v}" type="video/mp4">
        </video>
      </figure>
      <p class="filmLink reveal"><a class="textLink" href="${REPO}/blob/main/docs/launchVideoStoryboard.md" rel="noopener">${esc(t.film.cta)} ${icons.arrow}</a></p>
    </div>
  </section>

  <section class="start" id="start">
    <div class="wrap">
      <p class="label mono reveal">${esc(t.start.label)}</p>
      <h2 class="h2 reveal">${esc(t.start.title)}</h2>
      <p class="sectionLede reveal">${esc(t.start.text)}</p>
      <div class="codeGrid">
        <div class="codeCard reveal">
          <p class="mono codeTitle">${esc(t.start.buildTitle)}</p>
          <pre><code>${esc(t.start.build)}</code></pre>
          <p class="codeNote">${esc(t.start.buildNote)}</p>
        </div>
        <div class="codeCard reveal">
          <p class="mono codeTitle">${esc(t.start.agentTitle)}</p>
          <pre><code>${esc(t.start.agent)}</code></pre>
          <p class="codeNote">${esc(t.start.agentNote)}</p>
        </div>
      </div>
      <ul class="docLinks reveal">${t.start.links.map((l) => `<li><a href="${l.href}" rel="noopener">${esc(l.label)} ${icons.arrow}</a></li>`).join("")}</ul>
    </div>
  </section>

  <section class="community">
    <div class="wrap">
      <p class="label mono reveal">${esc(t.community.label)}</p>
      <h2 class="h2 reveal">${esc(t.community.title)}</h2>
      <p class="sectionLede reveal">${esc(t.community.text)}</p>
      <div class="cards">${t.community.cards.map((c) => `<article class="card cardDark reveal"><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p></article>`).join("")}</div>
      <p class="reveal"><a class="btn btnInk" href="${t.community.ctaHref}" rel="noopener">${icons.github}<span>${esc(t.community.cta)}</span></a></p>
    </div>
  </section>

  <section class="honest">
    <div class="wrap"><ul class="honestList mono">${t.honest.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
  </section>
</main>

<footer class="footer">
  <div class="wrap footerGrid">
    <div class="footerBrand">
      <img src="/assets/img/logo.svg" alt="OpenCinema" width="151" height="40">
      <p>${esc(t.footer.tagline)}</p>
      <a class="lang" href="${alt.href}" lang="${alt.code}" hreflang="${alt.code}">${esc(alt.label)}</a>
    </div>
    ${t.footer.columns.map((c) => `<div class="footerCol"><p class="mono">${esc(c.title)}</p><ul>${c.links.map((l) => `<li><a href="${l.href}" rel="noopener">${esc(l.label)}</a></li>`).join("")}</ul></div>`).join("")}
  </div>
  <div class="wrap footerLegal">
    <p>${esc(t.footer.license)}</p>
    <p>© <span data-year></span> ${esc(t.footer.copyright)}</p>
  </div>
</footer>

<dialog class="filmDialog" id="filmDialog" aria-label="${esc(t.dialog.title)}">
  <button class="dialogClose" type="button" data-close-film aria-label="${esc(t.dialog.close)}">${icons.close}</button>
  <video id="dialogVideo" controls playsinline preload="none" poster="/assets/media/launchPoster.jpg?v=${v}" width="1280" height="720">
    <source src="/assets/media/launch720.mp4?v=${v}" type="video/mp4">
  </video>
</dialog>
<script src="/assets/site.js?v=${v}" defer></script>
</body>
</html>
`;
}
