// Progressive enhancement only: the page reads fine with this file blocked.
(function () {
  const d = document;
  d.documentElement.classList.remove("noJs");

  // nav border once the page scrolls
  const nav = d.getElementById("nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
  onScroll();
  addEventListener("scroll", onScroll, { passive: true });

  // reveal sections as they enter the viewport
  const reveals = [...d.querySelectorAll(".reveal")];
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach((el) => io.observe(el));
  } else reveals.forEach((el) => el.classList.add("in"));
  // safety net: never leave content hidden if the observer is slow or blocked
  setTimeout(() => reveals.forEach((el) => el.classList.add("in")), 1800);

  // film dialog
  const dialog = d.getElementById("filmDialog");
  const video = d.getElementById("dialogVideo");
  const open = () => {
    if (!dialog || typeof dialog.showModal !== "function") { d.getElementById("film")?.scrollIntoView({ behavior: "smooth" }); return; }
    dialog.showModal();
    video.currentTime = 0;
    video.play().catch(() => {});
  };
  const close = () => { video.pause(); dialog.close(); };
  d.querySelectorAll("[data-open-film]").forEach((b) => b.addEventListener("click", open));
  d.querySelectorAll("[data-close-film]").forEach((b) => b.addEventListener("click", close));
  dialog?.addEventListener("click", (e) => { if (e.target === dialog) close(); });
  dialog?.addEventListener("close", () => video.pause());

  // GitHub stars, best effort
  const starEls = d.querySelectorAll("[data-stars]");
  if (starEls.length) {
    fetch("https://api.github.com/repos/junjamrk/OpenCinema", { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const n = j && typeof j.stargazers_count === "number" ? j.stargazers_count : null;
        if (n === null) return;
        const text = n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
        starEls.forEach((el) => { el.textContent = text + " ★"; el.hidden = false; });
      })
      .catch(() => {});
  }

  d.querySelectorAll("[data-year]").forEach((el) => { el.textContent = String(new Date().getFullYear()); });
})();
