(() => {
  // ---------- Config ----------
  const FRAME_COUNT = 200;
  const SRC_W = 1920, SRC_H = 1080;
  // Horizontal band of the source frame that always contains the person
  // (measured across all 200 frames, with margin). Never cropped.
  const SAFE_W = 880;
  const BG = '#030404';
  const EASE = 0.2;           // per 60 Hz frame; lower = smoother but trails further behind
  const KEYFRAME_STEP = 8;    // load every 8th frame first for instant global scrubbing

  const canvas = document.getElementById('bg');
  const ctx = canvas.getContext('2d', { alpha: false });
  const loader = document.getElementById('loader');
  const cellFill = document.getElementById('cell-fill');
  const loaderText = document.getElementById('loader-text');
  document.getElementById('year').textContent = new Date().getFullYear();

  // ---------- Pick resolution set ----------
  // Cap DPR at 1.5 to match the 1080p source density (no wasted 4K backbuffer)
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const smallScreen = Math.min(innerWidth, innerHeight) < 700 || innerWidth < 700;
  const set = smallScreen ? 'sm' : 'lg';
  const pad = n => String(n).padStart(4, '0');
  const url = i => `frames/${set}/${pad(i + 1)}.webp`;

  // ---------- Load frames ----------
  const frames = new Array(FRAME_COUNT);
  const status = new Uint8Array(FRAME_COUNT); // 0 = unrequested, 1 = loading, 2 = loaded
  let loaded = 0, drawnOnce = false, loaderDismissed = false;
  let target = 0, current = 0, lastDrawn = -1, ticking = false;

  function loadFrame(i) {
    if (status[i] !== 0) return Promise.resolve(frames[i]);
    status[i] = 1;
    return new Promise(res => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        frames[i] = img;
        status[i] = 2;
        loaded++;
        if (!drawnOnce || Math.abs(i - current) < 1.5) draw(current);
        res(img);
      };
      img.onerror = () => {
        status[i] = 0; // allow retry
        res(null);
      };
      img.src = url(i);
    });
  }

  // Fast battery animation for instant interactivity
  function dismissLoader() {
    if (loaderDismissed) return;
    loaderDismissed = true;
    cellFill.setAttribute('width', '88');
    loaderText.textContent = 'READY';
    loader.classList.add('full');
    setTimeout(() => {
      loader.classList.add('done');
      loader.setAttribute('aria-hidden', 'true');
      setTimeout(() => loader.remove(), 800);   // gone after the fade: stops its animations
    }, 150);
  }

  function updateLoaderProgress(pct) {
    if (loaderDismissed) return;
    const clamped = Math.min(Math.max(pct, 0), 100);
    cellFill.setAttribute('width', (88 * clamped / 100).toFixed(1));
    loaderText.textContent = `Loading ${Math.round(clamped)}%`;
    if (clamped >= 100) dismissLoader();
  }

  // Concurrency-controlled proximity-aware stream manager
  const CONCURRENCY = 4;
  let activeWorkers = 0;

  function getNextFrameIndex() {
    // 1. Check if any keyframes are not yet loaded/requested
    let bestKeyframe = -1, minKeyDist = Infinity;
    for (let k = 0; k < FRAME_COUNT; k += KEYFRAME_STEP) {
      if (status[k] === 0) {
        const dist = Math.abs(k - target);
        if (dist < minKeyDist) {
          minKeyDist = dist;
          bestKeyframe = k;
        }
      }
    }
    if (bestKeyframe !== -1) return bestKeyframe;

    // Ensure the final frame is also loaded early as keyframe
    if (status[FRAME_COUNT - 1] === 0) return FRAME_COUNT - 1;

    // 2. Otherwise find the unrequested frame closest to the user's current scroll target
    let bestIndex = -1, minDist = Infinity;
    for (let i = 0; i < FRAME_COUNT; i++) {
      if (status[i] === 0) {
        const dist = Math.abs(i - target);
        if (dist < minDist) {
          minDist = dist;
          bestIndex = i;
        }
      }
    }
    return bestIndex;
  }

  function pumpQueue() {
    while (activeWorkers < CONCURRENCY) {
      const nextIdx = getNextFrameIndex();
      if (nextIdx === -1) break;
      activeWorkers++;
      loadFrame(nextIdx).then(() => {
        activeWorkers--;
        pumpQueue();
      });
    }
  }

  // Phase 1: Load frame 0 immediately, followed by initial buffer
  loadFrame(0).then(() => {
    resize();
    draw(current);
    updateLoaderProgress(60);

    // Load initial frames for smooth top-of-page scrubbing
    let initialCount = 0;
    const initialTarget = Math.min(6, FRAME_COUNT);
    for (let i = 1; i < initialTarget; i++) {
      loadFrame(i).then(() => {
        initialCount++;
        updateLoaderProgress(60 + (initialCount / (initialTarget - 1)) * 40);
        if (initialCount >= 2) dismissLoader();
      });
    }

    // Defer background frame stream until main thread completes initial layout & paint
    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => pumpQueue(), { timeout: 1200 });
    } else {
      setTimeout(pumpQueue, 250);
    }
  });

  // Guarantee loader dismissal in under 400ms even on slow networks
  setTimeout(dismissLoader, 400);

  // ---------- Layout: fit without cropping the person ----------
  let cw = 0, ch = 0, box = { x: 0, y: 0, w: 0, h: 0 };

  function resize() {
    cw = canvas.clientWidth; ch = canvas.clientHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'medium';

    const cover = Math.max(cw / SRC_W, ch / SRC_H);
    // Never scale beyond what keeps the full height (head→feet) visible,
    // and never so big that the person's horizontal band is cut off.
    const scale = Math.min(cover, ch / SRC_H, cw / SAFE_W);
    const w = SRC_W * scale, h = SRC_H * scale;
    // Character is centered horizontally; vertically centered as well.
    box = { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
    draw(current);
  }

  // ---------- Drawing with cross-fade between neighbouring frames ----------
  function nearestLoaded(i) {
    if (frames[i]) return frames[i];
    for (let d = 1; d < FRAME_COUNT; d++) {
      if (frames[i - d]) return frames[i - d];
      if (frames[i + d]) return frames[i + d];
    }
    return null;
  }

  let lastBox = { x: -1, y: -1, w: -1, h: -1 };
  let gradTop = null, gradBottom = null, gradLeft = null, gradRight = null;

  function updateGradients() {
    if (box.x === lastBox.x && box.y === lastBox.y && box.w === lastBox.w && box.h === lastBox.h) return;
    lastBox = { ...box };
    const f = 0.18;
    if (box.y > 0.5) {
      const s = box.h * f;
      gradTop = ctx.createLinearGradient(0, box.y, 0, box.y + s);
      gradTop.addColorStop(0, BG); gradTop.addColorStop(1, 'rgba(3,4,4,0)');
      gradBottom = ctx.createLinearGradient(0, box.y + box.h, 0, box.y + box.h - s);
      gradBottom.addColorStop(0, BG); gradBottom.addColorStop(1, 'rgba(3,4,4,0)');
    } else {
      gradTop = gradBottom = null;
    }
    if (box.x > 0.5) {
      const s = box.w * 0.1;
      gradLeft = ctx.createLinearGradient(box.x, 0, box.x + s, 0);
      gradLeft.addColorStop(0, BG); gradLeft.addColorStop(1, 'rgba(3,4,4,0)');
      gradRight = ctx.createLinearGradient(box.x + box.w, 0, box.x + box.w - s, 0);
      gradRight.addColorStop(0, BG); gradRight.addColorStop(1, 'rgba(3,4,4,0)');
    } else {
      gradLeft = gradRight = null;
    }
  }

  function fadeEdges() {
    updateGradients();
    if (gradTop) {
      const s = box.h * 0.18;
      ctx.fillStyle = gradTop; ctx.fillRect(0, box.y, cw, s);
      ctx.fillStyle = gradBottom; ctx.fillRect(0, box.y + box.h - s, cw, s);
    }
    if (gradLeft) {
      const s = box.w * 0.1;
      ctx.fillStyle = gradLeft; ctx.fillRect(box.x, 0, s, ch);
      ctx.fillStyle = gradRight; ctx.fillRect(box.x + box.w - s, 0, s, ch);
    }
  }

  function draw(pos) {
    const i = Math.floor(pos);
    const t = pos - i;
    const a = nearestLoaded(i);
    if (!a || !cw) return;
    drawnOnce = true;
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(a, box.x, box.y, box.w, box.h);
    const b = i + 1 < FRAME_COUNT ? frames[i + 1] : null;
    if (b && t > 0.01) {
      ctx.globalAlpha = t;
      ctx.drawImage(b, box.x, box.y, box.w, box.h);
      ctx.globalAlpha = 1;
    }
    fadeEdges();
  }

  // ---------- Scroll → frame, eased in rAF ----------
  // Page height is cached: reading scrollHeight on every scroll event forced
  // the browser to recalculate layout mid-scroll (the main cause of jank).
  // It's re-measured only when the page actually changes size.
  let maxScroll = 1;
  const measure = () => { maxScroll = Math.max(1, document.documentElement.scrollHeight - innerHeight); };
  measure();
  if ('ResizeObserver' in window) new ResizeObserver(() => { measure(); onScroll(); }).observe(document.body);
  function scrollTarget() {
    const p = Math.min(Math.max(scrollY / maxScroll, 0), 1);
    return p * (FRAME_COUNT - 1);
  }

  // Frame easing is time-based, so it feels the same on 60 Hz and 144 Hz screens
  let lastT = 0;
  function loop(now) {
    if (scrollDirty) { target = scrollTarget(); scrollDirty = false; pumpQueue(); }   // read once per frame; stream nearby frames
    const dt = lastT ? Math.min(64, now - lastT) : 16.7;
    lastT = now;
    const k = 1 - Math.pow(1 - EASE, dt / 16.7);
    current += (target - current) * k;
    if (Math.abs(target - current) < 0.01) current = target;
    if (Math.abs(current - lastDrawn) > 0.005) { draw(current); lastDrawn = current; }
    if (current !== target || scrollDirty) requestAnimationFrame(loop);
    else { ticking = false; lastT = 0; }
  }

  // The scroll handler only flags the change; the position is read inside the
  // next animation frame, so scrolling never forces an extra layout pass.
  let scrollDirty = false;
  function onScroll() {
    scrollDirty = true;
    if (!ticking) { ticking = true; requestAnimationFrame(loop); }
  }

  addEventListener('scroll', onScroll, { passive: true });
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { resize(); measure(); onScroll(); }, 100); });
  resize();
  target = current = scrollTarget();

  // ---------- LinkedIn post cards: "see more" toggle ----------
  document.querySelectorAll('.post').forEach(post => {
    const text = post.querySelector('.post-text');
    const btn = post.querySelector('.see-more');
    text.classList.add('clamped');
    btn.addEventListener('click', () => {
      const open = text.classList.toggle('clamped') === false;
      btn.textContent = open ? 'see less' : '…see more';
      btn.setAttribute('aria-expanded', open);
    });
  });

  // ---------- Nav: signal-trace indicator on the current section ----------
  // Each link gets a small oscilloscope trace (a flowing sine wave between
  // two solder pads) and an LED; both switch on when its section is on screen.
  (() => {
    const NS = 'http://www.w3.org/2000/svg';
    const links = [...document.querySelectorAll('.nav nav a[href^="#"]')];
    const P = 12, A = 3, H = 10, mid = H / 2;      // wave period, amplitude, box height

    function build(a) {
      const w = Math.max(10, a.clientWidth - 2 * parseFloat(getComputedStyle(a).getPropertyValue('--px')));
      a.querySelector('.scope')?.remove();
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'scope');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('viewBox', `0 0 ${w} ${H}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      // Wave runs one period past each edge so sliding by one period loops seamlessly
      let d = `M${-P} ${mid}`;
      for (let x = -P; x < w + P; x += P) d += `q${P / 4} ${-A * 2} ${P / 2} 0t${P / 2} 0`;
      const wave = document.createElementNS(NS, 'path');
      wave.setAttribute('class', 'wave');
      wave.setAttribute('d', d);
      wave.style.setProperty('--period', `${-P}px`);
      svg.append(wave);
      for (const cx of [1.5, w - 1.5]) {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('class', 'pad');
        c.setAttribute('cx', cx); c.setAttribute('cy', mid); c.setAttribute('r', 1.5);
        svg.append(c);
      }
      a.append(svg);
    }
    const buildAll = () => links.forEach(build);
    buildAll();
    if (document.fonts) document.fonts.ready.then(buildAll);
    let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(buildAll, 150); });

    let current = null;
    function setActive(id) {
      if (id === current) return;
      current = id;
      links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + id));
    }

    // Section in the middle of the screen = current page
    const targets = ['home', ...links.map(a => a.getAttribute('href').slice(1))]
      .map(id => document.getElementById(id)).filter(Boolean);
    const sio = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) setActive(e.target.id); });
    }, { rootMargin: '-45% 0px -45% 0px' });
    targets.forEach(t => sio.observe(t));

    links.forEach(a => a.addEventListener('click', () => setActive(a.getAttribute('href').slice(1))));
  })();

  // ---------- Photography: pop-up viewer ----------
  // Clicking a collage photo zooms it from its spot in the collage to the
  // centre of the screen (FLIP: animate from the thumbnail's box to the
  // final box). The small thumbnail shows instantly; the full-size image
  // swaps in once loaded. Close zooms it back into place.
  (() => {
    const shots = [...document.querySelectorAll('.collage .shot')];
    const viewer = document.getElementById('viewer');
    if (!shots.length || !viewer) return;
    const frame = viewer.querySelector('.viewer-frame');
    const img = viewer.querySelector('.viewer-img');
    const count = viewer.querySelector('.viewer-count');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const DUR = reduce ? 0 : 520, EASE = 'cubic-bezier(.2, .8, .2, 1)';
    let cur = -1, busy = false, anim = null, pushed = false;

    const thumbOf = i => shots[i].querySelector('img');
    function finalBox(i) {
      const t = thumbOf(i), ar = t.width / t.height;
      const small = innerWidth < 900;
      const maxW = innerWidth * (small ? .94 : .86), maxH = innerHeight * (small ? .72 : .84);
      let w = maxW, h = w / ar;
      if (h > maxH) { h = maxH; w = h * ar; }
      return { x: (innerWidth - w) / 2, y: (innerHeight - h) / 2 - (small ? 20 : 0), w, h };
    }
    const place = b => {
      frame.style.width = b.w + 'px'; frame.style.height = b.h + 'px';
      frame.style.transform = `translate(${b.x}px, ${b.y}px)`;
    };
    // One glare sweep across the photo (restartable)
    const shine = () => { frame.classList.remove('shine'); void frame.offsetWidth; frame.classList.add('shine'); };
    const fromThumb = (i, b) => {
      const r = thumbOf(i).getBoundingClientRect();
      return `translate(${r.left}px, ${r.top}px) scale(${r.width / b.w}, ${r.height / b.h})`;
    };
    function loadFull(i) {
      const src = shots[i].dataset.full, pic = new Image();
      pic.onload = () => { if (cur === i) img.src = src; };
      pic.src = src;
    }
    function label(i) {
      img.alt = thumbOf(i).alt;
      count.textContent = `${i + 1} / ${shots.length}`;
    }

    function open(i) {
      if (busy) return;
      busy = true; cur = i;
      const b = finalBox(i);
      img.src = thumbOf(i).currentSrc || thumbOf(i).src;
      label(i);
      viewer.hidden = false;
      document.documentElement.style.overflow = 'hidden';            // lock page scroll
      place(b);
      shots[i].classList.add('is-open');
      frame.classList.remove('shine');
      anim = frame.animate([{ transform: fromThumb(i, b) }, { transform: frame.style.transform }],
                           { duration: DUR, easing: EASE });
      requestAnimationFrame(() => viewer.classList.add('open'));
      anim.onfinish = () => { busy = false; shine(); };
      loadFull(i);
      viewer.querySelector('.viewer-close').focus({ preventScroll: true });
      // Add a history entry so the phone's Back button closes the photo
      // (returning to the collage) instead of leaving the site
      if (!pushed) { history.pushState({ photoViewer: true }, ''); pushed = true; }
    }

    function close() {
      if (busy || cur < 0) return;
      busy = true;
      const i = cur, b = finalBox(i);
      viewer.classList.remove('open');
      frame.classList.remove('shine');
      anim = frame.animate([{ transform: frame.style.transform }, { transform: fromThumb(i, b) }],
                           { duration: DUR, easing: EASE, fill: 'forwards' });
      anim.onfinish = () => {
        viewer.hidden = true; anim.cancel();
        shots[i].classList.remove('is-open');
        document.documentElement.style.overflow = '';
        shots[i].focus({ preventScroll: true });
        cur = -1; busy = false;
      };
    }

    function go(d) {
      if (busy || cur < 0) return;
      busy = true;
      const from = cur, to = (cur + d + shots.length) % shots.length;
      const out = frame.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: `${-d * 40}px 0` }],
                              { duration: reduce ? 0 : 180, easing: 'ease-in', fill: 'forwards' });
      out.onfinish = () => {
        shots[from].classList.remove('is-open');
        shots[to].classList.add('is-open');
        cur = to;
        img.src = thumbOf(to).currentSrc || thumbOf(to).src;
        label(to);
        place(finalBox(to));
        out.cancel();
        const inn = frame.animate([{ opacity: 0, translate: `${d * 40}px 0` }, { opacity: 1, translate: '0 0' }],
                                { duration: reduce ? 0 : 260, easing: 'ease-out' });
        inn.onfinish = () => { busy = false; shine(); };
        loadFull(to);
      };
    }

    // Mouse: one click opens. Touch screens: a single tap plays the golden
    // glare, a double tap opens the photo.
    const touch = matchMedia('(hover: none), (pointer: coarse)').matches;
    let lastTap = { i: -1, t: 0 };
    shots.forEach((s, i) => s.addEventListener('click', e => {
      if (!touch) { open(i); return; }
      const now = performance.now();
      if (lastTap.i === i && now - lastTap.t < 380) { lastTap = { i: -1, t: 0 }; open(i); return; }
      lastTap = { i, t: now };
      s.classList.remove('tapped'); void s.offsetWidth; s.classList.add('tapped');
    }));
    shots.forEach(s => s.addEventListener('animationend', () => s.classList.remove('tapped')));
    if (touch) {
      const hint = document.querySelector('#photos .sub');
      if (hint) hint.textContent = 'Shot on my phone. Double-tap any photo to view it.';
    }
    // Collage: one glare wave across every photo the first time it's seen
    const collage = document.querySelector('.collage');
    new IntersectionObserver((es, o) => {
      if (es[0].isIntersecting) { collage.classList.add('glint'); o.disconnect(); }
    }, { threshold: 0.25 }).observe(collage);
    // Closing from the page (x, backdrop, photo, Esc) steps back through the
    // history entry we added; the Back button does the same thing directly.
    const requestClose = () => {
      if (cur < 0) return;
      if (pushed) history.back(); else close();
    };
    addEventListener('popstate', () => {
      if (!pushed) return;
      pushed = false;
      if (cur < 0) return;
      if (busy) setTimeout(close, DUR + 30); else close();
    });
    viewer.querySelector('.viewer-backdrop').addEventListener('click', requestClose);
    frame.addEventListener('click', requestClose);
    viewer.querySelector('.viewer-close').addEventListener('click', requestClose);
    viewer.querySelector('.viewer-prev').addEventListener('click', () => go(-1));
    viewer.querySelector('.viewer-next').addEventListener('click', () => go(1));
    addEventListener('keydown', e => {
      if (cur < 0) return;
      if (e.key === 'Escape') requestClose();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    });
    // Swipe left / right on phones
    let sx = null;
    viewer.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    viewer.addEventListener('touchend', e => {
      if (sx === null) return;
      const dx = e.changedTouches[0].clientX - sx; sx = null;
      if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    });
    addEventListener('resize', () => { if (cur >= 0 && !busy) place(finalBox(cur)); });
  })();

  // ---------- Photography: circuit traces joining the collage ----------
  // Same look as the Skills circuit. Photos in a column are joined top to
  // bottom through the gaps; each photo is also wired across the column gap
  // to the photo beside it. Current pulses flow through every trace, and
  // the traces touching a photo light up when you hover it.
  (() => {
    const wrap = document.querySelector('.collage-wrap');
    if (!wrap) return;
    const svg = wrap.querySelector('.collage-wires');
    const items = [...wrap.querySelectorAll('.collage .shot')];
    const NS = 'http://www.w3.org/2000/svg';
    const el = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };

    function draw() {
      const base = wrap.getBoundingClientRect();
      if (!base.width) return;
      const R = items.map(it => {
        const r = it.getBoundingClientRect();
        const l = r.left - base.left, t = r.top - base.top;
        return { l, t, r: l + r.width, b: t + r.height, cx: l + r.width / 2, cy: t + r.height / 2 };
      });
      // Group into columns by x position
      const cols = [];
      R.forEach((b, i) => {
        let c = cols.find(c => Math.abs(c.x - b.l) < 4);
        if (!c) cols.push(c = { x: b.l, ids: [] });
        c.ids.push(i);
      });
      cols.sort((a, b) => a.x - b.x).forEach(c => c.ids.sort((a, b) => R[a].t - R[b].t));

      svg.replaceChildren();
      const segs = [];
      // Down each column
      cols.forEach(c => c.ids.slice(1).forEach((id, k) => {
        const a = R[c.ids[k]], b = R[id];
        const x = a.cx + (k % 2 ? 14 : -14);               // offset so it isn't dead centre
        segs.push({ d: `M${x} ${a.b}V${b.t}`, a: c.ids[k], b: id });
      }));
      // Across to the next column, at a height both photos share
      cols.slice(0, -1).forEach((c, ci) => c.ids.forEach((id, k) => {
        if (k % 2) return;                                  // every other photo keeps it tidy
        const a = R[id];
        const next = cols[ci + 1].ids.map(j => R[j]);
        const j = next.findIndex(b => b.t < a.b - 12 && b.b > a.t + 12);
        if (j < 0) return;
        const b = next[j];
        const y = Math.round((Math.max(a.t, b.t) + Math.min(a.b, b.b)) / 2);
        segs.push({ d: `M${a.r} ${y}H${b.l}`, a: id, b: cols[ci + 1].ids[j] });
      }));

      let all = '';
      segs.forEach(sg => {
        all += sg.d;
        const p = el('path', { class: 'wire', d: sg.d });
        p.dataset.a = sg.a; p.dataset.b = sg.b;
        svg.append(p);
      });
      svg.append(el('path', { class: 'pulse', d: all }));
      segs.forEach(sg => {
        const m = sg.d.match(/^M([\d.]+) ([\d.]+)([HV])([\d.]+)$/);
        if (!m) return;
        const [x1, y1, x2, y2] = m[3] === 'H' ? [m[1], m[2], m[4], m[2]] : [m[1], m[2], m[1], m[4]];
        svg.append(el('circle', { class: 'pad', cx: x1, cy: y1, r: 3 }));
        svg.append(el('circle', { class: 'pad', cx: x2, cy: y2, r: 3 }));
      });
    }

    items.forEach((it, i) => {
      const set = on => svg.querySelectorAll('.wire').forEach(p => {
        if (+p.dataset.a === i || +p.dataset.b === i) p.classList.toggle('hot', on);
      });
      it.addEventListener('pointerenter', () => set(true));
      it.addEventListener('pointerleave', () => set(false));
    });
    if ('ResizeObserver' in window) new ResizeObserver(draw).observe(wrap);
    addEventListener('load', draw);
    draw();
  })();

  // ---------- Performance: pause what can't be seen ----------
  // Off-screen sections pause their looping CSS animations; they resume the
  // moment they scroll back into view.
  (() => {
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(es => es.forEach(e => e.target.classList.toggle('is-off', !e.isIntersecting)),
                                        { rootMargin: '0px' });
    document.querySelectorAll('main > section').forEach(sec => io.observe(sec));
  })();

  // ---------- Block copying ----------
  // CSS already stops selection; this also blocks Ctrl+C / Ctrl+X / Ctrl+A
  // and dragging content out of the page.
  ['copy', 'cut', 'selectstart', 'dragstart'].forEach(type =>
    document.addEventListener(type, e => e.preventDefault()));
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && ['a', 'c', 'x'].includes(e.key.toLowerCase())) e.preventDefault();
  });

  // ---------- Headings: split into letters for the electric animations ----------
  // Each character becomes <span class="ch" style="--i:n"> so the fill can
  // ripple through the word letter by letter. Screen readers get the
  // original text through aria-label.
  document.querySelectorAll('h1, section h2').forEach(h => {
    h.setAttribute('aria-label', h.innerText.replace(/\s+/g, ' ').trim());   // innerText keeps the <br> as a space
    let i = 0;
    [...h.childNodes].forEach(node => {
      if (node.nodeType !== 3) return;               // keep <br> etc.
      const frag = document.createDocumentFragment();
      // Words stay unbreakable (span.word); spaces stay real text so lines
      // still wrap between words, never inside one.
      for (const part of node.textContent.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { frag.append(document.createTextNode(' ')); i++; continue; }
        const w = document.createElement('span');
        w.className = 'word';
        w.setAttribute('aria-hidden', 'true');
        for (const c of part) {
          const s = document.createElement('span');
          s.className = 'ch';
          s.style.setProperty('--i', i++);
          s.textContent = c;
          w.append(s);
        }
        frag.append(w);
      }
      node.replaceWith(frag);
    });
  });

  // ---------- Headings: power-on when landing, decryption on hover ----------
  (() => {
    const titles = [...document.querySelectorAll('h1, section h2')];
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !('IntersectionObserver' in window)) { titles.forEach(h => h.classList.add('on')); return; }

    titles.forEach(h => h.classList.add('off'));

    // Landing: strike the title when it comes into view. It replays each time
    // you come back to it after it has left the screen completely.
    const tio = new IntersectionObserver(entries => entries.forEach(e => {
      const h = e.target;
      if (e.intersectionRatio >= 0.6 && h.classList.contains('off')) {
        h.classList.replace('off', 'landing');
        const letters = h.querySelectorAll('.ch');
        letters[letters.length - 1].addEventListener('animationend', () => {
          h.classList.replace('landing', 'on');
        }, { once: true });
      } else if (!e.isIntersecting && h.classList.contains('on')) {        // fully off screen: re-arm
        h.classList.replace('on', 'off');
      }
    }), { threshold: [0, 0.6] });
    // The hero name waits until the loading screen has faded, so it isn't
    // powered on behind it
    const loaderEl = document.getElementById('loader');
    titles.forEach(h => {
      if (h.tagName !== 'H1' || !loaderEl || loaderEl.classList.contains('done')) { tio.observe(h); return; }
      const mo = new MutationObserver(() => {
        if (loaderEl.classList.contains('done')) { mo.disconnect(); setTimeout(() => tio.observe(h), 350); }
      });
      mo.observe(loaderEl, { attributes: true, attributeFilter: ['class'] });
    });


    // Hover: "decryption". Letters scramble through random characters, then
    // decode back to the real text one by one, left to right.
    const GLYPHS = '01<>/\[]{}#$%&*+=?!ABCDEF0123456789';
    const rnd = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
    titles.forEach(h => {
      const letters = [...h.querySelectorAll('.ch')];
      letters.forEach(l => { l.dataset.c = l.textContent; });
      let timer = 0;
      h.addEventListener('pointerenter', () => {
        if (!h.classList.contains('on') || timer) return;
        // Freeze each letter's width so random glyphs don't make the word jump
        letters.forEach(l => {
          l.style.width = l.getBoundingClientRect().width + 'px';
          l.style.textAlign = 'center';
          l.classList.remove('lock');
          l.classList.add('enc');
        });
        const start = performance.now(), SCRAMBLE = 260, PER = 55;   // ms
        timer = setInterval(() => {
          const t = performance.now() - start;
          let pending = 0;
          letters.forEach((l, k) => {
            if (!l.classList.contains('enc')) return;
            if (t >= SCRAMBLE + k * PER) {                             // decode this one
              l.textContent = l.dataset.c;
              l.classList.remove('enc'); l.classList.add('lock');
              l.style.width = ''; l.style.textAlign = '';
            } else { l.textContent = rnd(); pending++; }
          });
          if (!pending) { clearInterval(timer); timer = 0; }
        }, 45);
      });
    });
  })();

  // ---------- LinkedIn videos: autoplay muted while on screen ----------
  // Browsers only allow autoplay when muted. Playing on visibility (instead of
  // the autoplay attribute) avoids downloading both videos at page load and
  // pauses them when scrolled away. Viewers can unmute with the controls.
  const postVideos = document.querySelectorAll('.post-video');
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const vio = new IntersectionObserver(entries => entries.forEach(e => {
      const v = e.target;
      if (e.isIntersecting) { v.muted = v.dataset.userUnmuted ? v.muted : true; v.play().catch(() => {}); }
      else v.pause();
    }), { threshold: 0.5 });
    postVideos.forEach(v => {
      v.addEventListener('volumechange', () => { if (!v.muted) v.dataset.userUnmuted = '1'; });
      vio.observe(v);
    });
  }

  // ---------- Skills circuit: wire the tags together in series ----------
  const tagWrap = document.querySelector('.tag-circuit');
  if (tagWrap) {
    const svg = tagWrap.querySelector('.tag-wires');
    const tags = [...tagWrap.querySelectorAll('.tags li')];
    const NS = 'http://www.w3.org/2000/svg';
    const el = (name, attrs) => {
      const n = document.createElementNS(NS, name);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    };

    function drawWires() {
      const base = tagWrap.getBoundingClientRect();
      // offsetTop/Left ignore the hover lift, so wires don't jump
      const r = tags.map(li => {
        const x = li.offsetLeft + li.parentElement.offsetLeft;
        const y = li.offsetTop + li.parentElement.offsetTop;
        const w = li.offsetWidth, h = li.offsetHeight;
        return { l: x, r: x + w, t: y, b: y + h, cx: x + w / 2, cy: y + h / 2 };
      });
      if (!r.length || !base.width) return;
      svg.replaceChildren();
      let all = '';
      const segs = [];

      // Source terminal (AC supply ~) feeding the first tag
      const f = r[0];
      const sx = f.l - 22;
      segs.push({ d: `M${sx + 7} ${f.cy}H${f.l}`, a: -1, b: 0 });
      svg.append(el('circle', { class: 'sym', cx: sx, cy: f.cy, r: 7 }));
      svg.append(el('path', { class: 'sym', d: `M${sx - 4} ${f.cy}q2 -4 4 0t4 0` }));

      for (let i = 0; i < r.length - 1; i++) {
        const a = r[i], b = r[i + 1];
        let d;
        if (Math.abs(a.cy - b.cy) < 4) {
          d = `M${a.r} ${a.cy}H${b.l}`;                 // same row: straight across
        } else {
          const mid = (a.b + b.t) / 2;                    // next row: drop, cross, drop
          d = `M${a.cx} ${a.b}V${mid}H${b.cx}V${b.t}`;
        }
        segs.push({ d, a: i, b: i + 1 });
      }

      // Last tag down to ground
      const z = r[r.length - 1];
      const gx = z.r + 22;
      segs.push({ d: `M${z.r} ${z.cy}H${gx}V${z.cy + 10}`, a: r.length - 1, b: -1 });
      svg.append(el('path', { class: 'sym', d: `M${gx - 8} ${z.cy + 10}h16M${gx - 5} ${z.cy + 14}h10M${gx - 2} ${z.cy + 18}h4` }));

      segs.forEach(s => {
        all += s.d;
        const p = el('path', { class: 'wire', d: s.d });
        p.dataset.a = s.a; p.dataset.b = s.b;
        svg.append(p);
      });
      svg.append(el('path', { class: 'pulse', d: all }));

      // Solder pads where wires meet a tag
      segs.forEach(s => {
        const m = s.d.match(/^M([\d.]+) ([\d.]+)/);
        const end = s.d.match(/([HV])([\d.]+)$/);
        if (m) svg.append(el('circle', { class: 'pad', cx: m[1], cy: m[2], r: 3.2 }));
        if (end && s.b !== -1) {
          // walk the path to find the final point
          let x = +m[1], y = +m[2];
          s.d.replace(/([HV])([\d.]+)/g, (_, c, v) => { if (c === 'H') x = +v; else y = +v; });
          svg.append(el('circle', { class: 'pad', cx: x, cy: y, r: 3.2 }));
        }
      });
    }

    // Light up the wires touching a hovered tag
    tags.forEach((li, i) => {
      const set = on => svg.querySelectorAll('.wire').forEach(p => {
        if (+p.dataset.a === i || +p.dataset.b === i) p.classList.toggle('hot', on);
      });
      li.addEventListener('pointerenter', () => set(true));
      li.addEventListener('pointerleave', () => set(false));
    });

    if ('ResizeObserver' in window) new ResizeObserver(drawWires).observe(tagWrap);
    if (document.fonts) document.fonts.ready.then(drawWires);
    drawWires();
  }

  // ---------- Flip cards: tap to flip on touch screens ----------
  document.querySelectorAll('.flip').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('a')) return;            // let links work
      if (matchMedia('(hover: hover)').matches) return;
      card.classList.toggle('flipped');
    });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.classList.toggle('flipped'); }
    });
  });

  // ---------- Reveal text ----------
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => e.target.classList.toggle('in', e.isIntersecting));
  }, { threshold: 0.2 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
})();
