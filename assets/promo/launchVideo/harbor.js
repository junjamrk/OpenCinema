// Procedural "Harbor Chase" imagery: a rainy night at a container harbor, drawn
// with the 2D canvas API. No photographs, no stock, no generated footage.
(function () {
  const TAU = Math.PI * 2;
  const { mulberry, clamp, lerp } = window.Engine;

  const LOOKS = {
    sodium: { glow: "255,176,86", core: "255,236,205", sky0: "#06080F", sky1: "#181C27", haze: "255,150,70", ground0: "#0B0E14", ground1: "#1A1F29", neon: "112,236,255", win: "255,190,120" },
    cool: { glow: "118,214,255", core: "232,249,255", sky0: "#05070E", sky1: "#0E1A2B", haze: "70,170,230", ground0: "#090D15", ground1: "#131B27", neon: "255,96,168", win: "150,220,255" },
  };

  // Camera set-ups. Fractions of width/height.
  const ANGLES = {
    side: { horizon: 0.53, carScale: 1.0, carY: 0.83, carX: 0.42, lamps: [[0.15, 0.64, 0.31], [0.40, 0.60, 0.23], [0.58, 0.575, 0.17]], warehouse: [0.66, 1.0, 0.27], view: "side", perf: { x: 0.74, y: 0.80, s: 0.27 } },
    low: { horizon: 0.61, carScale: 1.45, carY: 0.88, carX: 0.46, lamps: [[0.10, 0.73, 0.42], [0.44, 0.68, 0.27]], warehouse: [0.62, 1.0, 0.30], view: "side", perf: { x: 0.80, y: 0.86, s: 0.36 } },
    rear: { horizon: 0.50, carScale: 1.15, carY: 0.86, carX: 0.50, lamps: [[0.20, 0.61, 0.27], [0.74, 0.61, 0.27]], warehouse: [0.0, 0.40, 0.22], view: "rear", perf: { x: 0.70, y: 0.78, s: 0.24 } },
    wide: { horizon: 0.50, carScale: 0.72, carY: 0.74, carX: 0.40, lamps: [[0.07, 0.61, 0.27], [0.28, 0.575, 0.21], [0.46, 0.555, 0.16], [0.60, 0.545, 0.13]], warehouse: [0.70, 1.0, 0.22], view: "side", perf: { x: 0.72, y: 0.73, s: 0.20 } },
  };

  // Running figure. Body units: height 1 = top of head. Returns joints [x, y] with y up.
  function runPose(phase, duck = 0) {
    const bob = 0.02 * Math.sin(2 * TAU * phase);
    const hipY = 0.53 - 0.17 * duck;
    const lean = 0.08 + 0.22 * duck;
    const pelvis = [0, hipY + bob];
    const neck = [pelvis[0] + lean, pelvis[1] + 0.30 * (1 - 0.2 * duck)];
    const head = [neck[0] + lean * 0.5, neck[1] + 0.10];
    const leg = (ph) => {
      const sw = Math.sin(TAU * ph);
      const th = 0.75 * sw * (1 - 0.45 * duck) + 0.25 * duck;
      const bend = 0.25 + 0.95 * Math.max(0, Math.sin(TAU * ph + 1.3)) * (1 - 0.3 * duck) + 0.9 * duck;
      const k = [pelvis[0] + 0.25 * Math.sin(th), pelvis[1] - 0.25 * Math.cos(th)];
      const a = [k[0] + 0.25 * Math.sin(th - bend), k[1] - 0.25 * Math.cos(th - bend)];
      return { k, a };
    };
    const arm = (ph) => {
      const th = -0.85 * Math.sin(TAU * ph) * (1 - 0.5 * duck) + 0.3 * duck;
      const sh = [neck[0], neck[1] - 0.02];
      const e = [sh[0] + 0.17 * Math.sin(th), sh[1] - 0.17 * Math.cos(th)];
      const w = [e[0] + 0.17 * Math.sin(th + 1.45), e[1] - 0.17 * Math.cos(th + 1.45)];
      return { sh, e, w };
    };
    const L = leg(phase), R = leg(phase + 0.5), AL = arm(phase), AR = arm(phase + 0.5);
    return {
      head, neck, pelvis,
      kneeL: L.k, ankleL: L.a, kneeR: R.k, ankleR: R.a,
      shoulderL: AL.sh, elbowL: AL.e, wristL: AL.w, shoulderR: AR.sh, elbowR: AR.e, wristR: AR.w,
    };
  }
  const BONES = [["head", "neck"], ["neck", "pelvis"], ["shoulderL", "elbowL"], ["elbowL", "wristL"], ["shoulderR", "elbowR"], ["elbowR", "wristR"], ["pelvis", "kneeL"], ["kneeL", "ankleL"], ["pelvis", "kneeR"], ["kneeR", "ankleR"]];

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function glow(ctx, x, y, r, rgb, a) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(0.35, `rgba(${rgb},${a * 0.35})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }

  function drawSkyline(ctx, W, H, hy, rnd, depth) {
    ctx.fillStyle = depth ? "#141414" : "#05070C";
    // container rows
    let x = -W * 0.02;
    while (x < W * 1.02) {
      const w = W * (0.04 + rnd() * 0.07), h = H * (0.018 + rnd() * 0.035);
      ctx.fillRect(x, hy - h, w + 1, h + 1);
      x += w + W * rnd() * 0.01;
    }
    // cranes
    for (let i = 0; i < 3; i++) {
      const cx = W * (0.08 + i * 0.3 + rnd() * 0.12), mh = H * (0.2 + rnd() * 0.1), mw = W * 0.011;
      ctx.fillRect(cx - mw / 2, hy - mh, mw, mh);
      ctx.fillRect(cx - mw * 2.2, hy - mh * 0.55, mw * 4.4, mw * 0.9);
      const boom = W * (0.12 + rnd() * 0.08), dir = rnd() > 0.5 ? 1 : -1;
      ctx.fillRect(dir > 0 ? cx : cx - boom, hy - mh - mw * 0.6, boom, mw * 0.7);
      ctx.fillRect(dir > 0 ? cx - boom * 0.3 : cx, hy - mh - mw * 0.6, boom * 0.3, mw * 0.7);
      ctx.fillRect(cx - mw * 1.6, hy - mh * 0.75, mw * 3.2, mh * 0.12);
    }
    if (!depth) {
      // tiny far lights
      ctx.fillStyle = "rgba(255,200,140,0.55)";
      for (let i = 0; i < 26; i++) {
        const lx = rnd() * W, ly = hy - rnd() * H * 0.05 - 2;
        ctx.fillRect(lx, ly, 2, 2);
      }
    }
  }

  function drawWarehouse(ctx, W, H, hy, A, L, o, depth) {
    const [x0f, x1f, hf] = A.warehouse;
    const x0 = x0f * W, x1 = x1f * W, h = hf * H;
    ctx.fillStyle = depth ? "#3A3A3A" : "#0A0D13";
    ctx.fillRect(x0, hy - h, x1 - x0, h + 1);
    ctx.fillStyle = depth ? "#3A3A3A" : "#0D1118";
    ctx.fillRect(x0, hy - h, x1 - x0, h * 0.08);
    if (depth) return;
    // windows row
    const n = Math.max(3, Math.round((x1 - x0) / (W * 0.045)));
    for (let i = 0; i < n; i++) {
      const wx = x0 + (i + 0.5) * ((x1 - x0) / n);
      ctx.fillStyle = `rgba(${L.win},${0.06 + 0.06 * (i % 3 === 0)})`;
      ctx.fillRect(wx - W * 0.009, hy - h * 0.62, W * 0.018, h * 0.14);
    }
    const neon = clamp(o.neon || 0, 0, 1);
    if (neon > 0) {
      const ny = hy - h * 0.80, nx0 = x0 + (x1 - x0) * 0.10, nx1 = x1 - (x1 - x0) * 0.10;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `rgba(${L.neon},${0.16 * neon})`;
      ctx.fillRect(x0, hy - h, x1 - x0, h);
      const g = ctx.createLinearGradient(0, ny, 0, hy);
      g.addColorStop(0, `rgba(${L.neon},${0.35 * neon})`);
      g.addColorStop(1, `rgba(${L.neon},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(nx0 - W * 0.02, ny, nx1 - nx0 + W * 0.04, hy - ny);
      ctx.shadowColor = `rgba(${L.neon},${neon})`;
      ctx.shadowBlur = H * 0.03;
      ctx.strokeStyle = `rgba(${L.neon},${0.95 * neon})`;
      ctx.lineWidth = Math.max(2, H * 0.006);
      ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(nx0, ny); ctx.lineTo(nx1, ny); ctx.stroke();
      ctx.restore();
    }
  }

  function carGeometry(A, W, H, o, time) {
    const s = A.carScale * (H / 540);
    let xf = o.carX !== undefined ? o.carX : A.carX;
    if (o.carX === undefined && o.drive) xf = A.carX + 0.10 * (time * 0.35 % 1.0 - 0.5);
    return { cx: xf * W, by: A.carY * H, s, dir: -1 };
  }

  function drawCarSide(ctx, car, L, depth, lights) {
    const { cx, by, s, dir } = car;
    ctx.save();
    ctx.translate(cx, by);
    ctx.scale(dir, 1);
    const body = depth ? "#CDCDCD" : "#0B0D12";
    // reflection
    if (!depth) {
      ctx.save();
      ctx.scale(1, -0.55);
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = "#1A1F28";
      roundRect(ctx, -150 * s, -64 * s, 300 * s, 62 * s, 22 * s); ctx.fill();
      ctx.restore();
    }
    // wheels
    for (const wx of [-98, 96]) {
      ctx.fillStyle = depth ? "#C0C0C0" : "#050608";
      ctx.beginPath(); ctx.arc(wx * s, -27 * s, 27 * s, 0, TAU); ctx.fill();
      if (!depth) { ctx.fillStyle = "#1C2129"; ctx.beginPath(); ctx.arc(wx * s, -27 * s, 13 * s, 0, TAU); ctx.fill(); }
    }
    // body
    const g = ctx.createLinearGradient(0, -92 * s, 0, -20 * s);
    g.addColorStop(0, depth ? body : "#242A34");
    g.addColorStop(0.35, body);
    g.addColorStop(1, body);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-152 * s, -30 * s);
    ctx.lineTo(-150 * s, -66 * s);
    ctx.quadraticCurveTo(-120 * s, -74 * s, -80 * s, -72 * s);
    ctx.lineTo(-50 * s, -98 * s);
    ctx.quadraticCurveTo(10 * s, -104 * s, 62 * s, -94 * s);
    ctx.lineTo(96 * s, -70 * s);
    ctx.quadraticCurveTo(150 * s, -66 * s, 156 * s, -56 * s);
    ctx.lineTo(156 * s, -30 * s);
    ctx.closePath();
    ctx.fill();
    // windows
    ctx.fillStyle = depth ? "#C6C6C6" : "#0A0E15";
    ctx.beginPath();
    ctx.moveTo(-42 * s, -94 * s); ctx.lineTo(56 * s, -88 * s); ctx.lineTo(78 * s, -72 * s); ctx.lineTo(-64 * s, -72 * s); ctx.closePath(); ctx.fill();
    if (!depth) {
      const wg = ctx.createLinearGradient(-60 * s, -94 * s, 70 * s, -72 * s);
      wg.addColorStop(0, `rgba(${L.glow},0.18)`); wg.addColorStop(1, "rgba(255,255,255,0.04)");
      ctx.fillStyle = wg; ctx.fill();
      ctx.globalCompositeOperation = "lighter";
      // headlights + beam
      glow(ctx, 154 * s, -48 * s, 42 * s, L.core, 0.9);
      ctx.fillStyle = `rgba(${L.core},0.95)`;
      roundRect(ctx, 140 * s, -54 * s, 16 * s, 9 * s, 3 * s); ctx.fill();
      const bg = ctx.createLinearGradient(156 * s, 0, 560 * s, 0);
      bg.addColorStop(0, `rgba(${L.core},0.22)`); bg.addColorStop(1, `rgba(${L.core},0)`);
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.moveTo(150 * s, -56 * s); ctx.lineTo(560 * s, -120 * s); ctx.lineTo(560 * s, 10 * s); ctx.lineTo(150 * s, -40 * s); ctx.closePath(); ctx.fill();
      // tail lights
      glow(ctx, -150 * s, -52 * s, 30 * s, "255,56,48", 0.7);
      ctx.fillStyle = "rgba(255,70,60,0.95)";
      roundRect(ctx, -156 * s, -58 * s, 12 * s, 10 * s, 3 * s); ctx.fill();
      // spray
      ctx.globalCompositeOperation = "source-over";
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = `rgba(170,185,200,${0.06 - i * 0.012})`;
        ctx.beginPath(); ctx.arc((-110 - i * 26) * s, (-14 - i * 6) * s, (16 + i * 7) * s, 0, TAU); ctx.fill();
      }
      lights.push({ x: cx + dir * 154 * s, y: by - 48 * s, rgb: L.core, r: 70 * s });
      lights.push({ x: cx - dir * 150 * s, y: by - 52 * s, rgb: "255,56,48", r: 40 * s });
    }
    ctx.restore();
  }

  function drawCarRear(ctx, car, L, depth, lights, W, hy) {
    const { cx, by, s } = car;
    ctx.save();
    ctx.translate(cx, by);
    const body = depth ? "#CDCDCD" : "#0B0D12";
    if (!depth) {
      ctx.save(); ctx.scale(1, -0.5); ctx.globalAlpha = 0.2; ctx.fillStyle = "#1A1F28";
      roundRect(ctx, -118 * s, -96 * s, 236 * s, 92 * s, 20 * s); ctx.fill(); ctx.restore();
      // forward beams lighting the road ahead
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      const bg = ctx.createLinearGradient(0, -60 * s, 0, hy - by);
      bg.addColorStop(0, `rgba(${L.core},0.16)`); bg.addColorStop(1, `rgba(${L.core},0)`);
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.moveTo(-150 * s, -40 * s); ctx.lineTo(150 * s, -40 * s); ctx.lineTo(60 * s, hy - by - 20); ctx.lineTo(-60 * s, hy - by - 20); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    for (const wx of [-96, 96]) { ctx.fillStyle = depth ? "#C0C0C0" : "#050608"; roundRect(ctx, (wx - 18) * s, -40 * s, 36 * s, 42 * s, 8 * s); ctx.fill(); }
    const g = ctx.createLinearGradient(0, -120 * s, 0, -20 * s);
    g.addColorStop(0, depth ? body : "#232933"); g.addColorStop(0.3, body); g.addColorStop(1, body);
    ctx.fillStyle = g;
    roundRect(ctx, -118 * s, -92 * s, 236 * s, 78 * s, 16 * s); ctx.fill();
    roundRect(ctx, -84 * s, -132 * s, 168 * s, 50 * s, 18 * s); ctx.fill();
    ctx.fillStyle = depth ? "#C6C6C6" : "#0A0E15";
    roundRect(ctx, -72 * s, -126 * s, 144 * s, 34 * s, 10 * s); ctx.fill();
    if (!depth) {
      ctx.globalCompositeOperation = "lighter";
      for (const tx of [-1, 1]) {
        glow(ctx, tx * 84 * s, -70 * s, 46 * s, "255,56,48", 0.85);
        ctx.fillStyle = "rgba(255,80,70,0.95)";
        roundRect(ctx, tx * 84 * s - 30 * s, -76 * s, 60 * s, 12 * s, 5 * s); ctx.fill();
        lights.push({ x: cx + tx * 84 * s, y: by - 70 * s, rgb: "255,56,48", r: 54 * s });
      }
      ctx.globalCompositeOperation = "source-over";
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = `rgba(170,185,200,${0.05 - i * 0.008})`;
        ctx.beginPath(); ctx.arc((-110 + i * 55) * s, (-6 + (i % 2) * 6) * s, (18 + i * 3) * s, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawPerformer(ctx, W, H, A, perf, depth) {
    const pose = runPose(perf.phase || 0, perf.duck || 0);
    const px = (perf.x !== undefined ? perf.x : A.perf.x) * W, py = (perf.y !== undefined ? perf.y : A.perf.y) * H;
    const s = (perf.s !== undefined ? perf.s : A.perf.s) * H;
    const map = (p) => [px + p[0] * s, py - p[1] * s];
    const J = {};
    for (const k in pose) J[k] = map(pose[k]);
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = depth ? "#E2E2E2" : "#4A515C";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = s * 0.075;
    for (const [a, b] of BONES) {
      if (a === "head") continue;
      ctx.beginPath(); ctx.moveTo(J[a][0], J[a][1]); ctx.lineTo(J[b][0], J[b][1]); ctx.stroke();
    }
    ctx.lineWidth = s * 0.11;
    ctx.beginPath(); ctx.moveTo(J.neck[0], J.neck[1]); ctx.lineTo(J.pelvis[0], J.pelvis[1]); ctx.stroke();
    ctx.beginPath(); ctx.arc(J.head[0], J.head[1], s * 0.062, 0, TAU); ctx.fill();
    if (!depth) {
      // rim light from the lamps
      ctx.strokeStyle = "rgba(255,210,160,0.55)"; ctx.lineWidth = s * 0.02;
      ctx.beginPath(); ctx.moveTo(J.neck[0] + s * 0.03, J.neck[1]); ctx.lineTo(J.pelvis[0] + s * 0.03, J.pelvis[1]); ctx.stroke();
    }
    ctx.restore();
    return J;
  }

  function drawRain(ctx, W, H, time, seed, amount) {
    const rnd = mulberry(seed + 99);
    const n = Math.round(230 * amount * (W * H) / (1360 * 640));
    const k = H / 540;
    ctx.save();
    ctx.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const x0 = rnd() * W, y0 = rnd() * H, len = (16 + rnd() * 26) * k, sp = (900 + rnd() * 600) * k, a = 0.05 + rnd() * 0.15;
      const d = time * sp;
      const y = ((y0 + d) % (H + 60)) - 30;
      const x = ((x0 - d * 0.16) % W + W) % W;
      ctx.strokeStyle = `rgba(190,210,232,${a})`;
      ctx.lineWidth = 0.8 + rnd() * 0.8;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - len * 0.16, y - len); ctx.stroke();
    }
    ctx.restore();
  }

  function drawHarbor(ctx, W, H, o = {}) {
    const A = ANGLES[o.angle || "side"], L = LOOKS[o.look || "sodium"];
    const depth = o.mode === "depth";
    const time = o.time || 0, seed = o.seed === undefined ? 7 : o.seed;
    const rnd = mulberry(seed);
    const hy = A.horizon * H;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    // sky and ground
    if (depth) {
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, hy + 1);
      const g = ctx.createLinearGradient(0, hy, 0, H); g.addColorStop(0, "#2E2E2E"); g.addColorStop(1, "#DCDCDC");
      ctx.fillStyle = g; ctx.fillRect(0, hy, W, H - hy);
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, hy); g.addColorStop(0, L.sky0); g.addColorStop(1, L.sky1);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, hy + 1);
      const hg = ctx.createRadialGradient(W * 0.78, hy, 0, W * 0.78, hy, W * 0.55);
      hg.addColorStop(0, `rgba(${L.haze},0.20)`); hg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = hg; ctx.fillRect(0, 0, W, hy + 1);
      const gg = ctx.createLinearGradient(0, hy, 0, H); gg.addColorStop(0, L.ground0); gg.addColorStop(1, L.ground1);
      ctx.fillStyle = gg; ctx.fillRect(0, hy, W, H - hy);
    }
    drawSkyline(ctx, W, H, hy, rnd, depth);
    drawWarehouse(ctx, W, H, hy, A, L, o, depth);

    const lights = [];
    // lamps
    for (const [lx, ly, lh] of A.lamps) {
      const x = lx * W, base = ly * H, h = lh * H, top = base - h;
      ctx.fillStyle = depth ? `rgb(${Math.round(lerp(120, 200, lh / 0.42))},${Math.round(lerp(120, 200, lh / 0.42))},${Math.round(lerp(120, 200, lh / 0.42))})` : "#0A0C10";
      ctx.fillRect(x - h * 0.012, top, h * 0.024, h);
      ctx.fillRect(x - h * 0.012, top, h * 0.09, h * 0.02);
      if (!depth) {
        const boost = 1 + (o.lampBoost || 0);
        ctx.save(); ctx.globalCompositeOperation = "lighter";
        glow(ctx, x + h * 0.08, top + h * 0.03, h * 0.55, L.glow, 0.55 * boost);
        glow(ctx, x + h * 0.08, top + h * 0.03, h * 0.08, L.core, 0.95);
        ctx.restore();
        lights.push({ x: x + h * 0.08, y: top + h * 0.03, rgb: L.glow, r: h * 0.5 });
      }
    }
    // reflections on wet asphalt (before the car, so the car sits on top)
    if (!depth) {
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      for (const l of lights) {
        const ry = hy + (hy - l.y) * 0.9;
        const len = l.r * 2.2, w = l.r * 0.5;
        ctx.save();
        ctx.translate(l.x, ry + len * 0.35);
        ctx.scale(w / len, 1);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, len);
        g.addColorStop(0, `rgba(${l.rgb},0.20)`); g.addColorStop(0.5, `rgba(${l.rgb},0.07)`); g.addColorStop(1, `rgba(${l.rgb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(-len, -len, 2 * len, 2 * len);
        ctx.restore();
      }
      ctx.restore();
    }
    const car = carGeometry(A, W, H, o, time);
    if (o.car !== false) {
      if (A.view === "rear") drawCarRear(ctx, car, L, depth, lights, W, hy);
      else drawCarSide(ctx, car, L, depth, lights);
    }
    let joints = null;
    if (o.performer) joints = drawPerformer(ctx, W, H, A, o.performer, depth);
    if (!depth && o.rain !== false) drawRain(ctx, W, H, time, seed, o.rainAmount === undefined ? 1 : o.rainAmount);
    if (!depth) {
      const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
      v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.5)");
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
    return { joints, car, horizon: hy };
  }

  window.Harbor = { drawHarbor, runPose, BONES, roundRect, ANGLES, LOOKS };
})();
