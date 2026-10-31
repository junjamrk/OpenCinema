// Tiny software 3D renderer for the Blockout previs scene: white-model set,
// a running mannequin, a blockout sedan and a virtual camera, rendered as
// RGB (shaded), DEPTH (grey by distance) or NORMAL (camera-space normals).
(function () {
  const { clamp, lerp, smooth } = window.Engine;
  const { runPose } = window.Harbor;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  function lookAt(eye, target) {
    const f = norm(sub(target, eye));
    const r = norm(cross(f, [0, 1, 0]));
    const u = cross(r, f);
    return { eye, r, u, f };
  }
  const toCam = (cam, p) => { const d = sub(p, cam.eye); return [dot(d, cam.r), dot(d, cam.u), dot(d, cam.f)]; };

  function box(cx, cy, cz, sx, sy, sz, ry = 0) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2, cs = Math.cos(ry), sn = Math.sin(ry);
    const rot = (x, z) => [x * cs - z * sn, x * sn + z * cs];
    const v = [];
    for (const [i, j, k] of [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]) {
      const [rx, rz] = rot(i * hx, k * hz);
      v.push([cx + rx, cy + j * hy, cz + rz]);
    }
    const F = [[0, 1, 2, 3, [0, 0, -1]], [5, 4, 7, 6, [0, 0, 1]], [4, 0, 3, 7, [-1, 0, 0]], [1, 5, 6, 2, [1, 0, 0]], [3, 2, 6, 7, [0, 1, 0]], [4, 5, 1, 0, [0, -1, 0]]];
    return F.map(([a, b, c, d, n]) => { const [nx, nz] = rot(n[0], n[2]); return { pts: [v[a], v[b], v[c], v[d]], n: [nx, n[1], nz] }; });
  }
  // disc-shaped prism with its axis along z (a wheel for a car moving along x)
  function wheel(cx, cy, cz, r, len, seg = 12) {
    const faces = [];
    const ring = (z) => Array.from({ length: seg }, (_, i) => { const a = (i / seg) * Math.PI * 2; return [cx + r * Math.cos(a), cy + r * Math.sin(a), z]; });
    const a = ring(cz - len / 2), b = ring(cz + len / 2);
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      const mid = (i + 0.5) / seg * Math.PI * 2;
      faces.push({ pts: [a[i], a[j], b[j], b[i]], n: [Math.cos(mid), Math.sin(mid), 0] });
    }
    faces.push({ pts: a, n: [0, 0, -1] });
    faces.push({ pts: b.slice().reverse(), n: [0, 0, 1] });
    return faces;
  }

  const COL = { ground: [172, 176, 184], water: [40, 46, 58], set: [216, 219, 225], car: [190, 194, 201], man: [232, 234, 238], post: [200, 203, 209] };
  const LIGHT = norm([-0.45, 0.85, -0.35]);

  // The staged action for the previs shot; u = seconds since the shot began (0..DUR)
  const DUR = 2.5;
  function action(u) {
    const s = clamp(u / DUR, 0, 1);
    const run = clamp(s / 0.66, 0, 1);
    const px = lerp(-3.2, 1.6, run);
    const dist = (px + 3.2);
    const phase = dist / 1.45;
    const duck = smooth((s - 0.60) / 0.11) * (1 - smooth((s - 0.84) / 0.12));
    const carX = 10.5 - 13.5 * clamp((s - 0.05) / 0.89, 0, 1);
    const camAngle = 2.35 - 1.55 * s;
    return { px, phase, duck, carX, camAngle, s };
  }

  function renderPrevis(ctx, W, H, o) {
    const u = o.time || 0, mode = o.mode || "rgb";
    const act = action(u);
    const az = 0.95 - 0.30 * act.s, el = 0.40, dist = 16.5 - 1.6 * act.s;
    const target = [0.2, 0.9, 2.0];
    const eye = [target[0] + dist * Math.cos(el) * Math.sin(az), target[1] + dist * Math.sin(el), target[2] - dist * Math.cos(el) * Math.cos(az)];
    const cam = lookAt(eye, target);
    const focal = W * 0.98;
    const project = (p) => { const c = toCam(cam, p); if (c[2] < 0.4) return null; return [W / 2 + focal * c[0] / c[2], H / 2 - focal * c[1] / c[2], c[2]]; };

    const prims = [];
    const pushFaces = (faces, base, twoSided = false) => {
      for (const f of faces) {
        const center = f.pts.reduce((s, p) => add(s, p), [0, 0, 0]).map((v) => v / f.pts.length);
        if (!twoSided && dot(f.n, sub(center, eye)) > 0) continue;
        const pts = f.pts.map(project);
        if (pts.some((p) => !p)) continue;
        const z = pts.reduce((s, p) => s + p[2], 0) / pts.length;
        prims.push({ kind: "face", pts, z, n: f.n, nc: [dot(f.n, cam.r), dot(f.n, cam.u), dot(f.n, cam.f)], base });
      }
    };
    // ground (pier) as a grid of quads so depth and shading vary across it
    for (let x = -16; x < 16; x += 2) for (let z = -2; z < 20; z += 2) pushFaces([{ pts: [[x, 0, z], [x + 2, 0, z], [x + 2, 0, z + 2], [x, 0, z + 2]], n: [0, 1, 0] }], COL.ground, true);
    for (let x = -16; x < 16; x += 4) for (let z = -10; z < -2; z += 4) pushFaces([{ pts: [[x, -0.6, z], [x + 4, -0.6, z], [x + 4, -0.6, z + 4], [x, -0.6, z + 4]], n: [0, 1, 0] }], COL.water, true);
    // pier edge face
    pushFaces([{ pts: [[-16, 0, -2], [16, 0, -2], [16, -0.6, -2], [-16, -0.6, -2]], n: [0, 0, -1] }], COL.set);
    // set pieces
    const set = [
      ...box(-7.2, 1.3, 9.5, 2.4, 2.6, 6.1), ...box(-7.2, 3.9, 9.5, 2.4, 2.6, 6.1),
      ...box(-4.4, 1.3, 10.2, 2.4, 2.6, 6.1, 0.12),
      ...box(6.2, 1.3, 10.5, 6.1, 2.6, 2.4), ...box(6.2, 3.9, 10.5, 6.1, 2.6, 2.4), ...box(9.6, 1.3, 7.4, 2.4, 2.6, 6.1),
      ...box(2, 3.5, 17.5, 22, 7, 6),
      ...box(12.5, 7, 14.5, 1.2, 14, 1.2), ...box(8.5, 14.2, 14.5, 12, 0.5, 0.8),
    ];
    pushFaces(set, COL.set);
    for (const bx of [-10, -6, -2, 2, 6, 10]) pushFaces(box(bx, 0.3, -1.5, 0.4, 0.6, 0.4), COL.set);
    for (const lx of [-2.5, 4.5]) { pushFaces(box(lx, 3.5, 6.8, 0.18, 7, 0.18), COL.post); pushFaces(box(lx - 0.35, 7.05, 6.6, 0.9, 0.22, 0.45), COL.post); }
    // car
    const cx = act.carX, cz = 4.6;
    pushFaces(box(cx, 0.78, cz, 4.6, 0.9, 1.9), COL.car);
    pushFaces(box(cx - 0.25, 1.5, cz, 2.3, 0.62, 1.7), COL.car);
    for (const wx of [-1.5, 1.5]) for (const wz of [-0.98, 0.98]) pushFaces(wheel(cx + wx, 0.38, cz + wz, 0.38, 0.28), COL.car);
    // mannequin: limbs as thick lines, head as a disc
    const pose = runPose(act.phase, act.duck);
    const S = 1.78, pz = 1.6;
    const j3 = (p, dz) => [act.px + p[0] * S, p[1] * S, pz + dz];
    const limbs = [
      ["neck", "pelvis", 0, 0.16], ["pelvis", "kneeL", -0.12, 0.11], ["kneeL", "ankleL", -0.12, 0.09], ["pelvis", "kneeR", 0.12, 0.11], ["kneeR", "ankleR", 0.12, 0.09],
      ["shoulderL", "elbowL", -0.2, 0.08], ["elbowL", "wristL", -0.2, 0.07], ["shoulderR", "elbowR", 0.2, 0.08], ["elbowR", "wristR", 0.2, 0.07],
    ];
    for (const [a, b, dz, w] of limbs) {
      const pa = project(j3(pose[a], dz)), pb = project(j3(pose[b], dz));
      if (!pa || !pb) continue;
      prims.push({ kind: "line", pts: [pa, pb], z: (pa[2] + pb[2]) / 2, w: (w * S * focal) / ((pa[2] + pb[2]) / 2), base: COL.man });
    }
    const ph = project(j3(pose.head, 0));
    if (ph) prims.push({ kind: "disc", pts: [ph], z: ph[2], r: (0.062 * S * focal) / ph[2], base: COL.man });

    prims.sort((a, b) => b.z - a.z);
    // background
    ctx.save();
    ctx.fillStyle = mode === "rgb" ? "#15171C" : mode === "depth" ? "#000" : "#1B1C21";
    ctx.fillRect(0, 0, W, H);
    const near = 9, far = 34;
    const colorOf = (p) => {
      if (mode === "depth") { const g = Math.round(255 * clamp(1 - (p.z - near) / (far - near), 0, 1)); return `rgb(${g},${g},${g})`; }
      if (mode === "normal") {
        const nc = p.kind === "face" ? p.nc : [0, 0, -1];
        return `rgb(${Math.round(128 + 127 * nc[0])},${Math.round(128 + 127 * nc[1])},${Math.round(128 - 127 * nc[2])})`;
      }
      let sh = 0.9;
      if (p.kind === "face") sh = 0.52 + 0.48 * Math.max(0, dot(p.n, LIGHT));
      const fog = clamp((p.z - 12) / 40, 0, 0.35);
      const c = p.base.map((v) => Math.round(lerp(v * sh, 0x17, fog)));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    };
    for (const p of prims) {
      ctx.fillStyle = colorOf(p);
      if (p.kind === "face") {
        ctx.beginPath();
        ctx.moveTo(p.pts[0][0], p.pts[0][1]);
        for (let i = 1; i < p.pts.length; i++) ctx.lineTo(p.pts[i][0], p.pts[i][1]);
        ctx.closePath();
        ctx.fill();
        if (mode === "rgb") { ctx.strokeStyle = "rgba(0,0,0,0.22)"; ctx.lineWidth = 1; ctx.stroke(); }
      } else if (p.kind === "line") {
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = Math.max(1.5, p.w); ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(p.pts[0][0], p.pts[0][1]); ctx.lineTo(p.pts[1][0], p.pts[1][1]); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(p.pts[0][0], p.pts[0][1], Math.max(1.5, p.r), 0, Math.PI * 2); ctx.fill();
      }
    }
    // virtual camera (helper overlay, always mint)
    const camTarget = [act.px, 1.1, pz];
    const vr = 5.6, vpos = [camTarget[0] + vr * Math.cos(act.camAngle), 1.7, camTarget[2] + vr * Math.sin(act.camAngle)];
    const vf = norm(sub(camTarget, vpos)), vrgt = norm(cross(vf, [0, 1, 0])), vup = cross(vrgt, vf);
    const fd = 1.9, fw = 1.25, fh = 0.72;
    const fc = add(vpos, mul(vf, fd));
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => add(add(fc, mul(vrgt, sx * fw)), mul(vup, sy * fh)));
    const P2 = corners.map(project), P0 = project(vpos);
    if (P0 && P2.every(Boolean)) {
      ctx.strokeStyle = "rgba(79,219,200,0.95)"; ctx.lineWidth = 1.6; ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < 4; i++) { ctx.moveTo(P0[0], P0[1]); ctx.lineTo(P2[i][0], P2[i][1]); }
      ctx.moveTo(P2[0][0], P2[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(P2[i][0], P2[i][1]); ctx.closePath();
      ctx.stroke();
      // body
      const bodyFaces = box(0, 0, 0, 0.5, 0.4, 0.8).map((f) => ({ n: f.n, pts: f.pts.map((p) => add(add(add(vpos, mul(vrgt, p[0])), mul(vup, p[1])), mul(vf, p[2] - 0.5))) }));
      ctx.fillStyle = "rgba(79,219,200,0.85)";
      for (const f of bodyFaces) {
        const pts = f.pts.map(project); if (pts.some((p) => !p)) continue;
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = "rgba(18,19,22,0.6)"; ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.fillStyle = "#4FDBC8"; ctx.beginPath(); ctx.arc(P0[0], P0[1], 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    return act;
  }

  window.Previs = { renderPrevis, action, DUR };
})();
