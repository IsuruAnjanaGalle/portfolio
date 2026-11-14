/* Electric background effects: circuit traces with travelling pulses,
   lightning arcs and sparks. Drawn on a transparent canvas above the
   frame sequence and below the content. Kept away from the centre of the
   screen so the person is never covered. */
(() => {
  const canvas = document.getElementById('fx');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Soft glows don't need full resolution; this keeps the canvas cheap
  const dpr = Math.min(window.devicePixelRatio || 1, 1.25);

  const ARC = '150, 210, 255';     // electric blue
  const CORE = '235, 248, 255';    // white-hot core
  const SPARK = ['255, 214, 140', '255, 240, 200', '170, 220, 255'];

  let W = 0, H = 0, mobile = false;
  let traces = [], pulses = [], arcs = [], sparks = [];
  let nextArc = 0, scrollBoost = 0, lastScroll = scrollY;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[(Math.random() * arr.length) | 0];

  // ---------- Zones that keep effects off the person ----------
  // Desktop: left & right side bands. Mobile: top & bottom bands
  // (the frame sits in the middle of a portrait screen).
  function zone() {
    if (!mobile) {
      const clear = Math.min(W * 0.2, 300);          // half-width of the clear centre
      const left = Math.random() < 0.5;
      const x0 = left ? 0 : W / 2 + clear, x1 = left ? W / 2 - clear : W;
      return { x0, x1, y0: H * 0.08, y1: H * 0.95 };
    }
    const top = Math.random() < 0.5;
    // bands above/below the shrunken frame, which sits in the middle ~45%
    const band = Math.max(H * 0.12, (H - W * 9 / 16 * (1920 / 880)) / 2);
    return top ? { x0: 0, x1: W, y0: H * 0.04, y1: Math.min(band, H * 0.32) }
               : { x0: 0, x1: W, y0: Math.max(H - band, H * 0.68), y1: H * 0.98 };
  }

  // ---------- Circuit traces (PCB-style orthogonal/45° paths) ----------
  function makeTrace(z) {
    const pts = [];
    let x = rand(z.x0, z.x1), y = rand(z.y0, z.y1);
    pts.push([x, y]);
    const segs = 2 + (Math.random() * 3 | 0);
    let dir = pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
    for (let i = 0; i < segs; i++) {
      const len = rand(18, mobile ? 40 : 70);
      x = Math.max(z.x0, Math.min(z.x1, x + dir[0] * len));
      y = Math.max(z.y0, Math.min(z.y1, y + dir[1] * len));
      pts.push([x, y]);
      // turn 45° or 90°
      const diag = Math.random() < 0.4;
      dir = diag ? [dir[0] || pick([-1, 1]), dir[1] || pick([-1, 1])]
                 : (dir[0] ? [0, pick([-1, 1])] : [pick([-1, 1]), 0]);
      if (Math.abs(dir[0]) && Math.abs(dir[1])) { // normalise diagonal step
        dir = [dir[0] * 0.7071, dir[1] * 0.7071];
      }
    }
    let total = 0;
    const lens = [];
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      lens.push(l); total += l;
    }
    return { pts, lens, total };
  }

  function pointOn(t, d) {
    let acc = 0;
    for (let i = 0; i < t.lens.length; i++) {
      if (acc + t.lens[i] >= d) {
        const k = (d - acc) / (t.lens[i] || 1);
        const a = t.pts[i], b = t.pts[i + 1];
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      }
      acc += t.lens[i];
    }
    return t.pts[t.pts.length - 1];
  }

  // ---------- Lightning (midpoint displacement) ----------
  function bolt(x1, y1, x2, y2, rough, depth, out) {
    if (depth === 0) { out.push([x2, y2]); return; }
    const mx = (x1 + x2) / 2 + rand(-rough, rough);
    const my = (y1 + y2) / 2 + rand(-rough, rough);
    bolt(x1, y1, mx, my, rough / 2, depth - 1, out);
    bolt(mx, my, x2, y2, rough / 2, depth - 1, out);
  }

  function spawnArc(x1, y1, x2, y2) {
    if (x1 === undefined) {
      const z = zone();
      x1 = rand(z.x0, z.x1); y1 = rand(z.y0, z.y1);
      const ang = rand(0, Math.PI * 2), len = rand(80, mobile ? 160 : 260);
      x2 = Math.max(z.x0, Math.min(z.x1, x1 + Math.cos(ang) * len));
      y2 = Math.max(z.y0, Math.min(z.y1, y1 + Math.sin(ang) * len));
    }
    const len = Math.hypot(x2 - x1, y2 - y1);
    const paths = [];
    const main = [[x1, y1]]; bolt(x1, y1, x2, y2, len * 0.28, 6, main);
    paths.push({ p: main, w: 1 });
    // a couple of forks
    for (let f = 0; f < 2; f++) {
      const s = main[(main.length * rand(0.2, 0.7)) | 0];
      const fork = [[s[0], s[1]]];
      bolt(s[0], s[1], s[0] + rand(-len, len) * 0.4, s[1] + rand(-len, len) * 0.4, len * 0.15, 4, fork);
      paths.push({ p: fork, w: 0.5 });
    }
    arcs.push({ paths, life: 0, max: rand(0.18, 0.35), x1, y1, x2, y2 });
    burst(x1, y1, 8); burst(x2, y2, 14);
  }

  // ---------- Sparks ----------
  function burst(x, y, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), s = rand(60, 320);
      sparks.push({
        x, y, px: x, py: y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60,
        life: 0, max: rand(0.4, 1.1), c: pick(SPARK), w: rand(0.8, 1.8)
      });
    }
  }

  function ember() { // slow floating embers
    const z = zone();
    sparks.push({
      x: rand(z.x0, z.x1), y: rand(z.y0, z.y1), px: 0, py: 0,
      vx: rand(-12, 12), vy: rand(-35, -12), drift: true,
      life: 0, max: rand(2.5, 5), c: pick(SPARK), w: rand(0.8, 1.6)
    });
    const s = sparks[sparks.length - 1]; s.px = s.x; s.py = s.y;
  }

  // ---------- Setup ----------
  function resize() {
    W = innerWidth; H = innerHeight;
    mobile = W < 900;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    traces = [];
    const n = mobile ? 6 : 12;
    for (let i = 0; i < n; i++) traces.push(makeTrace(zone()));
    pulses = traces.map(t => ({ t, d: rand(0, t.total), v: rand(60, 140) }));
    buildTraceLayer();
  }

  // ---------- Cached drawings (made once, stamped every frame) ----------
  const sprite = (r, stops) => {
    const c = document.createElement('canvas'); c.width = c.height = r * 2;
    const g = c.getContext('2d'), gr = g.createRadialGradient(r, r, 0, r, r, r);
    stops.forEach(([o, col]) => gr.addColorStop(o, col));
    g.fillStyle = gr; g.fillRect(0, 0, r * 2, r * 2);
    return c;
  };
  const PULSE = sprite(6, [[0, 'rgba(' + CORE + ',0.85)'], [0.3, 'rgba(' + ARC + ',0.45)'], [1, 'rgba(' + ARC + ',0)']]);
  const GLOW = sprite(40, [[0, 'rgba(' + ARC + ',0.35)'], [1, 'rgba(' + ARC + ',0)']]);
  let traceLayer = null;
  function buildTraceLayer() {
    traceLayer = document.createElement('canvas');
    traceLayer.width = canvas.width; traceLayer.height = canvas.height;
    const g = traceLayer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const t of traces) {
      g.strokeStyle = 'rgba(' + ARC + ', 0.07)'; g.lineWidth = 1;
      g.beginPath(); t.pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke();
      g.fillStyle = 'rgba(' + ARC + ', 0.12)';
      for (const p of [t.pts[0], t.pts[t.pts.length - 1]]) { g.beginPath(); g.arc(p[0], p[1], 1.5, 0, Math.PI * 2); g.fill(); }
    }
  }

  // ---------- Draw ----------
  function drawTraces() {
    if (traceLayer) {                                   // static traces: one blit
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(traceLayer, 0, 0); ctx.restore();
    }
    for (const p of pulses) {                           // travelling current pulses
      const [x, y] = pointOn(p.t, p.d);
      ctx.drawImage(PULSE, x - 6, y - 6);
    }
  }

  function strokePath(p) {
    ctx.beginPath();
    p.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.stroke();
  }

  function drawArcs() {
    for (const a of arcs) {
      const k = a.life / a.max;
      const flicker = Math.random() < 0.25 ? 0.35 : 1;
      const alpha = (1 - k) * flicker;
      for (const { p, w } of a.paths) {
        ctx.lineWidth = 7 * w;  ctx.strokeStyle = 'rgba(' + ARC + ',' + (0.12 * alpha) + ')'; strokePath(p);
        ctx.lineWidth = 3 * w;  ctx.strokeStyle = 'rgba(' + ARC + ',' + (0.45 * alpha) + ')'; strokePath(p);
        ctx.lineWidth = 1.2 * w; ctx.strokeStyle = 'rgba(' + CORE + ',' + (0.95 * alpha) + ')'; strokePath(p);
      }
      // glow at both electrodes
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.drawImage(GLOW, a.x1 - 40, a.y1 - 40);
      ctx.drawImage(GLOW, a.x2 - 40, a.y2 - 40);
      ctx.globalAlpha = 1;
    }
  }

  function drawSparks() {
    for (const s of sparks) {
      const k = 1 - s.life / s.max;
      ctx.strokeStyle = 'rgba(' + s.c + ',' + (s.drift ? 0.55 * Math.sin(Math.PI * (1 - k)) : k) + ')';
      ctx.lineWidth = s.w;
      ctx.beginPath(); ctx.moveTo(s.px, s.py); ctx.lineTo(s.x, s.y); ctx.stroke();
    }
  }

  // ---------- Loop ----------
  let last = performance.now(), running = true;
  const FRAME = 1000 / 30;                 // 30 fps is plenty for glows and sparks
  const viewerEl = document.getElementById('viewer');
  const compact = (arr, keep) => { let n = 0; for (const x of arr) if (keep(x)) arr[n++] = x; arr.length = n; };

  function step(now) {
    if (!running) return;
    requestAnimationFrame(step);
    if (now - last < FRAME - 1) return;
    if (viewerEl && !viewerEl.hidden) { last = now; return; }   // covered by the photo viewer
    const dt = Math.min((now - last) / 1000, 0.08);
    last = now;

    // scroll speed makes the circuit "busier"
    const sv = Math.abs(scrollY - lastScroll); lastScroll = scrollY;
    scrollBoost = Math.min(1, scrollBoost * 0.94 + sv * 0.004);

    for (const p of pulses) {
      p.d += p.v * 0.5 * (1 + scrollBoost * 4) * dt;   // slower to suit the shorter traces
      if (p.d > p.t.total) p.d = 0;
    }

    if (now > nextArc) {
      spawnArc();
      nextArc = now + rand(1400, 3800) * (1 - scrollBoost * 0.7);
    }
    if (Math.random() < (mobile ? 0.06 : 0.12) + scrollBoost * 0.3) ember();   // per 30 fps frame

    for (const a of arcs) a.life += dt;
    compact(arcs, a => a.life < a.max);

    for (const s of sparks) {
      s.px = s.x; s.py = s.y;
      if (!s.drift) { s.vy += 520 * dt; s.vx *= 0.985; }
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.life += dt;
    }
    compact(sparks, s => s.life < s.max && s.y < H + 20);
    if (sparks.length > 250) sparks.splice(0, sparks.length - 250);

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    drawTraces(now);
    drawArcs();
    drawSparks();
    ctx.globalCompositeOperation = 'source-over';
  }

  // Tap / click anywhere for a small spark burst (not on links or cards)
  addEventListener('pointerdown', e => {
    if (e.target.closest('a, button, .flip, iframe, .viewer')) return;
    burst(e.clientX, e.clientY, 18);
  });

  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) { last = performance.now(); requestAnimationFrame(step); }
  });

  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 150); });
  resize();

  if (reduce) {            // static circuit only
    ctx.globalCompositeOperation = 'lighter';
    drawTraces(0);
    return;
  }
  requestAnimationFrame(step);

  // Let the page fire arcs and sparks (used by the title hover in main.js)
  window.siteFx = { arc: spawnArc, sparks: burst };
})();
