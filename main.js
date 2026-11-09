(() => {
  // ---------- Config ----------
  const FRAME_COUNT = 200;
  const SRC_W = 1920, SRC_H = 1080;
  // Horizontal band of the source frame that always contains the person
  // (measured across all 200 frames, with margin). Never cropped.
  const SAFE_W = 880;
  const BG = '#030404';
  const EASE = 0.12;          // lower = smoother/laggier frame interpolation
  const KEYFRAME_STEP = 8;    // load every 8th frame first for instant global scrubbing

  const canvas = document.getElementById('bg');
  const ctx = canvas.getContext('2d', { alpha: false });
  const loader = document.getElementById('loader');
  const cellFill = document.getElementById('cell-fill');
  const loaderText = document.getElementById('loader-text');
  document.getElementById('year').textContent = new Date().getFullYear();

  // ---------- Pick resolution set ----------
  // Cap DPR at 1.5 to match 1080p source density and eliminate massive 4K backbuffer memory waste
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
  function scrollTarget() {
    const max = document.documentElement.scrollHeight - innerHeight;
    const p = max > 0 ? Math.min(Math.max(scrollY / max, 0), 1) : 0;
    return p * (FRAME_COUNT - 1);
  }

  function loop() {
    current += (target - current) * EASE;
    if (Math.abs(target - current) < 0.002) current = target;
    if (Math.abs(current - lastDrawn) > 0.001) { draw(current); lastDrawn = current; }
    if (current !== target) requestAnimationFrame(loop);
    else ticking = false;
  }

  function onScroll() {
    target = scrollTarget();
    if (!ticking) { ticking = true; requestAnimationFrame(loop); }
    pumpQueue();
  }

  addEventListener('scroll', onScroll, { passive: true });
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { resize(); onScroll(); }, 100); });
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

  // ---------- Block copying ----------
  // CSS already stops selection; this also blocks Ctrl+C / Ctrl+X / Ctrl+A
  // and dragging content out of the page.
  ['copy', 'cut', 'selectstart', 'dragstart'].forEach(type =>
    document.addEventListener(type, e => e.preventDefault()));
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && ['a', 'c', 'x'].includes(e.key.toLowerCase())) e.preventDefault();
  });

  // ---------- Headings: split into letters for the liquid hover ----------
  // Each character becomes <span class="ch" style="--i:n"> so the fill can
  // ripple through the word letter by letter. Screen readers get the
  // original text through aria-label.
  document.querySelectorAll('h1, section h2').forEach(h => {
    h.setAttribute('aria-label', h.textContent.replace(/\s+/g, ' ').trim());
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
