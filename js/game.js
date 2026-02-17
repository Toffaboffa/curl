(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const scoreEl = document.getElementById("score");
  const arrowEl = document.getElementById("arrow");
  const globalTotalEl = document.getElementById("globalTotal");

  const startOverlay = document.getElementById("startOverlay");
  const btnStart = document.getElementById("btnStart");

  const overlay = document.getElementById("overlay");
  const btnRetry = document.getElementById("btnRetry");
  const btnQuit = document.getElementById("btnQuit");
  const tinyNote = document.getElementById("tinyNote");

  // --- Global realtime counter (requires Supabase project) ---
  // 1) Create a Supabase project
  // 2) Add table: public.global_counter with columns:
  //    id int primary key, total bigint not null
  //    Insert one row: id=1, total=0
  // 3) Create RPC function (SQL) called increment_global_total(delta int) that atomically updates the total
  // 4) Enable Realtime for the table (Database -> Replication)
  //
  // Then set these:
  const SUPABASE_URL = "https://nfitxkkikzbjcfariaxz.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_1QAhHO7d0fml3ChJl9zEJA_sYO3WFfw";

  let sb = null;
  let globalTotal = 0;

  function fmtInt(n){
    try{ return new Intl.NumberFormat('en-US').format(n); }catch(_){ return String(n); }
  }

  async function initGlobalCounter(){
    try{
      if (!window.supabase || !SUPABASE_URL.startsWith("http")) return;
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

      // Initial fetch
      const { data, error } = await sb.from('global_counter').select('total').eq('id', 1).single();
      if (!error && data && typeof data.total !== "undefined"){
        globalTotal = Number(data.total) || 0;
        if (globalTotalEl) globalTotalEl.textContent = fmtInt(globalTotal);
      }

      // Subscribe to realtime updates
      sb.channel('global_counter_updates')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'global_counter', filter: 'id=eq.1' }, (payload) => {
          const t = payload?.new?.total;
          if (typeof t !== "undefined"){
            globalTotal = Number(t) || 0;
            if (globalTotalEl) globalTotalEl.textContent = fmtInt(globalTotal);
          }
        })
        .subscribe();

    } catch(e) {
      // Ignore; the game still runs locally — but log the reason for debugging.
      try{ console.warn('Supabase init failed (global counter):', e); }catch(_){ }
      if (globalTotalEl) globalTotalEl.textContent = '—';
      // Optional: show a tiny hint in console only; game keeps running.
      }


    }

  async function addToGlobalCounter(delta){
    try{
      if (!sb){
        try{ console.warn("Global counter: Supabase client not initialized."); }catch(_){ }
        return;
      }

      // Call your RPC to increment atomically
      const { error: rpcError } = await sb.rpc('increment_global_total', { delta });
      if (rpcError){
        try{ console.warn("Global counter RPC failed:", rpcError); }catch(_){ }
        return;
      }

      // Refresh the displayed total immediately (Realtime is nice, but not guaranteed locally)
      const { data, error: fetchError } = await sb
        .from('global_counter')
        .select('total')
        .eq('id', 1)
        .single();

      if (fetchError){
        try{ console.warn("Global counter refresh failed:", fetchError); }catch(_){ }
        return;
      }

      if (data && typeof data.total !== "undefined"){
        globalTotal = Number(data.total) || 0;
        if (globalTotalEl) globalTotalEl.textContent = fmtInt(globalTotal);
      }
    }catch(e){
      try{ console.warn("Global counter crashed:", e); }catch(_){ }
    }
  }


  // --- Assets ---
  const assets = {
    handIdle: new Image(),
    handPoke: new Image(),
    stone: new Image(),
    readyCount: 0,
    needed: 3,
    ready: false
  };

  // Put these files next to index.html
	assets.handIdle.src = "assets/images/hand1.png";
	assets.handPoke.src = "assets/images/hand2.png";
	assets.stone.src    = "assets/images/stone.png";

  function onAssetReady() {
    assets.readyCount++;
    if (assets.readyCount >= assets.needed) assets.ready = true;
  }
  assets.handIdle.onload = onAssetReady;
  assets.handPoke.onload = () => {
    onAssetReady();
    // Once we have hand2.png, compute the *real* fingertip position in the sprite
    // so collision feels pixel-perfect regardless of how the PNG was edited.
    computeFingerTipFromHand2();
  };
  assets.stone.onload = onAssetReady;

  // --- HiDPI canvas sizing ---
  function resize() {
    const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  // --- Game state ---
  const state = {
    started: false,
    running: false,

    score: 0,
    time: 0,

    // hand control
    handX: window.innerWidth * 0.5,
    handTargetX: window.innerWidth * 0.5,
    // bottom anchored (sprite bottom should sit on screen bottom)
    handY: window.innerHeight,

    holding: false,
    pokeAnim: 0, // 0..1 (for slight bob)

    // stone
    stoneObj: null,

    // guide: "L" | "S" | "R"
    guide: "S",

    // difficulty curve
    // Slower baseline so players can actually react on mobile.
    baseSpeed: 135,
    curlStrength: 70,

    // Pre-spawn the next stone when the current one is ~75% up the screen.
    nextStoneObj: null,
  };

  // --- Sprite metrics (user-provided) ---
  // hand1.png / hand2.png are 295x471.
  // In hand2.png, the index finger is between x=48..85.
  const HAND2_FINGER_X0 = 48;
  const HAND2_FINGER_X1 = 85;

  // Finger tip in *image pixel coordinates* (hand2.png local space).
  // We auto-detect Y from alpha; fallback values keep the game playable.
  const fingerLocal = { x: (HAND2_FINGER_X0 + HAND2_FINGER_X1) / 2, y: 8 };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function computeFingerTipFromHand2() {
    try {
      const img = assets.handPoke;
      if (!img || !img.naturalWidth || !img.naturalHeight) return;

      const off = document.createElement('canvas');
      off.width = img.naturalWidth;
      off.height = img.naturalHeight;
      const octx = off.getContext('2d', { willReadFrequently: true });
      octx.clearRect(0, 0, off.width, off.height);
      octx.drawImage(img, 0, 0);

      const x0 = clamp(HAND2_FINGER_X0, 0, off.width - 1);
      const x1 = clamp(HAND2_FINGER_X1, 0, off.width - 1);
      const bandW = x1 - x0 + 1;

      const data = octx.getImageData(x0, 0, bandW, off.height).data;
      const stride = bandW * 4;

      // Scan from top to bottom to find the first opaque pixel within finger band.
      for (let y = 0; y < off.height; y++) {
        let sumX = 0;
        let count = 0;
        const row = y * stride;
        for (let xi = 0; xi < bandW; xi++) {
          const a = data[row + xi * 4 + 3];
          if (a > 10) {
            sumX += (x0 + xi);
            count++;
          }
        }
        if (count > 0) {
          fingerLocal.y = y;
          fingerLocal.x = sumX / count;
          return;
        }
      }
    } catch (_) {
      // ignore and keep fallback
    }
  }

  function layoutDefaults() {
    // Keep the sprite bottom flush with the bottom edge.
    state.handY = window.innerHeight;
    state.handX = clamp(state.handX, window.innerWidth * 0.12, window.innerWidth * 0.88);
    state.handTargetX = clamp(state.handTargetX, window.innerWidth * 0.12, window.innerWidth * 0.88);
  }
  window.addEventListener("resize", layoutDefaults);
  layoutDefaults();

  function setGuide(g) {
    state.guide = g;
    arrowEl.textContent = (g === "R") ? "→" : (g === "L") ? "←" : "↑";
  }

  function nextGuide() {
    const r = Math.random();
    if (r < 0.33) return "L";
    if (r < 0.66) return "S";
    return "R";
  }

  function makeStone(isFirst = false, extraDepth = 0) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const r = Math.max(42, Math.min(72, w * 0.095));
    const x = rand(w * 0.25, w * 0.75);
    const y = h + r + (isFirst ? 40 : rand(80, 160) + extraDepth);
    // Keep growth gentle; baseline is slower, poke can boost more.
    const speed = state.baseSpeed + state.score * 8;

    return {
      x, y, r,
      vy: -speed,
      vx: 0,
      spin: 0,
      spinVel: 0,
      touched: false
    };
  }

  function spawnStone(isFirst = false) {
    state.stoneObj = makeStone(isFirst);
    state.nextStoneObj = null;
    setGuide(nextGuide());
  }

  function preSpawnNextStone() {
    // Spawn deeper so it doesn't reach the poke line before it becomes active.
    state.nextStoneObj = makeStone(false, rand(320, 520));
  }

  function startGame() {
    state.started = true;
    state.running = true;
    startOverlay.classList.add("hidden");
    overlay.classList.add("hidden");
    tinyNote.classList.add("hidden");

    state.score = 0;
    state.time = 0;
    state.baseSpeed = 135;
    state.curlStrength = 70;
    state.nextStoneObj = null;
    state.pokeAnim = 0;
    scoreEl.textContent = "0";

    setGuide(nextGuide());
    spawnStone(true);
  }

  function resetGame() {
    state.running = true;
    overlay.classList.add("hidden");
    tinyNote.classList.add("hidden");

    state.score = 0;
    state.time = 0;
    state.baseSpeed = 135;
    state.curlStrength = 70;
    state.nextStoneObj = null;
    state.pokeAnim = 0;
    scoreEl.textContent = "0";

    setGuide(nextGuide());
    spawnStone(true);
  }

  function gameOver() {
    state.running = false;
    overlay.classList.remove("hidden");
  }

  btnStart.addEventListener("click", startGame);
  btnRetry.addEventListener("click", resetGame);
  btnQuit.addEventListener("click", () => {
    tinyNote.classList.remove("hidden");
    state.running = false;
  });

  // --- Input rules ---
  // Desktop: hand follows mouse X always; mouse down triggers poke.
  // Mobile: finger drag sets X while holding; release triggers poke (timing game).
  function setHandTargetFromClientX(clientX) {
    state.handTargetX = clamp(clientX, window.innerWidth * 0.12, window.innerWidth * 0.88);
  }

  canvas.addEventListener("pointermove", (e) => {
    // follow X always (also when not started, it just looks nice)
    setHandTargetFromClientX(e.clientX);
  });

  canvas.addEventListener("pointerdown", (e) => {
    if (!state.started) return;        // must press Start
    if (!state.running) return;

    state.holding = true;
    state.pokeAnim = 0;
    canvas.setPointerCapture(e.pointerId);
    setHandTargetFromClientX(e.clientX);

    // Mouse = poke on press
    if (e.pointerType === "mouse") {
      doPoke();
      state.pokeAnim = 0.0001;
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    if (!state.started) return;
    if (!state.running) return;
    if (!state.holding) return;

    state.holding = false;

    // Touch/Pen = poke on release
    if (e.pointerType !== "mouse") {
      doPoke();
      state.pokeAnim = 0.0001;
    }
  });

  canvas.addEventListener("pointercancel", () => { state.holding = false; });

  // --- Mechanics ---
  function getHandDrawParams(isPokeFrame) {
    const img = isPokeFrame ? assets.handPoke : assets.handIdle;
    const up = (state.pokeAnim > 0) ? easeOutCubic(clamp(state.pokeAnim, 0, 1)) : 0;

    // Anchor: bottom-center at (handX, handY) with a tiny upward bob on poke.
    const anchorX = state.handX;
    const anchorY = state.handY - up * 10;

    // Hand size tuning.
    // (295px wide source) — scale gently with viewport.
    // User request: make the hand 25% smaller.
    const HAND_SCALE = 0.75;
    const targetW = clamp(window.innerWidth * 0.28, 120, 190) * HAND_SCALE;
    const natW = (img && img.naturalWidth) ? img.naturalWidth : 295;
    const natH = (img && img.naturalHeight) ? img.naturalHeight : 471;
    const scale = targetW / natW;
    const drawW = natW * scale;
    const drawH = natH * scale;

    const x0 = anchorX - drawW / 2;
    const y0 = anchorY - drawH;
    return { img, x0, y0, drawW, drawH, scale };
  }

  function getFingerTip() {
    // Finger tip point used for collision — derived from hand2.png pixels.
    const p = getHandDrawParams(true);
    return {
      x: p.x0 + fingerLocal.x * p.scale,
      y: p.y0 + fingerLocal.y * p.scale
    };
  }

  function doPoke() {
    const s = state.stoneObj;
    if (!s) return;

    const finger = getFingerTip();

    // Too late => miss
    if (s.y < finger.y - s.r * 1.3) {
      gameOver();
      return;
    }

    const dx = finger.x - s.x;
    const dy = finger.y - s.y;
    const dist = Math.hypot(dx, dy);
    if (dist > s.r * 1.05) {
      gameOver();
      return;
    }

    // Determine poke "side"
    const sideDeadzone = Math.max(8, s.r * 0.22);
    let pokeType = "S";
    if (dx < -sideDeadzone) pokeType = "L";
    else if (dx > sideDeadzone) pokeType = "R";

    // Correctness mapping:
    // Want curl right -> poke left side
    const ok =
      (state.guide === "R" && pokeType === "L") ||
      (state.guide === "L" && pokeType === "R") ||
      (state.guide === "S" && pokeType === "S");

    if (!ok) {
      gameOver();
      return;
    }

    // Success effects
    s.touched = true;
    // Slower baseline, but a poke gives a more noticeable speed-up.
    s.vy *= 1.22;

    const curlDir = (state.guide === "R") ? 1 : (state.guide === "L") ? -1 : 0;
    s.vx = curlDir * state.curlStrength;
    s.spinVel = curlDir * (2.6 + Math.min(2.3, state.score * 0.08));

    state.score += 1;
    scoreEl.textContent = String(state.score);

    // Add to worldwide total (if configured)
    addToGlobalCounter(1);

    state.baseSpeed = Math.min(320, state.baseSpeed + 4);
    state.curlStrength = Math.min(160, state.curlStrength + 2);
  
    // New guide after every successful poke (you can keep poking the same stone)
    setGuide(nextGuide());
}

  // --- Update loop ---
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;

    // Smooth hand
    state.handX += (state.handTargetX - state.handX) * (1 - Math.pow(0.0001, dt));
    state.handX = clamp(state.handX, window.innerWidth * 0.12, window.innerWidth * 0.88);

    // Poke animation timer
    if (state.pokeAnim > 0) {
      state.pokeAnim += dt * 6.0;
      if (state.pokeAnim >= 1) state.pokeAnim = 0;
    }

    if (state.running && state.stoneObj) {
      const s = state.stoneObj;

      // Move up
      s.y += s.vy * dt;

      // Curl + spin
      s.x += s.vx * dt;
      s.spin += s.spinVel * dt;

      // Damping
      s.vx *= (1 - 0.6 * dt);
      s.spinVel *= (1 - 0.22 * dt);

      // Walls
      const w = window.innerWidth;
      s.x = clamp(s.x, s.r * 1.2, w - s.r * 1.2);

      // Lose if stone passes poke line untouched
      const finger = getFingerTip();
      if (!s.touched && s.y < finger.y - s.r * 0.9) {
        gameOver();
      }

      // Next stone when exiting top (only if touched)
      if (s.y < -s.r - 10) {
        if (!s.touched) gameOver();
        else {
          if (state.nextStoneObj) {
            state.stoneObj = state.nextStoneObj;
            state.nextStoneObj = null;
            setGuide(nextGuide());
          } else {
            spawnStone(false);
          }
        }
      }

      // Pre-spawn the next stone once the current stone is ~75% up the screen.
      if (!state.nextStoneObj && s.y < window.innerHeight * 0.25) {
        preSpawnNextStone();
      }
    }

    // Let the pre-spawned stone start moving so it's "on deck" visually.
    if (state.running && state.nextStoneObj) {
      const n = state.nextStoneObj;
      n.y += n.vy * dt;
      n.x += n.vx * dt;
      n.spin += n.spinVel * dt;
      n.vx *= (1 - 0.6 * dt);
      n.spinVel *= (1 - 0.22 * dt);
      const w = window.innerWidth;
      n.x = clamp(n.x, n.r * 1.2, w - n.r * 1.2);
    }

    render(dt);
    requestAnimationFrame(tick);
  }

  // --- Render ---
  let iceScroll = 0;
  let icePattern = null;

  function buildIcePattern() {
    // Procedural ice texture: soft grain + scratches.
    // Generated once and repeated.
    const off = document.createElement('canvas');
    off.width = 512;
    off.height = 512;
    const o = off.getContext('2d');

    // Base
    o.fillStyle = '#d9f2ff';
    o.fillRect(0, 0, off.width, off.height);

    // Grain
    for (let i = 0; i < 2200; i++) {
      const x = Math.random() * off.width;
      const y = Math.random() * off.height;
      const r = Math.random() * 1.4 + 0.2;
      const a = Math.random() * 0.08;
      o.fillStyle = `rgba(40,110,160,${a})`;
      o.beginPath();
      o.arc(x, y, r, 0, Math.PI * 2);
      o.fill();
    }

    // Frosty specks
    for (let i = 0; i < 700; i++) {
      const x = Math.random() * off.width;
      const y = Math.random() * off.height;
      const r = Math.random() * 2.2 + 0.3;
      const a = Math.random() * 0.06;
      o.fillStyle = `rgba(255,255,255,${a})`;
      o.beginPath();
      o.arc(x, y, r, 0, Math.PI * 2);
      o.fill();
    }

    // Long scratches
    o.lineCap = 'round';
    for (let i = 0; i < 180; i++) {
      const x = Math.random() * off.width;
      const y = Math.random() * off.height;
      const len = 80 + Math.random() * 260;
      const ang = (-0.25 + Math.random() * 0.5) * Math.PI; // mostly horizontal
      const x2 = x + Math.cos(ang) * len;
      const y2 = y + Math.sin(ang) * len;

      o.strokeStyle = `rgba(255,255,255,${0.02 + Math.random() * 0.05})`;
      o.lineWidth = 0.7 + Math.random() * 1.8;
      o.beginPath();
      o.moveTo(x, y);
      o.lineTo(x2, y2);
      o.stroke();
    }

    // A few deeper blue streaks (subtle)
    for (let i = 0; i < 55; i++) {
      const x = Math.random() * off.width;
      const y = Math.random() * off.height;
      const len = 120 + Math.random() * 360;
      const ang = (-0.18 + Math.random() * 0.36) * Math.PI;
      const x2 = x + Math.cos(ang) * len;
      const y2 = y + Math.sin(ang) * len;
      o.strokeStyle = `rgba(30,90,140,${0.015 + Math.random() * 0.03})`;
      o.lineWidth = 1.2 + Math.random() * 2.4;
      o.beginPath();
      o.moveTo(x, y);
      o.lineTo(x2, y2);
      o.stroke();
    }

    icePattern = ctx.createPattern(off, 'repeat');
  }

  function render(dt) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    drawIce(w, h, dt);

    // Draw the next stone first (behind), then the active one.
    if (state.nextStoneObj) drawStone(state.nextStoneObj);
    if (state.stoneObj) drawStone(state.stoneObj);

    drawHandImage();

    drawGuidePreview();
  }

  function drawIce(w, h, dt) {
    if (!icePattern) buildIcePattern();

    // Base fill: repeating texture
    ctx.fillStyle = icePattern || "#cfe9ff";
    ctx.fillRect(0, 0, w, h);

    // Soft vertical lighting
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(155,215,245,0.28)");
    g.addColorStop(0.55, "rgba(120,180,220,0.10)");
    g.addColorStop(1, "rgba(10,40,90,0.12)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Slight moving shimmer lines (very subtle)
    iceScroll += dt * 110;
    const spacing = 30;
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 2;
    for (let i = -3; i < h / spacing + 5; i++) {
      const y = (i * spacing + (iceScroll % spacing));
      ctx.beginPath();
      const x1 = (i * 17) % w;
      ctx.moveTo(x1, y);
      ctx.lineTo(x1 + 120, y - 8);
      ctx.stroke();
    }

    // Rink-ish center line
    ctx.strokeStyle = "rgba(40,80,120,0.14)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(w * 0.5, 0);
    ctx.lineTo(w * 0.5, h);
    ctx.stroke();

    // Vignette to make stones/hand pop
    const v = ctx.createRadialGradient(w * 0.5, h * 0.55, Math.min(w, h) * 0.15, w * 0.5, h * 0.55, Math.max(w, h) * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.16)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
  }

  function drawStone(s) {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.spin);

    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.beginPath();
    ctx.ellipse(0, s.r * 0.62, s.r * 0.95, s.r * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();

    if (assets.ready) {
      // stone.png is 400x400; we treat s.r as the on-screen radius.
      const size = s.r * 2.0;
      ctx.drawImage(assets.stone, -size/2, -size/2, size, size);
    } else {
      // fallback circle if image not loaded
      ctx.fillStyle = "#9aa6b2";
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, s.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawHandImage() {
    const isPokeFrame = state.pokeAnim > 0;
    const p = getHandDrawParams(isPokeFrame);

    ctx.save();
    if (assets.ready && p.img && p.img.naturalWidth) {
      ctx.globalAlpha = 1;
      ctx.drawImage(p.img, p.x0, p.y0, p.drawW, p.drawH);
    } else {
      // fallback simple hand blob
      const x = state.handX;
      const y = state.handY;
      ctx.fillStyle = "#f2c9a0";
      ctx.beginPath();
      ctx.roundRect(x - 40, y - 120, 80, 120, 22);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawGuidePreview() {
    // tiny preview stone with poke marker only
    const w = window.innerWidth;
    const x = w * 0.5;
    const y = 76;
    const r = 20;

    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.translate(x, y);

    ctx.fillStyle = "rgba(120,130,140,0.55)";
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "rgba(125,211,252,0.9)";

    let mx = 0;
    if (state.guide === "R") mx = -r * 0.55;      // poke left side
    else if (state.guide === "L") mx = r * 0.55;  // poke right side
    else mx = 0;

    ctx.beginPath();
    ctx.arc(mx, 0, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // roundRect polyfill for older iOS
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      const rr = Array.isArray(r) ? r : [r, r, r, r];
      const [r1, r2, r3, r4] = rr;
      this.beginPath();
      this.moveTo(x + r1, y);
      this.lineTo(x + w - r2, y);
      this.quadraticCurveTo(x + w, y, x + w, y + r2);
      this.lineTo(x + w, y + h - r3);
      this.quadraticCurveTo(x + w, y + h, x + w - r3, y + h);
      this.lineTo(x + r4, y + h);
      this.quadraticCurveTo(x, y + h, x, y + h - r4);
      this.lineTo(x, y + r1);
      this.quadraticCurveTo(x, y, x + r1, y);
      this.closePath();
      return this;
    };
  }

  // Start in attract mode: show start overlay, render loop still runs.
  setGuide(nextGuide());
  initGlobalCounter();
  requestAnimationFrame(tick);
})();
