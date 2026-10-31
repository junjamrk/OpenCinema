// Deterministic timeline helpers for the launch film.
// Everything on screen is a pure function of time `t` (seconds). No timers, no RAF.
(function () {
  function bezier(x1, y1, x2, y2) {
    // CSS cubic-bezier(x1, y1, x2, y2) evaluated as a function of progress.
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sampleX = (u) => ((ax * u + bx) * u + cx) * u;
    const sampleY = (u) => ((ay * u + by) * u + cy) * u;
    const slopeX = (u) => (3 * ax * u + 2 * bx) * u + cx;
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let u = x;
      for (let i = 0; i < 8; i++) {
        const err = sampleX(u) - x;
        if (Math.abs(err) < 1e-6) break;
        const s = slopeX(u);
        if (Math.abs(s) < 1e-6) break;
        u -= err / s;
      }
      u = Math.max(0, Math.min(1, u));
      return sampleY(u);
    };
  }

  const EASE = bezier(0.16, 1, 0.3, 1); // the product's own entrance curve
  const EASE_IN = bezier(0.4, 0, 1, 1);
  const EASE_INOUT = bezier(0.65, 0, 0.35, 1);
  const LINEAR = (x) => Math.max(0, Math.min(1, x));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, p) => a + (b - a) * p;
  // progress of a segment starting at `start`, lasting `dur`, shaped by `ease`
  const P = (t, start, dur, ease = EASE) => ease(clamp((t - start) / dur, 0, 1));
  const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  const pulse = (t, start, dur) => Math.sin(Math.PI * clamp((t - start) / dur, 0, 1)); // 0→1→0

  function mulberry(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Camera: put world point (fx, fy) at screen point (cx, cy) with the given zoom.
  function cam(el, fx, fy, zoom, cx = 960, cy = 540) {
    el.style.transformOrigin = "0 0";
    el.style.transform = `translate(${cx}px, ${cy}px) scale(${zoom}) translate(${-fx}px, ${-fy}px)`;
  }

  // Word-by-word kinetic reveal. `el` contains .w spans.
  function reveal(el, t, start, opts = {}) {
    const { dur = 0.32, stagger = 0.07, rise = 36, blur = 10, out = null, outDur = 0.22 } = opts;
    const words = el.querySelectorAll(".w");
    let visible = false;
    words.forEach((w, i) => {
      const p = P(t, start + i * stagger, dur);
      let y = rise * (1 - p), o = p, b = blur * (1 - p), s = 1;
      if (out !== null && t >= out) {
        const q = P(t, out + i * stagger * 0.5, outDur, EASE_IN);
        y = -24 * q; o = 1 - q; b = 6 * q;
      }
      if (o > 0.001) visible = true;
      w.style.opacity = o.toFixed(3);
      w.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0) scale(${s})`;
      w.style.filter = b > 0.05 ? `blur(${b.toFixed(2)}px)` : "none";
    });
    el.style.visibility = visible ? "visible" : "hidden";
  }

  function show(el, on) { el.style.display = on ? "block" : "none"; }
  function style(el, props) { for (const k in props) el.style[k] = props[k]; }
  const fmt = (n, d = 2) => Number(n).toFixed(d);

  window.Engine = { bezier, EASE, EASE_IN, EASE_INOUT, LINEAR, clamp, lerp, P, smooth, pulse, mulberry, cam, reveal, show, style, fmt };
})();
