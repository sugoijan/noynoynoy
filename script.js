(() => {
  const field = document.getElementById('field');
  const targetEl = document.getElementById('target');
  const startBtn = document.getElementById('startButton');
  const restartBtn = document.getElementById('restartBtn');
  const msg = document.getElementById('msg');

  const state = {
    running: false,
    target: { x: 0, y: 0 },
    targetSize: 48,
    revealRadius: 120, // px — image reveals and becomes clickable inside this
    pointer: { x: -9999, y: -9999 },
    noyImage: { w: 0, h: 0, loaded: false },
    audio: {
      ctx: null,
      master: null,
      buffers: [], // AudioBuffer[6]
      volumes: [0.35, 0.5, 0.66, 0.8, 0.92, 1.0],
      loopDur: 1.2, // seconds — constant loop length
      xfade: 0.12,  // seconds — crossfade overlap
      scheduleAhead: 0.3, // seconds
      lookaheadMs: 30, // scheduler tick interval
      nextBoundary: 0,
      timer: null,
      playingVoice: 1, // will flip to 0 on first schedule
      voices: [], // [{gain: GainNode, source: AudioBufferSourceNode|null, vol: number}]
    },
  };

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  // Preload noy.png to know its natural size for the reveal animation
  (function preloadNoy() {
    const img = new Image();
    img.onload = () => {
      state.noyImage.w = img.naturalWidth || img.width;
      state.noyImage.h = img.naturalHeight || img.height;
      state.noyImage.loaded = true;
    };
    // Start loading immediately
    img.src = 'noy.png';
  })();

  function randomizeTarget() {
    const pad = 10 + state.targetSize / 2;
    const x = Math.random() * (window.innerWidth - pad * 2) + pad;
    const y = Math.random() * (window.innerHeight - pad * 2) + pad;
    state.target.x = x;
    state.target.y = y;
    placeTarget();
  }

  function placeTarget() {
    targetEl.style.left = state.target.x + 'px';
    targetEl.style.top = state.target.y + 'px';
  }

  async function setupAudio() {
    if (state.audio.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = 0.7; // headroom for crossfades
    master.connect(ctx.destination);

    // Two voice gains for alternating crossfades
    const v0 = ctx.createGain(); v0.gain.value = 0; v0.connect(master);
    const v1 = ctx.createGain(); v1.gain.value = 0; v1.connect(master);

    state.audio.ctx = ctx;
    state.audio.master = master;
    state.audio.voices = [ { gain: v0, source: null, vol: 0 }, { gain: v1, source: null, vol: 0 } ];
  }

  async function loadBuffers() {
    if (state.audio.buffers.length === 6) return;
    const files = [1,2,3,4,5,6].map(i => `noy${i}.wav`);
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
    // Normalize by viewport diagonal
    const maxDist = Math.hypot(window.innerWidth, window.innerHeight) * 0.75;
    const closeness = clamp(1 - dist / maxDist, 0, 1); // 0..1
    // Convert to six discrete levels: 0..5
    const idx = Math.min(5, Math.max(0, Math.floor(closeness * 6))); // 0..5
    return idx;
  }

  function computeDesiredLevel() {
    const dx = state.pointer.x - state.target.x;
    const dy = state.pointer.y - state.target.y;
    const dist = Math.hypot(dx, dy);
    const idx = levelFromDistance(dist);

    // Near behavior: make area clickable and show hand cursor
    const near = dist <= state.revealRadius;
    field.classList.toggle('hot', near);
    targetEl.style.pointerEvents = near ? 'auto' : 'none';
    return idx;
  }

  function scheduleIfNeeded() {
    const a = state.audio;
    if (!state.running || !a.ctx || a.buffers.length !== 6) return;

    const now = a.ctx.currentTime;
    // Schedule segments so that the new voice can start at boundary - xfade
    while (now + a.scheduleAhead > a.nextBoundary - a.xfade) {
      const level = computeDesiredLevel();
      scheduleSegmentForBoundary(a.nextBoundary, level);
      a.nextBoundary += a.loopDur;
    }
  }

  function scheduleSegmentForBoundary(boundaryTime, levelIdx) {
    const a = state.audio;
    const ctx = a.ctx;
    const buf = a.buffers[levelIdx];
    const vol = a.volumes[levelIdx];

    const startT = boundaryTime - a.xfade;               // start early for fade-in
    const endT = boundaryTime + a.loopDur;               // stop exactly one loop later
    const fadeInEnd = boundaryTime;                      // reach full at boundary
    const fadeOutStart = boundaryTime + a.loopDur - a.xfade; // begin fade-out before next boundary

    // Alternate voices to allow overlap
    const voiceIdx = a.playingVoice ^ 1; // flip 0<->1
    const voice = a.voices[voiceIdx];

    // Clean up any previous source on this voice if still around
    try { if (voice.source) voice.source.stop(); } catch {}

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true; // loop internally so buffer length doesn't matter
    src.loopStart = 0;
    src.loopEnd = buf.duration;
    src.connect(voice.gain);

    // Program the envelope for this segment
    const g = voice.gain.gain;
    g.cancelScheduledValues(0);
    g.setValueAtTime(0.0001, startT);
    g.linearRampToValueAtTime(vol, fadeInEnd);
    g.setValueAtTime(vol, fadeInEnd);
    g.setValueAtTime(vol, fadeOutStart);
    g.linearRampToValueAtTime(0.0001, endT);

    try {
      src.start(startT);
      // Stop just after envelope reaches zero to ensure cleanup
      src.stop(endT + 0.005);
    } catch {}

    src.onended = () => { if (voice.source === src) voice.source = null; };
    voice.source = src;
    voice.vol = vol;
    a.playingVoice = voiceIdx;
  }

  async function startGame() {
    await setupAudio();
    // Load and prime audio inside user gesture
    await state.audio.ctx.resume().catch(() => {});
    try { await loadBuffers(); } catch (e) {
      console.warn('Audio buffer load failed. Serve files via http(s).', e);
    }

    randomizeTarget();
    targetEl.classList.remove('found');
    targetEl.style.opacity = 0; // keep hidden until win
    targetEl.style.pointerEvents = 'none';
    msg.textContent = 'Move around to find the hidden image. Sound gets louder as you get closer.';
    startBtn.classList.add('hidden');
    restartBtn.classList.add('hidden');
    state.running = true;

    // Initialize scheduler
    const a = state.audio;
    a.nextBoundary = a.ctx.currentTime + 0.3 + a.xfade; // leave room for first pre-roll
    if (a.timer) { clearInterval(a.timer); }
    a.timer = setInterval(scheduleIfNeeded, a.lookaheadMs);
    scheduleIfNeeded();
  }

  function stopSound() {
    const a = state.audio;
    if (!a.ctx) return;
    if (a.timer) { clearInterval(a.timer); a.timer = null; }
    const now = a.ctx.currentTime + 0.01;
    a.voices.forEach(v => {
      try { if (v.source) v.source.stop(now); } catch {}
      v.source = null;
      try {
        v.gain.gain.cancelScheduledValues(0);
        v.gain.gain.setValueAtTime(0, now);
      } catch {}
    });
  }

  function onPointerMove(e) {
    if (!state.running) return;
    state.pointer.x = e.clientX;
    state.pointer.y = e.clientY;
    // Update reveal and keep desired level fresh for the scheduler
    computeDesiredLevel();
  }

  function onResize() {
    // Keep the target on-screen if user rotates/resizes
    const pad = 10 + state.targetSize / 2;
    state.target.x = clamp(state.target.x, pad, window.innerWidth - pad);
    state.target.y = clamp(state.target.y, pad, window.innerHeight - pad);
    placeTarget();
    computeDesiredLevel();
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
    // Move to viewport center while scaling up
    const centerX = Math.round(window.innerWidth / 2);
    const centerY = Math.round(window.innerHeight / 2);
    targetEl.style.left = centerX + 'px';
    targetEl.style.top = centerY + 'px';
    // Trigger reveal (image + scale animation)
    targetEl.classList.add('found');
    targetEl.style.opacity = 1;
    stopSound();
    msg.textContent = 'You found it!';
    restartBtn.classList.remove('hidden');
    field.classList.remove('hot');
  }

  // Event wiring
  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', () => {
    // Restart logic
    state.running = true;
    randomizeTarget();
    targetEl.classList.remove('found');
    targetEl.style.opacity = 0; // hide again
    // Reset size back to default box
    targetEl.style.width = '48px';
    targetEl.style.height = '48px';
    targetEl.style.pointerEvents = 'none';
    restartBtn.classList.add('hidden');
    msg.textContent = 'Move around to find the hidden image. Sound gets louder as you get closer.';
    // Reset scheduler
    const a = state.audio;
    a.nextBoundary = a.ctx.currentTime + 0.3 + a.xfade;
    if (a.timer) { clearInterval(a.timer); }
    a.timer = setInterval(scheduleIfNeeded, a.lookaheadMs);
    scheduleIfNeeded();
  });
  field.addEventListener('pointermove', onPointerMove);
  field.addEventListener('pointerdown', onPointerMove);
  field.addEventListener('click', (e) => {
    if (!state.running) return;
    // Ignore UI buttons
    if (e.target === startBtn || e.target === restartBtn) return;
    const dx = state.pointer.x - state.target.x;
    const dy = state.pointer.y - state.target.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= state.revealRadius) win();
  });
  window.addEventListener('resize', onResize);
  targetEl.addEventListener('click', win);

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
      computeDesiredLevel();
      e.preventDefault();
    }
  });

  // Initial idle state: show Start overlay
})();
