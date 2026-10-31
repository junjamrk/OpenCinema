// The nine shots of the launch film. Every visual state is a function of t.
(function () {
  const E = window.Engine;
  const { P, lerp, clamp, EASE, EASE_IN, EASE_INOUT, LINEAR, reveal, cam, mulberry, pulse, show } = E;
  const HB = window.Harbor, PV = window.Previs;
  const MINT = "#4FDBC8", INK = "#101315";

  const html = (s) => { const t = document.createElement("template"); t.innerHTML = s.trim(); return t.content; };
  const words = (line) => line.split(" ").map((w) => `<span class="w">${w}</span>`).join(" ");
  const headline = (id, lines) => `<div class="headline" id="${id}">${lines.map((l) => `<span class="line">${words(l)}</span>`).join("")}</div>`;
  const ICON = {
    text: '<path d="M4 6h12M4 10h12M4 14h8"/>',
    image: '<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.5"/><path d="M3 14l4-4 3 3 2-2 5 5"/>',
    video: '<rect x="3" y="5" width="10" height="10" rx="2"/><path d="M13 9l4-2v6l-4-2z"/>',
    audio: '<path d="M4 9v2M7 6v8M10 3v14M13 7v6M16 9v2"/>',
    spatial: '<path d="M10 2l7 4v8l-7 4-7-4V6z"/><path d="M10 10l7-4M10 10v8M10 10L3 6"/>',
    motion: '<path d="M2 10h3l2-5 3 10 2-5h6"/>',
    frames: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M6 4v12M14 4v12M3 8h3M3 12h3M14 8h3M14 12h3"/>',
    cut: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="14" r="2.5"/><path d="M8 8l9 8M8 12l9-8"/>',
    select: '<path d="M5 3l14 9-6.5 1.5L9 20z"/>',
    brush: '<path d="M4 16c2 0 3-1 3-3s2-3 3-1l1 1-4 4H4z"/><path d="M11 12l6-8 2 2-6 8z"/>',
    erase: '<path d="M4 14l7-7 5 5-5 5H7z"/><path d="M3 18h14"/>',
    crop: '<path d="M6 2v12h12M2 6h12v12"/>',
    sliders: '<path d="M3 6h14M3 14h14"/><circle cx="8" cy="6" r="2" fill="#20232A"/><circle cx="13" cy="14" r="2" fill="#20232A"/>',
    lock: '<rect x="4" y="9" width="12" height="9" rx="2"/><path d="M7 9V6a3 3 0 0 1 6 0v3"/>',
    check: '<path d="M4 10l4 4 8-8"/>',
    cross: '<path d="M5 5l10 10M15 5L5 15"/>',
    arrowUp: '<path d="M10 16V4M4 10l6-6 6 6"/>',
  };
  const icon = (k, cls = "ico", sw = 1.7) => `<svg class="${cls}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
  const cursorSvg = '<svg viewBox="0 0 24 24"><path d="M5 3l14 9-6.5 1.5L9 20z" fill="#101315" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  const stills = new Map();
  // Memoised static picture.
  function still(key, w, h, draw) {
    let c = stills.get(key);
    if (!c) { c = canvas(w, h); draw(c.getContext("2d"), w, h); stills.set(key, c); }
    return c;
  }
  const harborStill = (key, w, h, o) => still(key, w, h, (ctx) => HB.drawHarbor(ctx, w, h, o));
  function waveform(ctx, w, h, seed, color, t) {
    const rnd = mulberry(seed);
    ctx.clearRect(0, 0, w, h);
    const n = Math.floor(w / 5);
    for (let i = 0; i < n; i++) {
      const env = 0.35 + 0.65 * Math.abs(Math.sin(i * 0.11 + 0.4)) * (0.5 + 0.5 * Math.sin(i * 0.031));
      const a = (0.25 + 0.75 * rnd()) * env * (h * 0.46);
      ctx.fillStyle = color;
      ctx.fillRect(i * 5, h / 2 - a, 3, 2 * a);
    }
    if (t !== undefined) { ctx.fillStyle = "#fff"; ctx.fillRect(((t * 0.08) % 1) * w, 0, 2, h); }
  }
  function popStyle(el, p, from = 0.72) { el.style.opacity = p.toFixed(3); el.style.transform = `scale(${lerp(from, 1, p).toFixed(4)})`; }

  const scenes = [];
  let camT = 0; // shared camera drift helper
  const drift = (t, from, dur, a = 1.0, b = 1.02) => lerp(a, b, clamp((t - from) / dur, 0, 1));

  /* ---------------- S01 Hook ---------------- */
  (function () {
    const root = document.getElementById("s1");
    root.appendChild(html(`
      <div class="world" id="s1world">
        <div class="chipLight" id="s1proj" style="left:120px;top:92px">Harbor Chase · Night · Shot 02</div>
        <div class="composer hero" id="s1comp">
          <div class="prompt"><span id="s1text"></span><span class="caret" id="s1caret"></span></div>
          <div class="send" id="s1send">${icon("arrowUp", "", 2.2)}<div class="pulseRing" id="s1pulse"></div></div>
        </div>
        <div class="agents" id="s1agents">Codex · Claude Code · Any MCP agent</div>
      </div>`));
    const world = root.querySelector("#s1world"), comp = root.querySelector("#s1comp"), text = root.querySelector("#s1text"), caret = root.querySelector("#s1caret");
    const proj = root.querySelector("#s1proj"), agents = root.querySelector("#s1agents"), send = root.querySelector("#s1send"), ring = root.querySelector("#s1pulse");
    const PROMPT = "Make the chase feel faster.";
    const BTN = { x: 220 + 1480 - 56 - 39, y: 540 };
    scenes.push({ el: root, from: 0, to: 1.6, render(t) {
      const e = P(t, 0, 0.55);
      comp.style.opacity = Math.min(1, e * 1.6).toFixed(3);
      comp.style.transform = `translateY(${(1 - e) * 46}px)`;
      proj.style.opacity = P(t, 0.05, 0.35).toFixed(3);
      const a = P(t, 0.3, 0.4);
      agents.style.opacity = a.toFixed(3); agents.style.transform = `translateY(${(1 - a) * 12}px)`;
      const n = Math.floor(clamp((t - 0.15) / 0.033, 0, PROMPT.length));
      text.textContent = PROMPT.slice(0, n);
      const typing = t > 0.1 && n < PROMPT.length;
      caret.style.opacity = t < 1.2 ? (typing || Math.floor(t * 4) % 2 === 0 ? 1 : 0) : 0;
      const press = pulse(t, 1.2, 0.18);
      send.style.transform = `scale(${1 - 0.12 * press})`;
      const rp = P(t, 1.22, 0.3, LINEAR);
      ring.style.opacity = (t >= 1.22 && rp < 1 ? 0.7 * (1 - rp) : 0).toFixed(3);
      ring.style.transform = `scale(${1 + 1.6 * rp})`;
      // push in on the send button; accelerating into the match cut
      const z = P(t, 1.28, 0.32, EASE_IN);
      const zoom = Math.exp(lerp(0, Math.log(60), z));
      cam(world, BTN.x, BTN.y, zoom, lerp(BTN.x, 960, z), lerp(BTN.y, 540, z));
    } });
  })();

  /* ---------------- S02/S03 Node canvas + scope ---------------- */
  (function () {
    const root = document.getElementById("s2");
    const NODES = [
      { id: "n1", icon: "text", title: "Chase brief", foot: "textNode", x: 120, y: 100, w: 420, h: 160, body: '<div class="nodeText">Rain-soaked harbor, night. The sedan loses them in the container lanes.</div>' },
      { id: "n2", icon: "image", title: "Hero car still", foot: "imageNode", x: 120, y: 320, w: 420, h: 200, body: '<canvas id="n2c" width="384" height="120"></canvas>' },
      { id: "n3", icon: "audio", title: "Rain + engine bed", foot: "audioNode", x: 120, y: 580, w: 420, h: 150, body: '<canvas id="n3c" width="384" height="70"></canvas>' },
      { id: "n4", icon: "video", title: "Reference clip", foot: "videoNode", x: 680, y: 200, w: 420, h: 200, body: '<canvas id="n4c" width="384" height="120"></canvas>' },
      { id: "n5", icon: "spatial", title: "Previs · Shot 02", foot: "blockoutNode", x: 680, y: 480, w: 420, h: 200, body: '<canvas id="n5c" width="384" height="120"></canvas>' },
      { id: "n6", icon: "image", title: "Frame · Shot 02", foot: "imageGenerationNode", x: 1240, y: 120, w: 420, h: 200, inputs: [-22, 22], body: '<canvas id="n6c" width="384" height="120"></canvas>' },
      { id: "n7", icon: "video", title: "Shot 02 · candidates", foot: "videoGenerationNode", x: 1240, y: 420, w: 420, h: 160, inputs: [-48, -16, 16, 48], body: '<div class="minis"><canvas id="n7a" width="120" height="68"></canvas><canvas id="n7b" width="120" height="68"></canvas><canvas id="n7c" width="120" height="68"></canvas></div>' },
      { id: "n8", icon: "cut", title: "Cut · 4 shots", foot: "videoNode · edit plan", x: 1240, y: 700, w: 420, h: 140, inputs: [-20, 20], body: '<div class="blocks"><div>01</div><div class="hot">02</div><div>03</div><div>04</div></div>' },
    ];
    const EDGES = [["n1", "n6", 0], ["n2", "n6", 1], ["n1", "n7", 0], ["n6", "n7", 1], ["n4", "n7", 2], ["n5", "n7", 3], ["n3", "n8", 1], ["n7", "n8", 0]];
    const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
    const nodeHtml = (n) => `<div class="node" id="${n.id}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px">
        <div class="ring"></div>
        <div class="nodeHead">${icon(n.icon)}<span>${n.title}</span></div>
        <div class="nodeBody">${n.body}</div>
        <div class="nodeFoot mono">${n.foot}</div>
        ${(n.inputs || [0]).map((o) => `<i class="port in" style="top:${n.h / 2 + o}px"></i>`).join("")}
        <i class="port out" style="top:${n.h / 2}px"></i></div>`;
    root.appendChild(html(`
      <div class="world" id="s2world">
        <svg class="edges" id="s2edges" width="1920" height="1080"></svg>
        ${NODES.map(nodeHtml).join("")}
        <div class="marquee" id="s2marquee"></div>
        <div class="cursor" id="s2cursor">${cursorSvg}</div>
      </div>
      ${headline("s2head", ["One canvas.", "The whole film."])}
      ${headline("s3head", ["You set the scope."])}
      <div class="composer bar" id="s3comp"><span class="pill" id="s3pill"><span class="num" id="s3num">1</span> node</span><span class="ph">Describe the change for the selected node…</span><div class="send small">${icon("arrowUp", "", 2.2)}</div></div>`));
    const world = root.querySelector("#s2world"), svg = root.querySelector("#s2edges"), marquee = root.querySelector("#s2marquee"), cursor = root.querySelector("#s2cursor");
    const head2 = root.querySelector("#s2head"), head3 = root.querySelector("#s3head"), comp = root.querySelector("#s3comp"), pill = root.querySelector("#s3pill"), num = root.querySelector("#s3num"), ph = root.querySelector(".ph");
    const nodeEls = Object.fromEntries(NODES.map((n) => [n.id, root.querySelector("#" + n.id)]));
    // edges
    const NS = "http://www.w3.org/2000/svg";
    const edges = EDGES.map(([a, b, slot]) => {
      const s = byId[a], d = byId[b];
      const x1 = s.x + s.w, y1 = s.y + s.h / 2, x2 = d.x, y2 = d.y + d.h / 2 + (d.inputs || [0])[slot];
      const dx = Math.max(90, (x2 - x1) * 0.5);
      const path = document.createElementNS(NS, "path");
      path.setAttribute("class", "edge");
      path.setAttribute("d", `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 9} ${y2}`);
      const arrow = document.createElementNS(NS, "path");
      arrow.setAttribute("class", "arrow");
      arrow.setAttribute("d", `M${x2 - 14} ${y2 - 7} L${x2 - 2} ${y2} L${x2 - 14} ${y2 + 7} Z`);
      const halo = document.createElementNS(NS, "circle"); halo.setAttribute("class", "halo"); halo.setAttribute("r", "9");
      const dot = document.createElementNS(NS, "circle"); dot.setAttribute("class", "dot"); dot.setAttribute("r", "4");
      svg.append(path, arrow, halo, dot);
      return { path, arrow, halo, dot, len: 0, inPort: slot, src: a, dst: b };
    });
    root.style.display = "block";
    for (const e of edges) e.len = e.path.getTotalLength();
    root.style.display = "";
    const portIn = Object.fromEntries(NODES.map((n) => [n.id, [...nodeEls[n.id].querySelectorAll(".port.in")]]));
    const portOut = Object.fromEntries(NODES.map((n) => [n.id, nodeEls[n.id].querySelector(".port.out")]));

    const n2c = root.querySelector("#n2c"), n3c = root.querySelector("#n3c"), n4c = root.querySelector("#n4c"), n5c = root.querySelector("#n5c"), n6c = root.querySelector("#n6c");
    const minis = ["#n7a", "#n7b", "#n7c"].map((s) => root.querySelector(s));
    const SPRING = { n1: 1.6, n2: 1.85, n4: 1.95, n6: 2.05, n3: 2.15, n5: 2.25, n7: 2.35, n8: 2.45 };
    const MQ = { x0: 640, y0: 170, x1: 1700, y1: 705, start: 4.2, dur: 0.4 };
    const inside = (n, r) => n.x >= r.x0 && n.y >= r.y0 && n.x + n.w <= r.x1 && n.y + n.h <= r.y1;
    function marqueeRect(t) {
      const p = P(t, MQ.start, MQ.dur, EASE_INOUT);
      return { x0: MQ.x0, y0: MQ.y0, x1: lerp(MQ.x0, MQ.x1, p), y1: lerp(MQ.y0, MQ.y1, p) };
    }
    function selected(t) {
      if (t < 3.8) return [];
      if (t < MQ.start) return ["n7"];
      const r = marqueeRect(t);
      return NODES.filter((n) => inside(n, r)).map((n) => n.id);
    }
    // when does the count label change? (sampled once; the marquee is deterministic)
    const countChanges = [];
    { let last = 1; for (let tt = MQ.start; tt <= MQ.start + MQ.dur + 0.01; tt += 0.002) { const c = selected(tt).length; if (c > 0 && c !== last) { countChanges.push({ t: tt, c }); last = c; } } }
    function labelCount(t) {
      let c = 1, since = 3.8;
      for (const ch of countChanges) if (t >= ch.t) { c = ch.c; since = ch.t; }
      return { c, since };
    }
    const CURSOR = [[3.6, 1900, 720], [3.8, 1450, 505], [4.2, 640, 170], [4.6, 1700, 705], [5.2, 1700, 705]];
    function cursorAt(t) {
      for (let i = 0; i < CURSOR.length - 1; i++) {
        const [t0, x0, y0] = CURSOR[i], [t1, x1, y1] = CURSOR[i + 1];
        if (t < t1) { const p = P(t, t0, t1 - t0, i === 2 ? EASE_INOUT : EASE); return [lerp(x0, x1, p), lerp(y0, y1, p)]; }
      }
      const [, x, y] = CURSOR[CURSOR.length - 1]; return [x, y];
    }

    scenes.push({ el: root, from: 1.6, to: 5.45, render(t) {
      // camera: zoom out from the mint-filled text node, then drift, then push toward the selection, then whip out
      const n1 = byId.n1, f = [n1.x + n1.w / 2, n1.y + n1.h / 2];
      const z = P(t, 1.6, 0.8);
      let zoom = Math.exp(lerp(Math.log(40), 0, z));
      let fx = lerp(f[0], 960, z), fy = lerp(f[1], 540, z), cx = 960, cy = 540;
      if (t >= 2.4) { const d = drift(t, 2.4, 1.2, 1.0, 1.02); zoom = d; fx = 960; fy = 540; }
      if (t >= 3.6) { const q = P(t, 3.6, 1.6, LINEAR); zoom = lerp(1.02, 1.045, q); fx = lerp(960, 1005, q); fy = lerp(540, 520, q); }
      const whip = P(t, 5.2, 0.22, EASE_INOUT);
      const shiftX = -2400 * whip;
      cam(world, fx, fy, zoom, cx + shiftX, cy);
      const blur = 70 * Math.sin(Math.PI * whip);
      const fxEl = document.getElementById("mblurStd");
      if (blur > 0.5) { fxEl.setAttribute("stdDeviation", `${blur.toFixed(1)} 0`); root.style.filter = "url(#mblur)"; } else root.style.filter = "";
      for (const el of [head2, head3, comp]) el.style.transform = `translateX(${shiftX}px)`;
      // text node: mint body glow → graphite
      const cool = P(t, 1.62, 0.35, LINEAR);
      nodeEls.n1.style.background = cool < 1 ? `color-mix(in srgb, ${MINT} ${Math.round((1 - cool) * 100)}%, #20232A)` : "";
      nodeEls.n1.querySelector(".ring").style.opacity = (t < 2.6 ? 1 : 1 - P(t, 2.6, 0.3, LINEAR)).toFixed(3);
      for (const part of nodeEls.n1.querySelectorAll(".nodeHead, .nodeBody, .nodeFoot, .port")) part.style.opacity = cool.toFixed(3);
      // nodes spring in
      for (const n of NODES) {
        const el = nodeEls[n.id], s = SPRING[n.id];
        if (n.id === "n1") { el.style.opacity = 1; el.style.transform = ""; continue; }
        const p = P(t, s, 0.5);
        el.style.opacity = Math.min(1, p * 2).toFixed(3);
        el.style.transform = `translateY(${(1 - p) * 30}px) scale(${lerp(0.7, 1, p).toFixed(4)})`;
      }
      // edges draw in
      edges.forEach((e, i) => {
        const p = P(t, 2.25 + i * 0.09, 0.45);
        e.path.style.strokeDasharray = `${e.len}`;
        e.path.style.strokeDashoffset = `${e.len * (1 - p)}`;
        e.path.style.opacity = p > 0 ? 1 : 0;
        const ap = P(t, 2.25 + i * 0.09 + 0.38, 0.2);
        e.arrow.style.opacity = ap; e.arrow.style.transformOrigin = `${e.arrow.getBBox().x + 14}px ${e.arrow.getBBox().y + 7}px`; e.arrow.style.transform = `scale(${ap})`;
        const flowing = p >= 1;
        const inP = portIn[e.dst][e.inPort], outP = portOut[e.src];
        if (p > 0.05) outP.classList.add("on"); else outP.classList.remove("on");
        if (ap > 0.5) inP.classList.add("on"); else inP.classList.remove("on");
        for (const c of [e.dot, e.halo]) c.style.opacity = flowing ? 1 : 0;
        if (flowing) {
          const s = ((t - 2.25) * 0.42 + i * 0.37) % 1;
          const pt = e.path.getPointAtLength(s * e.len);
          for (const c of [e.dot, e.halo]) { c.setAttribute("cx", pt.x); c.setAttribute("cy", pt.y); }
        }
      });
      // live thumbnails
      n2c.getContext("2d").drawImage(harborStill("n2", 384, 120, { angle: "side", seed: 7 }), 0, 0);
      n6c.getContext("2d").drawImage(harborStill("n6", 384, 120, { angle: "low", seed: 11 }), 0, 0);
      HB.drawHarbor(n4c.getContext("2d"), 384, 120, { angle: "wide", seed: 3, time: t, drive: true, performer: { phase: t * 2.4, x: 0.64 + 0.03 * Math.sin(t) } });
      PV.renderPrevis(n5c.getContext("2d"), 384, 120, { time: (t * 0.55) % 1.6, mode: "rgb" });
      waveform(n3c.getContext("2d"), 384, 70, 5, "rgba(79,219,200,.75)", t);
      ["side", "low", "rear"].forEach((a, i) => minis[i].getContext("2d").drawImage(harborStill("n7" + a, 120, 68, { angle: a, seed: 20 + i, look: i === 2 ? "cool" : "sodium" }), 0, 0));
      // headline 2 in, out at 3.6
      reveal(head2, t, 2.7, { stagger: 0.09, out: 3.6 });
      // ---- scope (S03)
      const cbar = P(t, 3.6, 0.45);
      comp.style.opacity = cbar.toFixed(3);
      comp.style.transform = `translate(${shiftX}px, ${(1 - cbar) * 60}px)`;
      const sel = selected(t);
      for (const n of NODES) {
        if (n.id === "n1") continue;
        const on = sel.includes(n.id);
        const ring = nodeEls[n.id].querySelector(".ring");
        const was = ring.dataset.on === "1";
        if (on && !was) { ring.dataset.on = "1"; ring.dataset.t = t; } else if (!on && was) { ring.dataset.on = "0"; }
        const since = Number(ring.dataset.t || 0);
        const rp = on ? P(t, Math.min(since, t), 0.25) : 0;
        ring.style.opacity = on ? Math.max(0.35, rp).toFixed(3) : "0";
      }
      // reset ring memory when seeking backwards (stills / sub-frames)
      if (t < 3.8) for (const n of NODES) { const r = nodeEls[n.id].querySelector(".ring"); if (n.id !== "n1") { r.dataset.on = "0"; r.style.opacity = "0"; } }
      const [cxp, cyp] = cursorAt(t);
      cursor.style.left = cxp + "px"; cursor.style.top = cyp + "px";
      cursor.style.opacity = t >= 3.6 ? 1 : 0;
      cursor.style.transform = `scale(${1 - 0.15 * pulse(t, 3.8, 0.16)})`;
      const mq = marqueeRect(t);
      marquee.style.display = t >= MQ.start && t < 5.2 ? "block" : "none";
      marquee.style.left = mq.x0 + "px"; marquee.style.top = mq.y0 + "px";
      marquee.style.width = (mq.x1 - mq.x0) + "px"; marquee.style.height = (mq.y1 - mq.y0) + "px";
      marquee.style.opacity = t >= MQ.start + MQ.dur ? (1 - P(t, MQ.start + MQ.dur + 0.15, 0.3, LINEAR)).toFixed(3) : 1;
      const lc = labelCount(t);
      num.textContent = String(lc.c);
      pill.lastChild.textContent = lc.c === 1 ? " node" : " nodes";
      const roll = P(t, lc.since, 0.22);
      num.style.transform = `translateY(${(1 - roll) * 18}px)`; num.style.opacity = roll.toFixed(3);
      pill.style.opacity = t >= 3.8 ? 1 : 0;
      ph.textContent = lc.c === 1 ? "Describe the change for the selected node…" : "Describe the change for the selected nodes…";
      ph.style.opacity = t >= 3.8 ? 1 : 0.0;
      reveal(head3, t, 4.4, { stagger: 0.08 });
    } });
  })();

  /* ---------------- S04 Image editing ---------------- */
  (function () {
    const root = document.getElementById("s4");
    const VW = 1372, VH = 620;
    root.appendChild(html(`
      <div class="world" id="s4world">
        <div class="panel" style="left:210px;top:70px;width:1500px;height:720px">
          <div class="panelHead"><span>Hero car still</span><span class="mono dim">imageNode · media edit</span></div>
          <div class="chip mint" id="s4mode" style="right:24px;top:17px">Brush · Mask</div>
          <div class="rail">
            <div class="tool">${icon("select")}</div><div class="tool on">${icon("brush")}</div><div class="tool">${icon("erase")}</div><div class="tool">${icon("crop")}</div><div class="tool">${icon("sliders")}</div>
          </div>
          <div class="viewport" style="left:104px;top:76px;width:${VW}px;height:${VH}px">
            <canvas id="s4base" width="${VW}" height="${VH}"></canvas>
            <canvas id="s4edit" width="${VW}" height="${VH}"></canvas>
            <canvas id="s4mask" width="${VW}" height="${VH}" style="opacity:.42"></canvas>
            <div class="brushCursor" id="s4brush"></div>
            <div class="chip onInk big" id="s4chip" style="left:20px;top:20px;opacity:0"></div>
          </div>
        </div>
        ${headline("s4head", ["Change only what matters."])}
      </div>`));
    const world = root.querySelector("#s4world"), base = root.querySelector("#s4base"), edit = root.querySelector("#s4edit"), mask = root.querySelector("#s4mask");
    const brush = root.querySelector("#s4brush"), chip = root.querySelector("#s4chip"), head = root.querySelector("#s4head"), mode = root.querySelector("#s4mode");
    const shape = canvas(VW, VH); // brush mask shape (hard circles)
    const STROKES = [[5.40, 5.56, 192], [5.53, 5.69, 243], [5.66, 5.82, 294]];
    const SX0 = 930, SX1 = 1340, R = 44;
    function drawMaskShape(t) {
      const c = shape.getContext("2d");
      c.clearRect(0, 0, VW, VH); c.fillStyle = "#fff";
      let cur = null;
      for (const [a, b, y] of STROKES) {
        const p = clamp((t - a) / (b - a), 0, 1);
        if (p <= 0) continue;
        const xe = lerp(SX0, SX1, EASE_INOUT(p));
        for (let x = SX0; x <= xe; x += 6) { c.beginPath(); c.arc(x, y + 6 * Math.sin(x * 0.02), R, 0, Math.PI * 2); c.fill(); }
        if (p < 1) cur = [xe, y + 6 * Math.sin(xe * 0.02)];
      }
      return cur;
    }
    const baseStill = (k, o) => harborStill("s4" + k, VW, VH, Object.assign({ seed: 7, time: 0.4 }, o));
    scenes.push({ el: root, from: 5.2, to: 6.8, render(t) {
      const whip = P(t, 5.2, 0.22, EASE_INOUT);
      const shiftX = 2400 * (1 - whip);
      const d = drift(t, 5.42, 1.4, 1.0, 1.02);
      cam(world, 960, 540, d, 960 + shiftX, 540);
      const blur = 70 * Math.sin(Math.PI * whip);
      const fxEl = document.getElementById("mblurStd");
      if (blur > 0.5) { fxEl.setAttribute("stdDeviation", `${blur.toFixed(1)} 0`); root.style.filter = "url(#mblur)"; } else root.style.filter = "";
      const bctx = base.getContext("2d");
      let cut = 0;
      if (t >= 6.6) cut = 4; else if (t >= 6.4) cut = 3; else if (t >= 6.2) cut = 2; else if (t >= 6.0) cut = 1;
      const names = ["", "Lighting", "New angle", "Panorama", "Grid split"];
      if (cut === 0) {
        bctx.drawImage(baseStill("base", { angle: "side" }), 0, 0);
        const cur = drawMaskShape(t);
        const mctx = mask.getContext("2d");
        mctx.clearRect(0, 0, VW, VH);
        mctx.filter = "blur(7px)"; mctx.drawImage(shape, 0, 0); mctx.filter = "none";
        mctx.globalCompositeOperation = "source-in"; mctx.fillStyle = MINT; mctx.fillRect(0, 0, VW, VH); mctx.globalCompositeOperation = "source-over";
        const change = P(t, 5.85, 0.18);
        mask.style.opacity = (0.42 * (1 - change)).toFixed(3);
        brush.style.display = cur ? "block" : "none";
        if (cur) { brush.style.left = cur[0] + "px"; brush.style.top = cur[1] + "px"; }
        const ectx = edit.getContext("2d");
        ectx.clearRect(0, 0, VW, VH);
        if (change > 0) {
          ectx.drawImage(baseStill("neon", { angle: "side", neon: 1, lampBoost: 0.7 }), 0, 0);
          ectx.globalCompositeOperation = "destination-in"; ectx.filter = "blur(7px)"; ectx.drawImage(shape, 0, 0); ectx.filter = "none"; ectx.globalCompositeOperation = "source-over";
        }
        edit.style.opacity = change.toFixed(3);
        chip.style.opacity = 0;
        mode.textContent = t < 5.85 ? "Brush · Mask" : "Masked edit";
      } else {
        edit.style.opacity = 0; mask.style.opacity = 0; brush.style.display = "none";
        mode.textContent = names[cut];
        if (cut === 1) bctx.drawImage(baseStill("light", { angle: "side", look: "cool", neon: 1 }), 0, 0);
        if (cut === 2) bctx.drawImage(baseStill("angle", { angle: "rear", look: "cool", neon: 1 }), 0, 0);
        if (cut === 3) {
          bctx.fillStyle = "#000"; bctx.fillRect(0, 0, VW, VH);
          const ph = Math.round(VW / 2.4);
          bctx.drawImage(harborStill("s4pano", VW, ph, { angle: "wide", look: "cool", seed: 5, time: 0.4 }), 0, (VH - ph) / 2);
        }
        if (cut === 4) {
          bctx.fillStyle = "#000"; bctx.fillRect(0, 0, VW, VH);
          const gw = (VW - 8) / 2, gh = (VH - 8) / 2;
          [["side", 7], ["low", 11], ["rear", 13], ["wide", 5]].forEach(([a, s], i) => {
            bctx.drawImage(harborStill("s4grid" + a, Math.round(gw), Math.round(gh), { angle: a, look: "cool", seed: s, time: 0.4, neon: 1 }), (i % 2) * (gw + 8), Math.floor(i / 2) * (gh + 8));
          });
        }
        const since = [0, 6.0, 6.2, 6.4, 6.6][cut];
        chip.textContent = names[cut];
        popStyle(chip, P(t, since, 0.22), 0.85);
      }
      reveal(head, t, 5.95, { stagger: 0.06 });
    } });
  })();

  /* ---------------- S05 3D previs ---------------- */
  (function () {
    const root = document.getElementById("s5");
    const W = 1500, H = 720;
    root.appendChild(html(`
      <div class="world" id="s5world">
        <div class="panel" style="left:210px;top:70px;width:${W}px;height:${H}px">
          <canvas id="s5c" width="${W}" height="${H}"></canvas>
          <div class="chip mint solid" style="left:24px;top:22px">Previs / Depth reference</div>
          <div class="chip solid" id="s5layer" style="right:24px;top:22px">RGB</div>
          <div class="chip solid" style="left:24px;bottom:22px">Shot 02 · Take 3 · Cam B</div>
          <div class="btn" style="right:24px;bottom:20px">Freeze as shot reference</div>
          <div class="wipeLine" id="s5wipe"><div class="chip mint solid" id="s5tag" style="left:14px;top:72px">Depth</div></div>
        </div>
      </div>`));
    const world = root.querySelector("#s5world"), c = root.querySelector("#s5c"), layer = root.querySelector("#s5layer"), wipe = root.querySelector("#s5wipe"), tag = root.querySelector("#s5tag");
    const off = { rgb: canvas(W, H), depth: canvas(W, H), normal: canvas(W, H) };
    scenes.push({ el: root, from: 6.8, to: 8.4, render(t) {
      const u = t - 6.8;
      cam(world, 960, 540, drift(t, 6.8, 1.6, 1.0, 1.025));
      const ctx = c.getContext("2d");
      let left = null, right = "rgb", x = W;
      if (u >= 0.8 && u < 1.2) { left = "depth"; right = "rgb"; x = W * P(u, 0.8, 0.4, EASE_INOUT); }
      else if (u >= 1.2) { left = "normal"; right = "depth"; x = W * P(u, 1.2, 0.4, EASE_INOUT); }
      const modes = new Set([right, left].filter(Boolean));
      for (const m of modes) PV.renderPrevis(off[m].getContext("2d"), W, H, { time: u, mode: m });
      ctx.drawImage(off[right], 0, 0);
      if (left) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, x, H); ctx.clip(); ctx.drawImage(off[left], 0, 0); ctx.restore(); }
      const showWipe = left && x > 2 && x < W - 2;
      wipe.style.display = showWipe ? "block" : "none";
      wipe.style.left = x + "px";
      const flip = x > W - 260;
      tag.style.left = flip ? "auto" : "14px"; tag.style.right = flip ? "14px" : "auto";
      tag.textContent = left === "depth" ? "Depth" : "Normal";
      const current = u >= 1.6 ? "Normal" : u >= 1.2 ? (x >= W - 2 ? "Normal" : "Depth") : u >= 0.8 && x >= W - 2 ? "Depth" : "RGB";
      layer.textContent = current;
      const since = current === "Depth" ? 7.6 + 0.4 : current === "Normal" ? 8.0 + 0.4 : 6.8;
      popStyle(layer, P(t, Math.min(since, t), 0.25), 0.85);
    } });
  })();

  /* ---------------- S06 Footage analysis ---------------- */
  (function () {
    const root = document.getElementById("s6");
    const PW = 1140, PH = 520;
    root.appendChild(html(`
      <div class="world" id="s6world">
        <div class="panel" style="left:210px;top:70px;width:1500px;height:720px">
          <div class="panelHead"><span>Reference clip</span><span class="mono dim">videoNode · frameAnalysisNode · motionAnalysisNode · videoDepthNode</span></div>
          <div class="viewport" style="left:40px;top:76px;width:${PW}px;height:${PH}px">
            <canvas id="s6c" width="${PW}" height="${PH}"></canvas>
            <canvas id="s6ov" width="${PW}" height="${PH}"></canvas>
            <div class="chip onInk" id="s6chipA" style="left:18px;top:18px">Shot boundaries</div>
            <div class="chip mint" id="s6chipB" style="left:18px;bottom:18px;opacity:0">2D camera motion</div>
          </div>
          <div class="statusRow" id="s6r0" style="top:96px"><i></i><span>Shots · <b id="s6shots">1</b></span></div>
          <div class="statusRow" id="s6r1" style="top:146px"><i></i><span>Pose track</span></div>
          <div class="statusRow" id="s6r2" style="top:196px"><i></i><span>2D camera motion</span></div>
          <div class="statusRow" id="s6r3" style="top:246px"><i></i><span>Relative depth</span></div>
          <div class="chip" style="left:1210px;top:300px">Not a 3D solve</div>
          <div class="strip" id="s6strip" style="left:40px;top:622px;width:${PW}px;height:54px"></div>
        </div>
        ${headline("s6head", ["Read every frame."])}
      </div>`));
    const world = root.querySelector("#s6world"), c = root.querySelector("#s6c"), ov = root.querySelector("#s6ov"), strip = root.querySelector("#s6strip");
    const chipA = root.querySelector("#s6chipA"), chipB = root.querySelector("#s6chipB"), head = root.querySelector("#s6head"), shots = root.querySelector("#s6shots");
    const rows = [0, 1, 2, 3].map((i) => root.querySelector("#s6r" + i));
    const BOUNDS = [0.27, 0.52, 0.76];
    const segs = [], marks = [];
    for (let i = 0; i < 4; i++) { const s = document.createElement("div"); s.className = "seg mono"; s.textContent = "S" + (i + 1); strip.appendChild(s); segs.push(s); }
    for (const b of BOUNDS) { const m = document.createElement("div"); m.className = "marker"; m.style.left = (b * PW - 1) + "px"; strip.appendChild(m); marks.push(m); }
    const play = document.createElement("div"); play.className = "playhead"; strip.appendChild(play);
    const depthOff = canvas(PW, PH);
    const ANG = ["low", "side", "rear", "wide"];
    scenes.push({ el: root, from: 8.4, to: 9.6, render(t) {
      const u = t - 8.4;
      cam(world, 960, 540, drift(t, 8.4, 1.2, 1.0, 1.02));
      const ctx = c.getContext("2d"), o = ov.getContext("2d");
      o.clearRect(0, 0, PW, PH);
      // scrub through the clip while boundaries are detected, then settle on S2 for tracking
      const scrub = clamp(u / 0.3, 0, 1);
      let seg = 1, clipT = scrub;
      if (u < 0.3) seg = BOUNDS.filter((b) => b <= scrub).length;
      const segOpen = (i) => P(u, 0.05 + i * 0.08, 0.2);
      const perfX = 0.56 + 0.30 * clamp((u - 0.3) / 0.9, 0, 1);
      const opts = { angle: seg === 1 ? "side" : ANG[seg], seed: 7 + seg, time: 0.4 + u, carX: 0.42 - 0.12 * clamp((u - 0.3) / 1.2, 0, 1), performer: { phase: u * 2.6, x: perfX } };
      const res = HB.drawHarbor(ctx, PW, PH, opts);
      // depth pass wipe, top → bottom
      const dp = P(u, 0.72, 0.42, EASE_INOUT);
      if (dp > 0) {
        HB.drawHarbor(depthOff.getContext("2d"), PW, PH, Object.assign({}, opts, { mode: "depth" }));
        const y = PH * dp;
        ctx.drawImage(depthOff, 0, 0, PW, y, 0, 0, PW, y);
        ctx.fillStyle = MINT; ctx.fillRect(0, y - 1, PW, 2);
        ctx.fillStyle = "rgba(79,219,200,.35)"; ctx.fillRect(0, y - 8, PW, 8);
      }
      // strip: segments separate at detected boundaries
      const edges = [0, ...BOUNDS, 1];
      for (let i = 0; i < 4; i++) {
        const gap = 3 * segOpen(Math.min(i, 2)), gapL = i > 0 ? 3 * segOpen(i - 1) : 0;
        const x0 = edges[i] * PW + (i > 0 ? gapL : 4), x1 = edges[i + 1] * PW - (i < 3 ? gap : 4);
        segs[i].style.left = x0 + "px"; segs[i].style.width = (x1 - x0) + "px";
        segs[i].style.background = i === seg && u >= 0.3 ? "rgba(79,219,200,.22)" : "#2C313A";
      }
      marks.forEach((m, i) => { m.style.transform = `scaleY(${P(u, 0.05 + i * 0.08, 0.2)})`; });
      play.style.left = (PW * (u < 0.3 ? scrub : lerp(BOUNDS[0], BOUNDS[1], 0.2 + 0.6 * clamp((u - 0.3) / 1.3, 0, 1)))) + "px";
      shots.textContent = String(1 + BOUNDS.filter((b, i) => u >= 0.05 + i * 0.08).length);
      rows[0].classList.toggle("on", u >= 0.05);
      rows[1].classList.toggle("on", u >= 0.30);
      rows[2].classList.toggle("on", u >= 0.45);
      rows[3].classList.toggle("on", u >= 0.72);
      // pose skeleton lock-on and tracking
      if (u >= 0.30 && res.joints) {
        const J = res.joints;
        const xs = Object.values(J).map((p) => p[0]), ys = Object.values(J).map((p) => p[1]);
        const bx0 = Math.min(...xs) - 18, bx1 = Math.max(...xs) + 18, by0 = Math.min(...ys) - 26, by1 = Math.max(...ys) + 12;
        const lock = P(u, 0.30, 0.16);
        const grow = lerp(1.7, 1.0, lock), cxm = (bx0 + bx1) / 2, cym = (by0 + by1) / 2, hw = (bx1 - bx0) / 2 * grow, hh = (by1 - by0) / 2 * grow;
        const fade = 1 - P(u, 0.78, 0.15, LINEAR);
        o.save(); o.globalAlpha = fade;
        o.strokeStyle = MINT; o.lineWidth = 2; o.lineCap = "round"; o.lineJoin = "round";
        const L = 16;
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const px = cxm + sx * hw, py = cym + sy * hh;
          o.beginPath(); o.moveTo(px - sx * L, py); o.lineTo(px, py); o.lineTo(px, py - sy * L); o.stroke();
        }
        if (lock >= 1) {
          HB.BONES.forEach(([a, b], i) => {
            const bp = P(u, 0.44 + i * 0.02, 0.12);
            if (bp <= 0) return;
            o.strokeStyle = "rgba(79,219,200,.95)"; o.lineWidth = 2.5;
            o.beginPath(); o.moveTo(J[a][0], J[a][1]); o.lineTo(lerp(J[a][0], J[b][0], bp), lerp(J[a][1], J[b][1], bp)); o.stroke();
          });
          const jp = P(u, 0.46, 0.2);
          for (const k in J) { o.fillStyle = MINT; o.beginPath(); o.arc(J[k][0], J[k][1], 4.5 * jp, 0, Math.PI * 2); o.fill(); o.fillStyle = "#fff"; o.beginPath(); o.arc(J[k][0], J[k][1], 1.6 * jp, 0, Math.PI * 2); o.fill(); }
        }
        o.restore();
      }
      // 2D camera motion field
      const cmp = P(u, 0.45, 0.25) * (1 - P(u, 0.78, 0.15, LINEAR));
      if (cmp > 0) {
        const rnd = mulberry(31);
        o.save(); o.globalAlpha = 0.7 * cmp; o.strokeStyle = MINT; o.fillStyle = MINT; o.lineWidth = 1.6;
        for (let r = 0; r < 3; r++) for (let k = 0; k < 7; k++) {
          const x = 90 + k * 160 + rnd() * 20, y = 80 + r * 170 + rnd() * 20;
          const len = (22 + rnd() * 10) * cmp, dy = (rnd() - 0.5) * 6;
          o.beginPath(); o.moveTo(x, y); o.lineTo(x - len, y + dy); o.stroke();
          o.beginPath(); o.moveTo(x - len - 5, y + dy); o.lineTo(x - len + 3, y + dy - 4); o.lineTo(x - len + 3, y + dy + 4); o.closePath(); o.fill();
        }
        o.restore();
      }
      chipB.style.opacity = cmp.toFixed(3);
      const label = u >= 0.72 ? "Relative depth" : u >= 0.30 ? "Pose track" : "Shot boundaries";
      chipA.textContent = label;
      popStyle(chipA, P(u, u >= 0.72 ? 0.72 : u >= 0.30 ? 0.30 : 0, 0.22), 0.85);
      reveal(head, t, 8.6, { stagger: 0.07 });
    } });
  })();

  /* ---------------- S07 Generation plan ---------------- */
  (function () {
    const root = document.getElementById("s7");
    const PROMPT = "Rain-soaked container harbor at night. A black sedan slides through the lane; the camera tracks low from the left and holds the car in frame. Faster: tighter lens, shorter cut, spray off the rear wheels. Keep screen direction left to right.";
    root.appendChild(html(`
      <div class="world" id="s7world">
        <div class="plan" id="s7card">
          <div class="planBody" id="s7body">
            <div class="planHead"><span>Generation plan · Shot 02</span><span class="chip mint static">Final prompt</span></div>
            <pre class="prompt mono">${PROMPT}</pre>
            <div class="refs">
              <div class="ref"><canvas id="s7r1" width="352" height="198"></canvas><div class="meta"><span class="chip mint static">identity</span><span class="refName">Hero car still</span></div></div>
              <div class="ref"><canvas id="s7r2" width="352" height="198"></canvas><div class="meta"><span class="chip mint static">composition</span><span class="refName">Previs RGB · Shot 02</span></div></div>
              <div class="ref"><canvas id="s7r3" width="352" height="198"></canvas><div class="meta"><span class="chip mint static">motion</span><span class="refName">Reference clip</span></div></div>
            </div>
            <div class="planFoot"><span>Provider · configured by you</span><span>Cost · billed by provider</span><span class="go" id="s7go">Generate 3 candidates<div class="pulseRing" id="s7ring"></div></span></div>
          </div>
          <div class="planSummary" id="s7sum"><span>Generation plan · Shot 02</span><span class="chip static">3 candidates requested</span><span class="chip static" style="margin-left:auto">Your provider</span></div>
        </div>
        <div class="cand" id="s7c1" style="left:310px;top:250px"><canvas width="420" height="236"></canvas><div class="candBar"><span>Candidate 1</span><span class="chip static">Pending review</span></div></div>
        <div class="cand" id="s7c2" style="left:750px;top:250px"><canvas width="420" height="236"></canvas><div class="candBar"><span>Candidate 2</span><span class="chip static">Pending review</span></div></div>
        <div class="cand" id="s7c3" style="left:1190px;top:250px"><canvas width="420" height="236"></canvas><div class="candBar"><span>Candidate 3</span><span class="chip static">Pending review</span></div></div>
        ${headline("s7head", ["See the plan first."])}
      </div>`));
    const world = root.querySelector("#s7world"), card = root.querySelector("#s7card"), body = root.querySelector("#s7body"), sum = root.querySelector("#s7sum"), go = root.querySelector("#s7go"), ring = root.querySelector("#s7ring"), head = root.querySelector("#s7head");
    const cands = [1, 2, 3].map((i) => root.querySelector("#s7c" + i));
    const refs = [1, 2, 3].map((i) => root.querySelector("#s7r" + i));
    const CAND = [["side", 21], ["low", 11], ["wide", 5]];
    scenes.push({ el: root, from: 9.6, to: 11.0, render(t) {
      // push into candidate 2 from 10.8
      const push = P(t, 10.8, 0.22, EASE_IN);
      const zoom = lerp(drift(t, 9.6, 1.2, 1.0, 1.02), 1.905, push);
      const c2 = [960, 250 + 118];
      cam(world, lerp(960, c2[0], push), lerp(540, c2[1], push), zoom, lerp(960, 210 + 40 + 400, push), lerp(540, 70 + 40 + 225, push));
      const e = P(t, 9.6, 0.5);
      card.style.opacity = Math.min(1, e * 1.5).toFixed(3);
      const collapse = P(t, 10.05, 0.4);
      card.style.height = lerp(560, 72, collapse) + "px";
      card.style.transform = `translateY(${(1 - e) * -40}px) scale(${lerp(0.98, 1, e)})`;
      body.style.opacity = (1 - P(t, 10.05, 0.15, LINEAR)).toFixed(3);
      sum.style.opacity = P(t, 10.2, 0.25).toFixed(3);
      refs[0].getContext("2d").drawImage(harborStill("s7r1", 352, 198, { angle: "side", seed: 7, time: 0.4 }), 0, 0);
      refs[1].getContext("2d").drawImage(still("s7r2", 352, 198, (ctx) => PV.renderPrevis(ctx, 352, 198, { time: 0.9, mode: "rgb" })), 0, 0);
      HB.drawHarbor(refs[2].getContext("2d"), 352, 198, { angle: "side", seed: 9, time: 0.4 + t, drive: true, performer: { phase: t * 2.6, x: 0.74 } });
      const press = pulse(t, 10.0, 0.18);
      go.style.transform = `scale(${1 - 0.08 * press})`;
      const rp = P(t, 10.02, 0.3, LINEAR);
      ring.style.opacity = (t >= 10.02 && rp < 1 ? 0.8 * (1 - rp) : 0).toFixed(3);
      ring.style.transform = `scale(${1 + 0.25 * rp})`;
      cands.forEach((el, i) => {
        const p = P(t, 10.1 + i * 0.1, 0.45);
        el.style.opacity = Math.min(1, p * 1.6).toFixed(3);
        el.style.transform = `translateY(${(1 - p) * 40}px) scale(${lerp(0.96, 1, p)})`;
        if (p > 0) HB.drawHarbor(el.querySelector("canvas").getContext("2d"), 420, 236, { angle: CAND[i][0], seed: CAND[i][1], time: 0.4 + t * (0.6 + i * 0.2), drive: true, look: "sodium" });
      });
      reveal(head, t, 9.8, { stagger: 0.07, out: 10.78 });
    } });
  })();

  /* ---------------- S08 Review and edit ---------------- */
  (function () {
    const root = document.getElementById("s8");
    const CHECKS = ["Direction", "Action", "Identity", "Continuity", "Unexpected cuts", "Deformation / branding"];
    const FAIL = 4;
    root.appendChild(html(`
      <div class="world" id="s8world">
        <div class="panel" style="left:210px;top:70px;width:1500px;height:520px">
          <div class="clipBox"><canvas id="s8c" width="800" height="450"></canvas>
            <div class="chip" id="s8status" style="right:16px;top:16px">Pending review</div>
            <div class="chip onInk" style="left:16px;bottom:16px">Candidate 2 · Shot 02</div>
          </div>
          <div class="checks"><h3>Review</h3>${CHECKS.map((c, i) => `<div class="check"><span>${c}</span><span class="mark ${i === FAIL ? "fail" : "pass"}" id="s8m${i}">${icon(i === FAIL ? "cross" : "check", "", 2.4)}</span></div>`).join("")}</div>
          <div class="note"><span class="lbl">NOTE</span><span id="s8note"></span><span class="caret" id="s8caret"></span></div>
        </div>
        <div class="panel tl" id="s8tl">
          <div class="tlHead"><span>Edit plan · 4 shots</span><span class="chip static" id="s8tlchip">Shot 02 pending</span><span class="btn" id="s8export" style="position:static;margin-left:auto">Export</span></div>
          ${[0, 1, 2, 3].map((i) => `<div class="clip" id="s8k${i}" style="left:${40 + i * 346}px"><canvas width="330" height="80"></canvas><span class="lbl">SHOT 0${i + 1}</span>${i !== 1 ? icon("lock", "lock", 1.8) : ""}</div>`).join("")}
          <div class="clip" id="s8k1new" style="left:${40 + 346}px;opacity:0"><canvas width="330" height="80"></canvas><span class="lbl">SHOT 02 · CANDIDATE 3</span></div>
          <div class="audioTrack" id="s8audio"><canvas width="1368" height="22"></canvas></div>
          <div class="tlPlayhead" id="s8ph"></div>
        </div>
        ${headline("s8head", ["Replace one shot.", "Keep the rest."])}
      </div>`));
    const world = root.querySelector("#s8world"), clip = root.querySelector("#s8c"), status = root.querySelector("#s8status"), note = root.querySelector("#s8note"), caret = root.querySelector("#s8caret");
    const marks = CHECKS.map((_, i) => root.querySelector("#s8m" + i));
    const tl = root.querySelector("#s8tl"), tlchip = root.querySelector("#s8tlchip"), exportBtn = root.querySelector("#s8export"), audio = root.querySelector("#s8audio"), ph = root.querySelector("#s8ph"), head = root.querySelector("#s8head");
    const clips = [0, 1, 2, 3].map((i) => root.querySelector("#s8k" + i)), newClip = root.querySelector("#s8k1new");
    const SHOTS = [["side", 7], ["low", 11], ["rear", 13], ["side", 31]];
    const NOTE = "cut at 2.1 s";
    const TL_X0 = 40, TL_X1 = 1408;
    scenes.push({ el: root, from: 10.9, to: 12.4, render(t) {
      const fade = P(t, 10.9, 0.1, LINEAR);
      root.style.opacity = fade.toFixed(3);
      cam(world, 960, 540, lerp(1.04, 1.0, P(t, 10.9, 0.5)) * drift(t, 11.4, 1.0, 1.0, 1.015));
      HB.drawHarbor(clip.getContext("2d"), 800, 450, { angle: "low", seed: 11, time: 0.4 + t * 0.8, drive: true });
      marks.forEach((m, i) => popStyle(m, P(t, 10.95 + i * 0.08, 0.3), 0.5));
      const n = Math.floor(clamp((t - 11.22) / 0.016, 0, NOTE.length));
      note.textContent = NOTE.slice(0, n);
      caret.style.opacity = t >= 11.2 && t < 11.45 ? 1 : 0;
      const rejected = t >= 11.4;
      status.textContent = rejected ? "Rejected · kept" : "Pending review";
      status.className = rejected ? "chip onInk" : "chip";
      popStyle(status, P(t, rejected ? 11.4 : 10.9, 0.22), 0.85);
      // timeline rises
      const tr = P(t, 11.45, 0.45);
      tl.style.opacity = tr.toFixed(3); tl.style.transform = `translateY(${(1 - tr) * 60}px)`;
      clips.forEach((el, i) => el.querySelector("canvas").getContext("2d").drawImage(harborStill("s8k" + i, 330, 80, { angle: SHOTS[i][0], seed: SHOTS[i][1], time: 0.4, rainAmount: 0.6 }), 0, 0));
      newClip.querySelector("canvas").getContext("2d").drawImage(harborStill("s8knew", 330, 80, { angle: "wide", seed: 5, time: 0.4, rainAmount: 0.6 }), 0, 0);
      const rep = P(t, 11.5, 0.3);
      clips[1].style.transform = `translateY(${rep * 70}px)`; clips[1].style.opacity = (1 - rep).toFixed(3);
      newClip.style.transform = `translateY(${(1 - rep) * -70}px)`; newClip.style.opacity = rep.toFixed(3);
      tlchip.textContent = rep >= 1 ? "Shot 02 replaced · 3 locked" : "Shot 02 pending";
      const ap = P(t, 11.9, 0.3);
      audio.style.opacity = ap.toFixed(3); audio.style.transform = `translateX(${(1 - ap) * -40}px)`;
      if (ap > 0) waveform(audio.querySelector("canvas").getContext("2d"), 1368, 22, 9, "rgba(79,219,200,.8)");
      const sweep = P(t, 12.1, 0.3, EASE_INOUT);
      ph.style.left = lerp(TL_X0, TL_X1, sweep) + "px";
      ph.style.opacity = t >= 11.45 ? 1 : 0;
      const ex = t >= 12.36;
      exportBtn.className = ex ? "btn mint" : "btn";
      exportBtn.style.position = "static"; exportBtn.style.marginLeft = "auto";
      exportBtn.style.transform = `scale(${1 + 0.06 * pulse(t, 12.36, 0.1)})`;
      reveal(head, t, 11.55, { stagger: 0.07 });
    } });
  })();

  /* ---------------- S09 End card ---------------- */
  (function () {
    const root = document.getElementById("s9");
    root.appendChild(html(`
      <div class="endLines" id="s9lines"><div class="l">Your agent.</div><div class="l">Your canvas.</div><div class="l">Your film.</div></div>
      <img id="s9logo" src="../../brand/logoLight.png" alt="OpenCinema">
      <div class="endMeta" id="s9meta"><div class="tag">Local workbench · MIT open source</div><div class="url">github.com/junjamrk/OpenCinema</div></div>`));
    const lines = [...root.querySelectorAll(".l")], block = root.querySelector("#s9lines"), logo = root.querySelector("#s9logo"), meta = root.querySelector("#s9meta");
    scenes.push({ el: root, from: 12.4, to: 99, render(t) {
      lines.forEach((l, i) => {
        const p = P(t, 12.4 + i * 0.2, 0.34);
        l.style.opacity = p.toFixed(3);
        l.style.transform = `translateY(${(1 - p) * 44}px) scale(${lerp(1.05, 1, p)})`;
        l.style.filter = p < 1 ? `blur(${(1 - p) * 12}px)` : "none";
      });
      const lift = P(t, 13.2, 0.25);
      block.style.top = lerp(378, 178, lift) + "px";
      const lp = P(t, 13.2, 0.25);
      logo.style.opacity = lp.toFixed(3);
      logo.style.transform = `scale(${lerp(1.06, 1, lp)})`;
      const mp = P(t, 13.24, 0.21);
      meta.style.opacity = mp.toFixed(3);
      meta.style.transform = `translateY(${(1 - mp) * 16}px)`;
    } });
  })();

  window.seek = function (t) {
    for (const s of scenes) {
      const on = t >= s.from && t < s.to;
      show(s.el, on);
      if (on) s.render(t);
    }
  };

  // ready when fonts and the logo are in
  Promise.all([
    document.fonts.load('600 84px "Inter Display"'), document.fonts.load('500 62px Inter'), document.fonts.load('400 16px "JetBrains Mono"'),
    new Promise((res) => { const img = document.getElementById("s9logo"); if (img.complete) res(); else { img.onload = res; img.onerror = res; } }),
  ]).then(() => document.fonts.ready).then(() => { window.seek(0); window.sceneReady = true; });
})();
