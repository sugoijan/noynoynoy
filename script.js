(() => {
  const debugSecret = 'noyiscute';
  const field = document.getElementById('field');
  const hud = document.getElementById('hud');
  const targetEl = document.getElementById('target');
  const startBtn = document.getElementById('startButton');
  const restartBtn = document.getElementById('restartBtn');
  const msg = document.getElementById('msg');
  const debugCanvas = document.getElementById('debugCanvas');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModal = document.getElementById('settingsModal');
  const advancedToggle = document.getElementById('advancedToggle');
  const closeSettings = document.getElementById('closeSettings');

  const state = {
    running: false,
    target: { x: 0, y: 0 },
    targetSize: 48,
    pointer: { x: -9999, y: -9999 },
    noyImage: { w: 0, h: 0, loaded: false },
    // Single source of truth for tuning
    config: {
      // Level mapping uses closeness = 1 - dist / (factor * viewportDiagonal)
      maxDistanceFactor: 0.75,
      // Boundaries between levels 0-1, 1-2, ..., 4-5 in closeness [0..1]
      levelBreakpoints: [1/6, 3.4/6, 4.5/6, 5.2/6, 5.7/6],
      // Audible gain targets per level (0..5)
      volumes: [0.7, 0.8, 0.9, 0.95, 0.98, 1.0],
      // px — image reveals and becomes clickable inside this
      revealRadius: 15,
      // Reveal animation tuning
      revealAnimMs: 800,
      revealEase: 'cubic-bezier(0.4, 0, 1, 1)', // starts slow then accelerates
      centerOnReveal: true, // move image to screen center while revealing
      // Playable area configuration
      playArea: {
        margin: 24,      // px margin from viewport edges
        hudPadding: 12,  // px extra gap below the HUD
      },
    },
    debug: { on: false, ctx: null, dpr: 1 },
    settings: { advanced: false },
    audio: {
      ctx: null,
      master: null,
      buffers: [], // AudioBuffer[6]
      loopDur: 1.2, // seconds — will be updated to min(buffer durations)
      xfade: 0.12,  // seconds — quick fade to avoid clicks
      minGain: 0.0001,
      levelGains: [], // GainNode[6]
      levelSources: [], // AudioBufferSourceNode[6]
      currentLevel: -1,
    },
  };

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  function loadSettings() {
    try {
      const v = localStorage.getItem('noy.advanced');
      state.settings.advanced = v === '1' || v === 'true';
    } catch {}
  }

  function saveSettings() {
    try {
      localStorage.setItem('noy.advanced', state.settings.advanced ? '1' : '0');
    } catch {}
  }

  function applyConfigToStyles() {
    const root = document.documentElement;
    try {
      root.style.setProperty('--reveal-duration', `${state.config.revealAnimMs}ms`);
      root.style.setProperty('--reveal-ease', state.config.revealEase);
    } catch {}
  }

  // Preload noy.png to know its natural size for the reveal animation
  (function preloadNoy() {
    const img = new Image();
    img.onload = () => {
      state.noyImage.w = img.naturalWidth || img.width;
      state.noyImage.h = img.naturalHeight || img.height;
      state.noyImage.loaded = true;
    };
    // Start loading immediately
    img.src = 'img/noy.png';
  })();

  function randomizeTarget() {
    const area = getPlayableArea();
    const x = Math.random() * Math.max(1, area.w) + area.x;
    const y = Math.random() * Math.max(1, area.h) + area.y;
    state.target.x = x;
    state.target.y = y;
    placeTarget();
  }

  function placeTarget() {
    targetEl.style.left = state.target.x + 'px';
    targetEl.style.top = state.target.y + 'px';
    drawDebug();
  }

  async function setupAudio() {
    if (state.audio.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = 0.7; // headroom for crossfades
    master.connect(ctx.destination);
    state.audio.ctx = ctx;
    state.audio.master = master;
    // Prepare per-level gains; sources are created when starting loops
    state.audio.levelGains = Array.from({ length: 6 }, () => {
      const g = ctx.createGain();
      g.gain.value = state.audio.minGain;
      g.connect(master);
      return g;
    });
  }

  async function loadBuffers() {
    if (state.audio.buffers.length === 6) return;
    const files = [1,2,3,4,5,6].map(i => `audio/noy${i}.ogg`);
    const ctx = state.audio.ctx;
    const buffers = [];
    for (const f of files) {
      const res = await fetch(f);
      const arr = await res.arrayBuffer();
      const buf = await ctx.decodeAudioData(arr);
      buffers.push(buf);
    }
    state.audio.buffers = buffers;
  }

  function levelFromDistance(dist) {
    // Normalize by viewport diagonal scaled by config factor
    const maxDist = Math.hypot(window.innerWidth, window.innerHeight) * state.config.maxDistanceFactor;
    const closeness = clamp(1 - dist / maxDist, 0, 1); // 0..1
    const bp = state.config.levelBreakpoints || [];
    for (let i = 0; i < 5; i++) {
      if (closeness < (bp[i] ?? ((i+1)/6))) return i;
    }
    return 5;
  }

  function maxLevelDistance() {
    return Math.hypot(window.innerWidth, window.innerHeight) * state.config.maxDistanceFactor;
  }

  function computeDesiredLevel() {
    // Fallback to screen center if pointer hasn't been initialized yet
    const px = (state.pointer.x < 0 || state.pointer.y < 0)
      ? Math.round(window.innerWidth / 2)
      : state.pointer.x;
    const py = (state.pointer.x < 0 || state.pointer.y < 0)
      ? Math.round(window.innerHeight / 2)
      : state.pointer.y;
    const dx = px - state.target.x;
    const dy = py - state.target.y;
    const dist = Math.hypot(dx, dy);
    const idx = levelFromDistance(dist);

    // Near behavior: make area clickable and show hand cursor
    const near = dist <= state.config.revealRadius;
    updateCursor(near);
    targetEl.style.pointerEvents = near ? 'auto' : 'none';
    return idx;
  }

  function startAllLoops() {
    const a = state.audio;
    const ctx = a.ctx;
    if (!ctx || a.buffers.length !== 6) return;

    // Stop and clear any previous sources
    a.levelSources.forEach(s => { try { s.stop(); } catch {} });
    a.levelSources = [];

    // Use the shortest buffer duration to keep loops aligned
    a.loopDur = Math.min(...a.buffers.map(b => b.duration));
    const startT = ctx.currentTime + 0.05;

    for (let i = 0; i < 6; i++) {
      const src = ctx.createBufferSource();
      src.buffer = a.buffers[i];
      src.loop = true;
      src.loopStart = 0;
      src.loopEnd = a.loopDur;
      src.connect(a.levelGains[i]);
      try { src.start(startT); } catch {}
      a.levelSources.push(src);
    }
  }

  function setActiveLevel(idx) {
    const a = state.audio;
    if (!a.ctx || a.levelGains.length !== 6) return;
    if (idx === a.currentLevel) return;
    const now = a.ctx.currentTime;
    for (let i = 0; i < 6; i++) {
      const g = a.levelGains[i].gain;
      const target = (i === idx) ? state.config.volumes[i] : a.minGain;
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(target, now + a.xfade);
      } catch {}
    }
    a.currentLevel = idx;
    drawDebug();
  }

  function primePointerFromEvent(e) {
    // Seed pointer from click/tap location or fallback to center
    if (e && typeof e.clientX === 'number' && typeof e.clientY === 'number' && (e.clientX !== 0 || e.clientY !== 0)) {
      state.pointer.x = e.clientX;
      state.pointer.y = e.clientY;
    } else if (state.pointer.x < 0 || state.pointer.y < 0) {
      state.pointer.x = Math.round(window.innerWidth / 2);
      state.pointer.y = Math.round(window.innerHeight / 2);
    }
  }

  async function startGame(e) {
    // Capture initial pointer position before audio starts
    primePointerFromEvent(e);
    await setupAudio();
    // Load and prime audio inside user gesture
    await state.audio.ctx.resume().catch(() => {});
    try { await loadBuffers(); } catch (e) {
      console.warn('Audio buffer load failed. Serve files via http(s).', e);
    }

    // Start all loops in sync and keep them muted until the first level is chosen
    startAllLoops();

    randomizeTarget();
    targetEl.classList.remove('found');
    targetEl.style.opacity = 0; // keep hidden until win
    targetEl.style.pointerEvents = 'none';
    msg.textContent = 'Move around to find the hidden Noy.';
    startBtn.classList.add('hidden');
    restartBtn.classList.add('hidden');
    state.running = true;

    // Initialize audible level based on current pointer position
    const level = computeDesiredLevel();
    setActiveLevel(level);
    drawDebug();
  }

  function stopSound() {
    const a = state.audio;
    if (!a.ctx) return;
    const now = a.ctx.currentTime;
    // Fade all levels to silence and optionally suspend context to save CPU
    a.levelGains.forEach(g => {
      try {
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(a.minGain, now + a.xfade);
      } catch {}
    });
    a.currentLevel = -1;
    try { a.ctx.suspend(); } catch {}
  }

  function onPointerMove(e) {
    state.pointer.x = e.clientX;
    state.pointer.y = e.clientY;
    // Keep cursor updated regardless of running; audio only when running
    const level = computeDesiredLevel();
    if (state.running) setActiveLevel(level);
    drawDebug();
  }

  function onResize() {
    // Keep the target within playable area if user resizes/rotates
    const area = getPlayableArea();
    state.target.x = clamp(state.target.x, area.x, area.x + Math.max(0, area.w));
    state.target.y = clamp(state.target.y, area.y, area.y + Math.max(0, area.h));
    placeTarget();
    const level = computeDesiredLevel();
    setActiveLevel(level);
    drawDebug();
  }

  function win() {
    if (!state.running) return;
    state.running = false;
    // Compute final displayed size (natural size, capped to fit viewport with margin)
    const natW = state.noyImage.loaded ? state.noyImage.w : 512;
    const natH = state.noyImage.loaded ? state.noyImage.h : 512;
    const margin = 20;
    const maxW = Math.max(60, window.innerWidth - margin * 2);
    const maxH = Math.max(60, window.innerHeight - margin * 2);
    const fit = Math.min(1, maxW / natW, maxH / natH);
    const finalW = Math.round(natW * fit);
    const finalH = Math.round(natH * fit);

    // Set the element box to the final size, then animate scale from 0.05 -> 1 via CSS
    targetEl.style.width = finalW + 'px';
    targetEl.style.height = finalH + 'px';
    // Optionally move to viewport center while scaling up
    if (state.config.centerOnReveal) {
      const centerX = Math.round(window.innerWidth / 2);
      const centerY = Math.round(window.innerHeight / 2);
      targetEl.style.left = centerX + 'px';
      targetEl.style.top = centerY + 'px';
    }
    // Trigger reveal (image + scale animation)
    targetEl.classList.add('found');
    targetEl.style.opacity = 1;
    stopSound();
    msg.textContent = 'You found Noy!';
    restartBtn.classList.remove('hidden');
    field.classList.remove('hot');
    drawDebug();
  }

  // Event wiring
  startBtn.addEventListener('click', (e) => startGame(e));
  restartBtn.addEventListener('click', async () => {
    // Restart logic
    state.running = true;
    try { await state.audio.ctx.resume(); } catch {}
    // Ensure styles reflect latest config and loops are running in sync
    applyConfigToStyles();
    if (state.audio.buffers.length !== 6) {
      try { await loadBuffers(); } catch {}
    }
    startAllLoops();
    state.audio.currentLevel = -1; // force level ramp on first update
    randomizeTarget();
    targetEl.classList.remove('found');
    targetEl.style.opacity = 0; // hide again
    // Reset size back to default box
    targetEl.style.width = '48px';
    targetEl.style.height = '48px';
    targetEl.style.pointerEvents = 'none';
    field.classList.remove('hot');
    restartBtn.classList.add('hidden');
    msg.textContent = 'Move around to find the hidden Noy.';
    // Re-evaluate level immediately
    const level = computeDesiredLevel();
    setActiveLevel(level);
    drawDebug();
  });
  field.addEventListener('pointermove', onPointerMove);
  field.addEventListener('pointerdown', onPointerMove);
  field.addEventListener('pointerleave', () => { field.style.cursor = 'default'; });
  field.addEventListener('click', (e) => {
    if (!state.running) return;
    // Ignore UI buttons
    if (
      e.target === startBtn ||
      e.target === restartBtn ||
      e.target === settingsBtn ||
      (hud && hud.contains(e.target)) ||
      (settingsModal && settingsModal.contains(e.target))
    ) return;
    const dx = state.pointer.x - state.target.x;
    const dy = state.pointer.y - state.target.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= state.config.revealRadius) win();
  });
  window.addEventListener('resize', onResize);
  targetEl.addEventListener('click', win);

  // Settings modal wiring
  function openSettings() {
    if (!settingsModal) return;
    if (advancedToggle) advancedToggle.checked = !!state.settings.advanced;
    settingsModal.classList.remove('hidden');
    settingsModal.setAttribute('aria-hidden', 'false');
  }
  function closeSettingsModal() {
    if (!settingsModal) return;
    settingsModal.classList.add('hidden');
    settingsModal.setAttribute('aria-hidden', 'true');
  }
  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
  if (closeSettings) closeSettings.addEventListener('click', closeSettingsModal);
  if (settingsModal) settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
  });
  if (advancedToggle) advancedToggle.addEventListener('change', () => {
    state.settings.advanced = !!advancedToggle.checked;
    saveSettings();
    // Refresh cursor/pointer behavior immediately
    const idx = computeDesiredLevel();
    if (state.running) setActiveLevel(idx);
    drawDebug();
  });

  // Close settings with Escape
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal && !settingsModal.classList.contains('hidden')) {
      closeSettingsModal();
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // Accessibility: keyboard hint — arrow keys nudge a virtual pointer
  window.addEventListener('keydown', (e) => {
    if (!state.running) return;
    const step = e.shiftKey ? 12 : 6;
    let used = true;
    switch (e.key) {
      case 'ArrowLeft': state.pointer.x -= step; break;
      case 'ArrowRight': state.pointer.x += step; break;
      case 'ArrowUp': state.pointer.y -= step; break;
      case 'ArrowDown': state.pointer.y += step; break;
      default: used = false; break;
    }
    if (used) {
      state.pointer.x = clamp(state.pointer.x, 0, window.innerWidth);
      state.pointer.y = clamp(state.pointer.y, 0, window.innerHeight);
      const level = computeDesiredLevel();
      setActiveLevel(level);
      drawDebug();
      e.preventDefault();
    }
  });

  // Initial idle state: show Start overlay

  // -------- Debug overlay --------
  function setDebugMode(on) {
    state.debug.on = !!on;
    if (!debugCanvas) return;
    debugCanvas.classList.toggle('hidden', !state.debug.on);
    if (state.debug.on && !state.debug.ctx) {
      state.debug.ctx = debugCanvas.getContext('2d');
    }
    drawDebug();
  }

  function sizeDebugCanvas() {
    if (!state.debug.on || !debugCanvas || !state.debug.ctx) return;
    const dpr = window.devicePixelRatio || 1;
    state.debug.dpr = dpr;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    if (debugCanvas.width !== w || debugCanvas.height !== h) {
      debugCanvas.width = w;
      debugCanvas.height = h;
      debugCanvas.style.width = cssW + 'px';
      debugCanvas.style.height = cssH + 'px';
    }
    const ctx = state.debug.ctx;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(dpr, dpr);
  }

  function drawDebug() {
    if (!state.debug.on || !debugCanvas) return;
    if (!state.debug.ctx) state.debug.ctx = debugCanvas.getContext('2d');
    if (!state.debug.colors) loadDebugColors();
    sizeDebugCanvas();
    const ctx = state.debug.ctx;
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    const cx = state.target.x;
    const cy = state.target.y;
    const rMax = maxLevelDistance();

    // Playable area rectangle
    const pa = getPlayableArea();
    ctx.beginPath();
    ctx.rect(pa.x, pa.y, pa.w, pa.h);
    ctx.strokeStyle = state.debug.colors.playArea;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Outer boundary for reference
    ctx.beginPath();
    ctx.arc(cx, cy, rMax, 0, Math.PI * 2);
    ctx.strokeStyle = state.debug.colors.ringOuter;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    ctx.stroke();

    // Concentric level boundaries from configured breakpoints
    const bp = state.config.levelBreakpoints || [];
    for (let i = 0; i < 5; i++) {
      const closeness = bp[i] ?? ((i+1)/6);
      const r = (1 - closeness) * rMax;
      if (r <= 0.5) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = state.debug.colors.ring;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Reveal radius
    ctx.beginPath();
    ctx.arc(cx, cy, state.config.revealRadius, 0, Math.PI * 2);
    ctx.strokeStyle = state.debug.colors.reveal;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Target marker
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = state.debug.colors.targetDot || 'rgba(255, 80, 80, 0.9)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy);
    ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10);
    ctx.lineTo(cx, cy + 10);
    ctx.strokeStyle = state.debug.colors.targetCross || 'rgba(255, 80, 80, 0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Pointer + info
    const px = (state.pointer.x < 0 || state.pointer.y < 0) ? Math.round(w / 2) : state.pointer.x;
    const py = (state.pointer.x < 0 || state.pointer.y < 0) ? Math.round(h / 2) : state.pointer.y;
    const dx = px - cx;
    const dy = py - cy;
    const dist = Math.hypot(dx, dy);
    const lvl = levelFromDistance(dist);

    // Line from pointer to target
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(cx, cy);
    ctx.strokeStyle = state.debug.colors.pointerLine;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Pointer dot
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = state.debug.colors.pointerDot;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, Math.PI * 2);
    ctx.strokeStyle = state.debug.colors.pointerRing;
    ctx.stroke();

    // HUD text
    const pad = 10;
    ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
    ctx.fillStyle = state.debug.colors.labelFg;
    ctx.textBaseline = 'top';
    const text = `debug: level ${lvl}  dist ${dist.toFixed(1)}  rMax ${rMax.toFixed(1)}`;
    const metrics = ctx.measureText(text);
    ctx.fillStyle = state.debug.colors.labelBg;
    ctx.fillRect(pad - 4, pad - 2, metrics.width + 8, 18);
    ctx.fillStyle = state.debug.colors.labelFg;
    ctx.fillText(text, pad, pad);
  }

  function cssVar(name, fallback) {
    const styles = getComputedStyle(document.documentElement);
    const v = styles.getPropertyValue(name).trim();
    return v || fallback;
  }

  function loadDebugColors() {
    state.debug.colors = {
      ring: cssVar('--debug-ring', 'rgba(124,198,255,0.35)'),
      ringOuter: cssVar('--debug-ring-outer', 'rgba(124,198,255,0.22)'),
      reveal: cssVar('--debug-reveal', 'rgba(255,110,110,0.6)'),
      playArea: cssVar('--debug-play-area', 'rgba(120,255,120,0.7)'),
      pointerLine: cssVar('--debug-pointer-line', 'rgba(255,255,255,0.3)'),
      pointerDot: cssVar('--debug-pointer-dot', 'rgba(255,255,255,0.85)'),
      pointerRing: cssVar('--debug-pointer-ring', 'rgba(255,255,255,0.45)'),
      labelBg: cssVar('--debug-label-bg', 'rgba(0,0,0,0.4)'),
      labelFg: cssVar('--debug-label-fg', 'rgba(255,255,255,0.9)'),
      targetDot: cssVar('--debug-target-dot', 'rgba(255,80,80,0.9)'),
      targetCross: cssVar('--debug-target-cross', 'rgba(255,80,80,0.8)'),
    };
  }

  function getPlayableArea() {
    const m = (state.config.playArea && state.config.playArea.margin) || 24;
    const hudPad = (state.config.playArea && state.config.playArea.hudPadding) || 12;
    const targetPad = 10 + state.targetSize / 2;
    let x0 = m + targetPad;
    let y0 = m + targetPad;
    const x1 = window.innerWidth - m - targetPad;
    const y1 = window.innerHeight - m - targetPad;
    if (hud) {
      const r = hud.getBoundingClientRect();
      // Move top bound below HUD plus padding, ensuring space for target radius
      y0 = Math.max(y0, r.bottom + hudPad + targetPad);
    }
    const w = Math.max(0, x1 - x0);
    const h = Math.max(0, y1 - y0);
    return { x: x0, y: y0, w, h };
  }

  function syncDebugFromHash() {
    const on = (window.location.hash || '').toLowerCase().includes(debugSecret);
    setDebugMode(on);
  }

  window.addEventListener('hashchange', syncDebugFromHash);
  syncDebugFromHash();
  loadSettings();
  applyConfigToStyles();

  // Cursor management: crosshair only in playable area, hand when near target
  function isPointerInPlayableArea() {
    const pa = getPlayableArea();
    const x = state.pointer.x;
    const y = state.pointer.y;
    return x >= pa.x && x <= pa.x + pa.w && y >= pa.y && y <= pa.y + pa.h;
  }

  function updateCursor(near) {
    const inside = isPointerInPlayableArea();
    const showHand = near && !state.settings.advanced;
    const cursor = inside ? (showHand ? 'pointer' : 'crosshair') : 'default';
    field.style.cursor = cursor;
  }
})();
