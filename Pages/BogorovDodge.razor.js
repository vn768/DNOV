// BogorovDodge.razor.js
// Self-contained canvas game engine. Talks back to Blazor only for the
// things that don't need to happen every frame (achievement unlocks, game over).

let state = null;

const STORAGE_KEY = 'dodgeArenaProgress';

function loadProgress() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { bestTimeMs: 0, unlocked: [] };
        const parsed = JSON.parse(raw);
        return {
            bestTimeMs: parsed.bestTimeMs || 0,
            unlocked: Array.isArray(parsed.unlocked) ? parsed.unlocked : [],
        };
    } catch {
        return { bestTimeMs: 0, unlocked: [] };
    }
}

function saveProgress() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            bestTimeMs: state.bestTimeMs,
            unlocked: Array.from(state.unlocked),
        }));
    } catch { /* ignore quota / privacy-mode errors */ }
}

export async function init(canvas, dotNetRef, achievementDefs) {
    if (state) {
        dispose();
    }

    const ctx = canvas.getContext('2d');
    const wrap = canvas.parentElement;

    const els = {
        startOverlay: document.getElementById('dodgeStartOverlay'),
        gameOverOverlay: document.getElementById('dodgeGameOverOverlay'),
        gameOverTime: document.getElementById('dodgeGameOverTime'),
        startBtn: document.getElementById('dodgeStartBtn'),
        restartBtn: document.getElementById('dodgeRestartBtn'),
        timer: document.getElementById('dodgeTimer'),
        toastContainer: document.getElementById('dodgeToasts'),
        joystickBase: document.getElementById('dodgeJoystickBase'),
        joystickKnob: document.getElementById('dodgeJoystickKnob'),
    };

    const progress = loadProgress();

    state = {
        canvas, ctx, wrap, els, dotNetRef,
        achievementDefs: achievementDefs || [],
        width: 0, height: 0,
        dpr: Math.max(window.devicePixelRatio || 1, 1),
        player: { x: 0, y: 0, vx: 0, vy: 0, radius: 10, speed: 230 },
        keys: new Set(),
        joystick: { active: false, pointerId: null, dx: 0, dy: 0 },
        hazards: [],   // projectiles flying around
        lasers: [],    // telegraphed beams
        wallObjects: [], // bars that punch in from the walls
        elapsed: 0,    // seconds survived this run
        lastTs: 0,
        running: false,
        paused: false,
        over: false,
        rafId: 0,
        spawnAcc: { projectile: 0, laser: 0, wall: 0 },
        unlocked: new Set(progress.unlocked),
        bestTimeMs: progress.bestTimeMs,
        listeners: [],
        resizeObserver: null,
    };

    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(wrap);
    state.resizeObserver = ro;

    state.playerSkin = new Image();
    state.playerSkinLoaded = false;
    state.playerSkin.onload = () => { if (state) state.playerSkinLoaded = true; };
    state.playerSkin.src = '/images/pgit-logo.png';
    attachInput();

    els.startOverlay.style.display = 'flex';
    els.gameOverOverlay.style.display = 'none';
    els.timer.textContent = '00:00.0';

    // draw an idle frame so the canvas isn't blank before the player hits Start
    drawBackground();
    drawPlayer();

    // Blazor expects init() to resolve with the persisted progress shape
    // (DodgeProgress: { BestTimeMs, Unlocked }) via JSON deserialization.
    return {
        bestTimeMs: state.bestTimeMs,
        unlocked: Array.from(state.unlocked),
    };
}

function attachInput() {
    const { els } = state;

    const onKeyDown = (e) => {
        const k = e.key.toLowerCase();
        if (['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright'].includes(k)) {
            state.keys.add(k);
            if (state.running) e.preventDefault();
        }
    };
    const onKeyUp = (e) => state.keys.delete(e.key.toLowerCase());
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    state.listeners.push(['keydown', onKeyDown, window], ['keyup', onKeyUp, window]);

    // --- virtual joystick (touch) ---
    const updateJoystick = (t) => {
        const rect = els.joystickBase.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = t.clientX - cx;
        const dy = t.clientY - cy;
        const maxR = rect.width / 2;
        const dist = Math.min(Math.hypot(dx, dy), maxR);
        const angle = Math.atan2(dy, dx);
        const kx = Math.cos(angle) * dist;
        const ky = Math.sin(angle) * dist;
        els.joystickKnob.style.transform = `translate(${kx}px, ${ky}px) translate(-50%, -50%)`;
        state.joystick.dx = dist === 0 ? 0 : Math.cos(angle) * (dist / maxR);
        state.joystick.dy = dist === 0 ? 0 : Math.sin(angle) * (dist / maxR);
    };
    const resetJoystick = () => {
        state.joystick.active = false;
        state.joystick.pointerId = null;
        state.joystick.dx = 0;
        state.joystick.dy = 0;
        els.joystickKnob.style.transform = 'translate(-50%, -50%)';
    };
    const onJoyStart = (e) => {
        const t = e.changedTouches[0];
        state.joystick.active = true;
        state.joystick.pointerId = t.identifier;
        updateJoystick(t);
        e.preventDefault();
    };
    const onJoyMove = (e) => {
        if (!state.joystick.active) return;
        const t = Array.from(e.changedTouches).find(t => t.identifier === state.joystick.pointerId);
        if (t) { updateJoystick(t); e.preventDefault(); }
    };
    const onJoyEnd = (e) => {
        const t = Array.from(e.changedTouches).find(t => t.identifier === state.joystick.pointerId);
        if (t || e.type === 'touchcancel') resetJoystick();
    };
    els.joystickBase.addEventListener('touchstart', onJoyStart, { passive: false });
    window.addEventListener('touchmove', onJoyMove, { passive: false });
    window.addEventListener('touchend', onJoyEnd);
    window.addEventListener('touchcancel', onJoyEnd);
    state.listeners.push(
        ['touchstart', onJoyStart, els.joystickBase],
        ['touchmove', onJoyMove, window],
        ['touchend', onJoyEnd, window],
        ['touchcancel', onJoyEnd, window],
    );

    const onStart = () => startGame();
    els.startBtn.addEventListener('click', onStart);
    els.restartBtn.addEventListener('click', onStart);
    state.listeners.push(['click', onStart, els.startBtn], ['click', onStart, els.restartBtn]);

    const onVis = () => {
        if (!state) return;
        if (document.hidden) {
            state.paused = true;
        } else if (state.running) {
            state.lastTs = performance.now();
            state.paused = false;
        }
    };
    document.addEventListener('visibilitychange', onVis);
    state.listeners.push(['visibilitychange', onVis, document]);
}

function resize() {
    if (!state) return;
    const { canvas, wrap } = state;
    const rect = wrap.getBoundingClientRect();
    const dpr = state.dpr;
    state.width = rect.width;
    state.height = rect.height;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!state.running) {
        state.player.x = state.width / 2;
        state.player.y = state.height / 2;
    } else {
        state.player.x = Math.min(Math.max(state.player.x, state.player.radius), state.width - state.player.radius);
        state.player.y = Math.min(Math.max(state.player.y, state.player.radius), state.height - state.player.radius);
    }
}

function startGame() {
    state.player.x = state.width / 2;
    state.player.y = state.height / 2;
    state.player.vx = 0;
    state.player.vy = 0;
    state.hazards = [];
    state.lasers = [];
    state.wallObjects = [];
    state.elapsed = 0;
    state.spawnAcc = { projectile: 0, laser: 0, wall: 0 };
    state.over = false;
    state.running = true;
    state.paused = false;
    state.lastTs = performance.now();
    state.runUnlockedThisRun = new Set();

    state.els.startOverlay.style.display = 'none';
    state.els.gameOverOverlay.style.display = 'none';

    cancelAnimationFrame(state.rafId);
    state.rafId = requestAnimationFrame(loop);
}

function loop(ts) {
    if (!state || !state.running) return;
    state.rafId = requestAnimationFrame(loop);
    if (state.paused) { state.lastTs = ts; return; }

    let dt = (ts - state.lastTs) / 1000;
    state.lastTs = ts;
    dt = Math.min(dt, 0.05); // clamp huge frame gaps (tab switch, lag)

    update(dt);
    render();
}

function difficultyTier() {
    return Math.min(Math.floor(state.elapsed / 30), 14);
}

function update(dt) {
    state.elapsed += dt;
    state.els.timer.textContent = formatTime(state.elapsed);

    updatePlayer(dt);
    handleSpawning(dt);
    updateHazards(dt);
    updateLasers(dt);
    updateWallObjects(dt);
    checkCollisions();
    checkAchievements();
}

function updatePlayer(dt) {
    const p = state.player;
    let dx = 0, dy = 0;

    if (state.keys.has('w') || state.keys.has('arrowup')) dy -= 1;
    if (state.keys.has('s') || state.keys.has('arrowdown')) dy += 1;
    if (state.keys.has('a') || state.keys.has('arrowleft')) dx -= 1;
    if (state.keys.has('d') || state.keys.has('arrowright')) dx += 1;

    if (state.joystick.active) {
        dx = state.joystick.dx;
        dy = state.joystick.dy;
    } else if (dx !== 0 && dy !== 0) {
        const len = Math.hypot(dx, dy);
        dx /= len; dy /= len;
    }

    const targetVx = dx * p.speed;
    const targetVy = dy * p.speed;
    const accel = 18; // smoothing
    p.vx += (targetVx - p.vx) * Math.min(accel * dt, 1);
    p.vy += (targetVy - p.vy) * Math.min(accel * dt, 1);

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    p.x = Math.min(Math.max(p.x, p.radius), state.width - p.radius);
    p.y = Math.min(Math.max(p.y, p.radius), state.height - p.radius);
}

function handleSpawning(dt) {
    const tier = difficultyTier();
    const acc = state.spawnAcc;

    acc.projectile += dt;
    const projInterval = Math.max(1.5 - tier * 0.09, 0.4);
    if (acc.projectile >= projInterval) {
        acc.projectile = 0;
        const burst = 4; // spawn several projectiles per wave instead of one
        for (let i = 0; i < burst; i++) {
            spawnProjectile(tier);
        }
    }

    // lasers start appearing once the player has survived a bit (tier 1+)
    acc.laser += dt;
    const laserInterval = Math.max(4.5 - tier * 0.22, 1.6);
    if (tier >= 1 && acc.laser >= laserInterval) {
        acc.laser = 0;
        spawnLaser(tier);
    }

    // wall strikes start a little later (tier 2+) since they're punishing
    acc.wall += dt;
    const wallInterval = Math.max(5.5 - tier * 0.25, 2.2);
    if (tier >= 2 && acc.wall >= wallInterval) {
        acc.wall = 0;
        spawnWallObject(tier);
    }
}

function rand(min, max) { return min + Math.random() * (max - min); }
function choice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Returns a random value within [min, max], but pulled toward `target`
// (the player's relevant coordinate) within a window of +/- spread.
// Falls back to clamping into [min, max] so it never escapes the arena.
function biasedNear(min, max, target, spread) {
    const lo = Math.max(min, target - spread);
    const hi = Math.min(max, target + spread);
    if (lo >= hi) return Math.min(Math.max(target, min), max);
    return rand(lo, hi);
}

function spawnProjectile(tier) {
    const speedMult = 1 + tier * 0.07;
    const shapes = ['circle', 'square', 'triangle'];
    const shape = choice(shapes);
    const radius = rand(8, 18);
    const edge = Math.floor(rand(0, 4));
    let x, y;
    const w = state.width, h = state.height;
    switch (edge) {
        case 0: x = rand(0, w); y = -radius; break;            // top
        case 1: x = w + radius; y = rand(0, h); break;         // right
        case 2: x = rand(0, w); y = h + radius; break;         // bottom
        default: x = -radius; y = rand(0, h); break;           // left
    }

    // aim roughly at the player, with spread so it's not a guaranteed hit
    const targetAngle = Math.atan2(state.player.y - y, state.player.x - x);
    const spread = (Math.random() - 0.5) * (Math.PI / 2.3);
    const angle = targetAngle + spread;
    const speed = rand(160, 240) * speedMult;

    state.hazards.push({
        shape, x, y, radius,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        rotation: 0,
        rotSpeed: rand(-3, 3),
        color: choice(['#ff5d73', '#ff9f5d', '#c77dff', '#5dd3ff']),
        bouncesLeft: Math.random() < 0.3 ? 5 : 0, // ~30% of shapes can bounce off walls
    });
}

function spawnLaser(tier) {
    const orientation = Math.random() < 0.5 ? 'h' : 'v';
    const thickness = rand(16, 24);
    const warning = Math.max(0.85 - tier * 0.04, 0.4);
    const firing = 0.28;
    const spread = 130; // how close to the player the beam is allowed to land
    if (orientation === 'h') {
        const y = biasedNear(40, state.height - 40, state.player.y, spread);
        state.lasers.push({ orientation, pos: y, thickness, phase: 'warning', timer: warning, warningDur: warning, firingDur: firing });
    } else {
        const x = biasedNear(40, state.width - 40, state.player.x, spread);
        state.lasers.push({ orientation, pos: x, thickness, phase: 'warning', timer: warning, warningDur: warning, firingDur: firing });
    }
}

function spawnWallObject(tier) {
    const wall = Math.floor(rand(0, 4));
    const thickness = rand(26, 40);
    const warningDur = Math.max(0.6 - tier * 0.02, 0.3);
    const extendDur = 0.3;
    const holdDur = Math.max(0.85 - tier * 0.04, 0.35);
    const retractDur = 0.3;
    const w = state.width, h = state.height;
    const spread = 120; // how close to the player it's allowed to land along the wall
    let rect, depth;
    if (wall === 0) { // top
        depth = h * rand(0.5, 0.62);
        const x = biasedNear(0, w - thickness, state.player.x - thickness / 2, spread);
        rect = { x, y: -depth, w: thickness, h: depth, dir: 'down' };
    } else if (wall === 1) { // right
        depth = w * rand(0.5, 0.62);
        const y = biasedNear(0, h - thickness, state.player.y - thickness / 2, spread);
        rect = { x: w, y, w: depth, h: thickness, dir: 'left' };
    } else if (wall === 2) { // bottom
        depth = h * rand(0.5, 0.62);
        const x = biasedNear(0, w - thickness, state.player.x - thickness / 2, spread);
        rect = { x, y: h, w: thickness, h: depth, dir: 'up' };
    } else { // left
        depth = w * rand(0.5, 0.62);
        const y = biasedNear(0, h - thickness, state.player.y - thickness / 2, spread);
        rect = { x: -depth, y, w: depth, h: thickness, dir: 'right' };
    }
    state.wallObjects.push({ ...rect, depth, phase: 'warning', timer: 0, warningDur, extendDur, holdDur, retractDur });
}

function updateHazards(dt) {
    const margin = 60;
    state.hazards = state.hazards.filter(h => {
        h.x += h.vx * dt;
        h.y += h.vy * dt;
        h.rotation += h.rotSpeed * dt;

        if (h.bouncesLeft > 0) {
            if (h.x - h.radius <= 0 && h.vx < 0) {
                h.x = h.radius;
                h.vx *= -1;
                h.bouncesLeft--;
            } else if (h.x + h.radius >= state.width && h.vx > 0) {
                h.x = state.width - h.radius;
                h.vx *= -1;
                h.bouncesLeft--;
            }
            if (h.y - h.radius <= 0 && h.vy < 0) {
                h.y = h.radius;
                h.vy *= -1;
                h.bouncesLeft--;
            } else if (h.y + h.radius >= state.height && h.vy > 0) {
                h.y = state.height - h.radius;
                h.vy *= -1;
                h.bouncesLeft--;
            }
        }

        return h.x > -margin && h.x < state.width + margin && h.y > -margin && h.y < state.height + margin;
    });
}

function updateLasers(dt) {
    state.lasers = state.lasers.filter(l => {
        l.timer -= dt;
        if (l.timer <= 0) {
            if (l.phase === 'warning') {
                l.phase = 'firing';
                l.timer = l.firingDur;
            } else {
                return false; // done firing, remove
            }
        }
        return true;
    });
}

function updateWallObjects(dt) {
    state.wallObjects = state.wallObjects.filter(o => {
        o.timer += dt;
        if (o.phase === 'warning' && o.timer >= o.warningDur) { o.phase = 'extend'; o.timer = 0; }
        else if (o.phase === 'extend' && o.timer >= o.extendDur) { o.phase = 'hold'; o.timer = 0; }
        else if (o.phase === 'hold' && o.timer >= o.holdDur) { o.phase = 'retract'; o.timer = 0; }
        else if (o.phase === 'retract' && o.timer >= o.retractDur) { return false; }
        return true;
    });
}

function wallObjectExtension(o) {
    // returns 0..1 how far out it currently reaches
    if (o.phase === 'warning') return 0;
    if (o.phase === 'extend') return Math.min(o.timer / o.extendDur, 1);
    if (o.phase === 'hold') return 1;
    if (o.phase === 'retract') return Math.max(1 - o.timer / o.retractDur, 0);
    return 0;
}

function wallObjectRectAt(o, ext) {
    if (o.dir === 'down') return { x: o.x, y: -o.depth + o.depth * ext, w: o.w, h: o.depth };
    if (o.dir === 'up') return { x: o.x, y: state.height + o.depth - o.depth * ext - o.h, w: o.w, h: o.depth };
    if (o.dir === 'left') return { x: state.width - o.depth * ext, y: o.y, w: o.depth, h: o.h };
    return { x: -o.depth + o.depth * ext, y: o.y, w: o.depth, h: o.h }; // right
}

function wallObjectCurrentRect(o) {
    return wallObjectRectAt(o, wallObjectExtension(o));
}

function wallObjectFinalRect(o) {
    return wallObjectRectAt(o, 1);
}

function circleHit(p, x, y, r) {
    return Math.hypot(p.x - x, p.y - y) < p.radius + r;
}

function circleRectHit(p, rx, ry, rw, rh) {
    const cx = Math.min(Math.max(p.x, rx), rx + rw);
    const cy = Math.min(Math.max(p.y, ry), ry + rh);
    return Math.hypot(p.x - cx, p.y - cy) < p.radius;
}

function checkCollisions() {
    const p = state.player;

    for (const h of state.hazards) {
        if (circleHit(p, h.x, h.y, h.radius * 0.85)) return endGame();
    }

    for (const l of state.lasers) {
        if (l.phase !== 'firing') continue;
        const half = l.thickness / 2;
        if (l.orientation === 'h') {
            if (Math.abs(p.y - l.pos) < half + p.radius) return endGame();
        } else {
            if (Math.abs(p.x - l.pos) < half + p.radius) return endGame();
        }
    }

    for (const o of state.wallObjects) {
        if (o.phase === 'warning' || (o.phase === 'extend' && wallObjectExtension(o) < 0.15)) continue;
        const r = wallObjectCurrentRect(o);
        if (circleRectHit(p, r.x, r.y, r.w, r.h)) return endGame();
    }
}

function checkAchievements() {
    for (const def of state.achievementDefs) {
        if (state.unlocked.has(def.id)) continue;
        if (state.elapsed >= def.thresholdSeconds) {
            state.unlocked.add(def.id);
            saveProgress();
            showToast(`🏆 Achievement unlocked: ${def.id}`);
            state.dotNetRef.invokeMethodAsync('OnAchievementUnlocked', def.id).catch(() => { });
        }
    }
}

function showToast(text) {
    const el = document.createElement('div');
    el.className = 'dodge-toast';
    el.textContent = text;
    state.els.toastContainer.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 300);
    }, 2600);
}

function endGame() {
    if (state.over) return;
    state.over = true;
    state.running = false;
    cancelAnimationFrame(state.rafId);

    if (state.elapsed * 1000 > state.bestTimeMs) {
        state.bestTimeMs = state.elapsed * 1000;
    }
    saveProgress();

    state.els.gameOverTime.textContent = `You survived ${formatTime(state.elapsed)}`;
    state.els.gameOverOverlay.style.display = 'flex';

    state.dotNetRef.invokeMethodAsync('OnGameOver', state.elapsed).catch(() => { });
    render();
}

function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds - minutes * 60;
    return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

// ---------- rendering ----------

function drawBackground() {
    const { ctx, width, height } = state;
    ctx.clearRect(0, 0, width, height);
    const g = ctx.createRadialGradient(width / 2, height / 2, 10, width / 2, height / 2, Math.max(width, height));
    g.addColorStop(0, '#161a2c');
    g.addColorStop(1, '#0a0c16');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    const step = 40;
    for (let x = 0; x < width; x += step) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y < height; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
}

function drawPlayer() {
    const { ctx, player: p } = state;
    ctx.save();
    ctx.shadowColor = '#5dd3ff';
    ctx.shadowBlur = 16;

    if (state.playerSkinLoaded) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        const size = p.radius * 2;
        ctx.drawImage(state.playerSkin, p.x - p.radius, p.y - p.radius, size, size);
        ctx.restore();
    } else {
        ctx.fillStyle = '#bdf3ff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.strokeStyle = '#5dd3ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

function drawHazards() {
    const { ctx } = state;
    for (const h of state.hazards) {
        ctx.save();
        ctx.translate(h.x, h.y);
        ctx.rotate(h.rotation);
        ctx.shadowColor = h.color;
        ctx.shadowBlur = 10;
        ctx.fillStyle = h.color;
        if (h.shape === 'circle') {
            ctx.beginPath(); ctx.arc(0, 0, h.radius, 0, Math.PI * 2); ctx.fill();
        } else if (h.shape === 'square') {
            ctx.fillRect(-h.radius, -h.radius, h.radius * 2, h.radius * 2);
        } else {
            ctx.beginPath();
            ctx.moveTo(0, -h.radius);
            ctx.lineTo(h.radius, h.radius);
            ctx.lineTo(-h.radius, h.radius);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }
}

function drawLasers() {
    const { ctx, width, height } = state;
    for (const l of state.lasers) {
        ctx.save();
        if (l.phase === 'warning') {
            ctx.strokeStyle = 'rgba(60, 255, 130, 0.85)';
            ctx.lineWidth = 2;
            ctx.setLineDash([10, 8]);
        } else {
            ctx.strokeStyle = '#ffffff';
            ctx.shadowColor = '#ffffff';
            ctx.shadowBlur = 18;
            ctx.lineWidth = l.thickness;
        }
        ctx.beginPath();
        if (l.orientation === 'h') {
            ctx.moveTo(0, l.pos); ctx.lineTo(width, l.pos);
        } else {
            ctx.moveTo(l.pos, 0); ctx.lineTo(l.pos, height);
        }
        ctx.stroke();
        ctx.restore();
    }
}

function drawWallObjects() {
    const { ctx } = state;
    for (const o of state.wallObjects) {
        if (o.phase === 'warning') {
            const r = wallObjectFinalRect(o);
            const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 120);
            ctx.save();
            ctx.strokeStyle = 'rgba(255, 30, 60, 0.85)';
            ctx.lineWidth = 2;
            ctx.setLineDash([10, 8]);
            ctx.strokeRect(r.x, r.y, r.w, r.h);
            ctx.restore();

            ctx.save();
            ctx.globalAlpha = pulse;
            ctx.fillStyle = '#ff3b5c';
            ctx.font = 'bold 22px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = '#ff3b5c';
            ctx.shadowBlur = 10;
            ctx.fillText('!', r.x + r.w / 2, r.y + r.h / 2);
            ctx.restore();
            continue;
        }
        const r = wallObjectCurrentRect(o);
        ctx.save();
        ctx.shadowColor = '#c77dff';
        ctx.shadowBlur = 12;
        ctx.fillStyle = '#a259ff';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.restore();
    }
}

function render() {
    drawBackground();
    drawWallObjects();
    drawLasers();
    drawHazards();
    drawPlayer();
}

export function dispose() {
    if (!state) return;
    cancelAnimationFrame(state.rafId);
    state.resizeObserver?.disconnect();
    for (const [evt, fn, target] of state.listeners) {
        target.removeEventListener(evt, fn);
    }
    state = null;
}