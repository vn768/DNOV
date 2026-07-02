export class BogorocRhytm {
    constructor(canvasId, mapData, audioEl, dotNetRef) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext("2d");

        this.canvas.width = this.canvas.clientWidth;
        this.canvas.height = this.canvas.clientHeight;

        this.W = this.canvas.width;
        this.H = this.canvas.height;

        this.map = mapData;
        this.audioEl = audioEl || null;
        this.dotNetRef = dotNetRef || null;

        this.score = 0;
        this.combo = 0;
        this.maxCombo = 0;
        this.ghostTaps = 0;

        this.startTime = null;
        this.activeBubble = null;
        this.popups = [];
        this.ghostFlashes = [];
        this.disposed = false;
        this.finished = false;

        this.LANES = [
            { key: "a", x: this.W / 2 - this.W * 0.14, color: "#ff5d8f", label: "A" },
            { key: "s", x: this.W / 2, color: "#ffd447", label: "S" },
            { key: "d", x: this.W / 2 + this.W * 0.14, color: "#5dc8ff", label: "D" }
        ];

        // tracks an in-progress hold per lane: { note, headAccuracy }
        this.activeHolds = [null, null, null];

        this.HIT_Y = this.H * 0.69;

        // Faster default travel time (was 1800ms). Maps can override via "travelTimeMs".
        this.TRAVEL_TIME = this.map.travelTimeMs || 1100;

        const scaleFactor = this.W / 700; // 700 was the original reference canvas width

        this.NOTE_R = 36 * scaleFactor;
        this.TAP_R = 42 * scaleFactor;
        this.SPIN_R = 72 * scaleFactor;
        this.DRAG_R = 32 * scaleFactor;
        this.HOLD_WIDTH = 40 * scaleFactor;

        // Hit-line rings now closely match the falling note size instead of
        // ballooning out to +12px.
        this.HIT_RING_R = this.NOTE_R + 6;

        this.WINDOWS = [
            { name: "PERFECT", max: 60, score: 100, color: "#ffd447" },
            { name: "GOOD", max: 120, score: 70, color: "#7dfca1" },
            { name: "MEH", max: 180, score: 40, color: "#7dc3fc" },
            { name: "SAD", max: 200, score: 15, color: "#b98cff" }
        ];

        this.notes = structuredClone(this.map.notes || []);
        this.bubbles = structuredClone(this.map.bubbles || []);
        this.segments = structuredClone(this.map.segments || []);

        this.FREESTYLE_LEAD_MS = 700;

        this.DURATION = this.map.durationMs || this.computeDuration();

        // bound handlers stored so dispose() can remove them
        this._onKeyDown = (e) => this.handleKeyDown(e);
        this._onKeyUp = (e) => this.handleKeyUp(e);
        this._onPointerDown = (e) => this.handlePointerDown(e);
        this._onPointerMove = (e) => this.handlePointerMove(e);
        this._onPointerUp = () => this.handlePointerUp();
        this._onCanvasClick = () => this.start();

        this.bindInput();
        this.loop();
    }

    computeDuration() {
        let max = 0;
        for (const n of this.notes) max = Math.max(max, n.time + (n.holdMs || 0));
        for (const b of this.bubbles) max = Math.max(max, b.time + b.duration);
        for (const s of this.segments) max = Math.max(max, s.end);
        return max + 2000;
    }

    now() {
        return performance.now() - this.startTime;
    }

    start() {
        if (!this.startTime) {
            this.startTime = performance.now();
            if (this.audioEl) {
                try {
                    this.audioEl.currentTime = 0;
                    this.audioEl.play().catch(() => { /* autoplay may be blocked until gesture; click already provides one */ });
                } catch (e) { /* no-op */ }
            }
        }
    }

    bindInput() {
        window.addEventListener("keydown", this._onKeyDown);
        window.addEventListener("keyup", this._onKeyUp);
        this.canvas.addEventListener("click", this._onCanvasClick);
        this.canvas.addEventListener("pointerdown", this._onPointerDown);
        this.canvas.addEventListener("pointermove", this._onPointerMove);
        window.addEventListener("pointerup", this._onPointerUp);
    }

    // ---- combo helpers (single source of truth so max combo stays accurate) ----
    addCombo() {
        this.combo++;
        if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    }

    breakCombo() {
        this.combo = 0;
    }

    isInFreestyle(t) {
        return this.segments.some(s => t >= s.start && t <= s.end);
    }

    handleKeyDown(e) {
        const key = e.key.toLowerCase();
        const lane = this.LANES.findIndex(x => x.key === key);
        if (lane === -1 || !this.startTime || this.finished) return;
        if (e.repeat) return; // ignore OS key-repeat while held

        // During a freestyle segment the keyboard lanes are off - bubbles
        // take over, so keypresses do nothing at all (not even a ghost tap).
        if (this.isInFreestyle(this.now())) return;

        this.tryPressLane(lane);
    }

    handleKeyUp(e) {
        const key = e.key.toLowerCase();
        const lane = this.LANES.findIndex(x => x.key === key);
        if (lane === -1) return;

        this.releaseLane(lane);
    }

    tryPressLane(laneIdx) {
        let t = this.now();
        let best = null;
        let bestDelta = Infinity;

        for (let n of this.notes) {
            if (n.hit || n.missed) continue;
            if (n.lane !== laneIdx) continue;

            let delta = Math.abs(t - n.time);
            if (delta < bestDelta) {
                best = n;
                bestDelta = delta;
            }
        }

        if (!best) {
            // Ghost tap: pressed a lane with nothing nearby to hit. This must
            // NEVER break combo or cost score - it's just visual feedback so
            // the player knows the input registered.
            this.registerGhostTap(laneIdx);
            return;
        }

        if (best.type === "hold") {
            const result = this.WINDOWS.find(x => bestDelta <= x.max);
            if (!result) {
                best.missed = true;
                this.breakCombo();
                return;
            }
            best.hit = true;
            this.activeHolds[laneIdx] = { note: best, headAccuracy: result };
            this.spawnPopup("HOLD", "#ffffff");
        } else {
            best.hit = true;
            const result = this.WINDOWS.find(x => bestDelta <= x.max);
            if (result) {
                this.score += result.score;
                this.addCombo();
                this.spawnPopup(result.name, result.color);
            } else {
                this.breakCombo();
            }
        }
    }

    registerGhostTap(laneIdx) {
        this.ghostTaps++;
        this.ghostFlashes.push({ lane: laneIdx, life: 1 });
    }

    releaseLane(laneIdx) {
        const active = this.activeHolds[laneIdx];
        if (!active) return;

        const note = active.note;
        const t = this.now();
        const holdEnd = note.time + note.holdMs;
        const earlyBy = holdEnd - t;

        if (earlyBy <= 60) {
            this.score += active.headAccuracy.score + 100;
            this.addCombo();
            this.spawnPopup("HOLD PERFECT", "#ffd447");
        } else {
            const totalDuration = note.holdMs;
            const heldDuration = Math.max(0, totalDuration - earlyBy);
            const fraction = heldDuration / totalDuration;
            this.score += Math.round(active.headAccuracy.score * fraction);
            this.breakCombo();
            this.spawnPopup("HOLD BROKEN", "#ff5d8f");
        }

        note.done = true;
        this.activeHolds[laneIdx] = null;
    }

    handlePointerDown(e) {
        if (!this.startTime || this.finished) return;
        const pos = this.getPointerPos(e);

        for (let b of this.bubbles) {
            if (b.done) continue;
            if (this.now() < b.time || this.now() > b.time + b.duration) continue;

            if (b.type === "tap") {
                if (this.distance(pos.x, pos.y, b.x, b.y) <= this.TAP_R) {
                    this.completeBubble(b);
                }
            }

            if (b.type === "spin") {
                if (this.distance(pos.x, pos.y, b.x, b.y) <= this.SPIN_R) {
                    b.holding = true;
                    b.lastAngle = Math.atan2(pos.y - b.y, pos.x - b.x);
                    b.angleAccum = b.angleAccum || 0;
                    this.activeBubble = b;
                }
            }

            if (b.type === "drag") {
                b.holding = true;
                this.activeBubble = b;
            }
        }
    }

    handlePointerMove(e) {
        if (!this.activeBubble) return;
        const pos = this.getPointerPos(e);

        if (this.activeBubble.type === "spin") {
            let angle = Math.atan2(pos.y - this.activeBubble.y, pos.x - this.activeBubble.x);
            let diff = angle - this.activeBubble.lastAngle;
            if (diff > Math.PI) diff -= Math.PI * 2;
            if (diff < -Math.PI) diff += Math.PI * 2;

            this.activeBubble.angleAccum += Math.abs(diff);
            this.activeBubble.lastAngle = angle;

            if (this.activeBubble.angleAccum >= Math.PI * 4) {
                this.completeBubble(this.activeBubble);
            }
        }

        if (this.activeBubble.type === "drag") {
            const path = this.activeBubble.path;
            let next = this.activeBubble.progress || 0;

            if (next < path.length - 1) {
                let target = path[next];
                if (this.distance(pos.x, pos.y, target.x, target.y) < 50) {
                    this.activeBubble.progress = next + 1;
                }
            }

            if (this.activeBubble.progress >= path.length - 1) {
                this.completeBubble(this.activeBubble);
            }
        }
    }

    handlePointerUp() {
        if (this.activeBubble) {
            this.activeBubble.holding = false;
            this.activeBubble = null;
        }
    }

    completeBubble(bubble) {
        bubble.done = true;
        this.score += 150;
        this.addCombo();
        this.spawnPopup("NICE!", "#ffffff");
    }

    spawnPopup(text, color) {
        this.popups.push({ text, color, life: 1 });
    }

    updateNotes() {
        if (!this.startTime || this.finished) return;
        let t = this.now();

        if (t >= this.DURATION) {
            this.finish();
            return;
        }

        for (let n of this.notes) {
            if (n.hit || n.missed || n.done) continue;

            if (t > n.time + 220) {
                n.missed = true;
                this.breakCombo();
            }
        }

        for (let lane = 0; lane < this.activeHolds.length; lane++) {
            const active = this.activeHolds[lane];
            if (!active) continue;

            const holdEnd = active.note.time + active.note.holdMs;
            if (t >= holdEnd) {
                this.score += active.headAccuracy.score + 100;
                this.addCombo();
                this.spawnPopup("HOLD PERFECT", "#ffd447");
                active.note.done = true;
                this.activeHolds[lane] = null;
            }
        }

        for (const f of this.ghostFlashes) f.life -= 0.06;
        this.ghostFlashes = this.ghostFlashes.filter(f => f.life > 0);
    }

    finish() {
        if (this.finished) return;
        this.finished = true;

        if (this.audioEl) {
            try { this.audioEl.pause(); } catch (e) { /* no-op */ }
        }

        if (this.dotNetRef) {
            this.dotNetRef.invokeMethodAsync("OnGameFinished", this.score, this.maxCombo)
                .catch(() => { /* component may already be gone */ });
        }
    }

    // Fraction (0-1) that falling keyboard notes should fade to as a
    // freestyle segment approaches. 1 = fully visible, 0 = fully faded.
    noteFadeFactor(t) {
        let fade = 1;
        for (const seg of this.segments) {
            const leadStart = seg.start - this.FREESTYLE_LEAD_MS;
            if (t >= leadStart && t <= seg.start) {
                fade = Math.min(fade, 1 - (t - leadStart) / this.FREESTYLE_LEAD_MS);
            } else if (t > seg.start && t < seg.end) {
                fade = 0;
            }
        }
        return Math.max(0, fade);
    }

    drawNotes() {
        let t = this.now();
        const fade = this.noteFadeFactor(t);
        if (fade <= 0) return;

        this.ctx.globalAlpha = fade;

        for (let note of this.notes) {
            if (note.hit && note.type !== "hold") continue;
            if (note.missed || note.done) continue;

            let lane = this.LANES[note.lane];

            if (note.type === "hold") {
                const headY = this.HIT_Y - ((note.time - t) / this.TRAVEL_TIME) * this.HIT_Y;
                const tailTime = note.time + note.holdMs;
                const tailY = this.HIT_Y - ((tailTime - t) / this.TRAVEL_TIME) * this.HIT_Y;

                this.ctx.fillStyle = lane.color + "aa";
                this.ctx.fillRect(lane.x - this.HOLD_WIDTH / 2, tailY, this.HOLD_WIDTH, headY - tailY);

                if (!note.hit) {
                    this.ctx.beginPath();
                    this.ctx.arc(lane.x, headY, this.NOTE_R, 0, Math.PI * 2);
                    this.ctx.fillStyle = lane.color;
                    this.ctx.fill();
                }

                const active = this.activeHolds[note.lane];
                if (active && active.note === note) {
                    this.ctx.strokeStyle = "#ffffff";
                    this.ctx.lineWidth = 4;
                    this.ctx.strokeRect(lane.x - this.HOLD_WIDTH / 2, this.HIT_Y - 6, this.HOLD_WIDTH, 12);
                }
            } else {
                let y = this.HIT_Y - ((note.time - t) / this.TRAVEL_TIME) * this.HIT_Y;
                this.ctx.beginPath();
                this.ctx.arc(lane.x, y, this.NOTE_R, 0, Math.PI * 2);
                this.ctx.fillStyle = lane.color;
                this.ctx.fill();
            }
        }

        this.ctx.globalAlpha = 1;
    }

    lerpColor(a, b, frac) {
        const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
        const ar = (ah >> 16) & 255, ag = (ah >> 8) & 255, ab = ah & 255;
        const br = (bh >> 16) & 255, bg = (bh >> 8) & 255, bb = bh & 255;
        const rr = Math.round(ar + (br - ar) * frac);
        const rg = Math.round(ag + (bg - ag) * frac);
        const rb = Math.round(ab + (bb - ab) * frac);
        return `rgb(${rr},${rg},${rb})`;
    }

    drawBubbles() {
        let t = this.now();

        for (let b of this.bubbles) {
            if (b.done) continue;
            if (t < b.time || t > b.time + b.duration) continue;

            if (b.type === "tap") {
                this.ctx.beginPath();
                this.ctx.arc(b.x, b.y, this.TAP_R, 0, Math.PI * 2);
                this.ctx.fillStyle = "#a855f7";
                this.ctx.fill();
            }

            if (b.type === "spin") {
                const frac = Math.min(1, (b.angleAccum || 0) / (Math.PI * 4));
                const ringColor = this.lerpColor("#ffffff", "#22c55e", frac);

                this.ctx.beginPath();
                this.ctx.arc(b.x, b.y, this.SPIN_R, 0, Math.PI * 2);
                this.ctx.strokeStyle = ringColor;
                this.ctx.lineWidth = 8;
                this.ctx.stroke();

                this.ctx.beginPath();
                this.ctx.arc(b.x, b.y, 36, 0, Math.PI * 2);
                this.ctx.fillStyle = ringColor;
                this.ctx.fill();
            }

            if (b.type === "drag") {
                this.ctx.beginPath();
                for (let i = 0; i < b.path.length; i++) {
                    const p = b.path[i];
                    if (i === 0) this.ctx.moveTo(p.x, p.y);
                    else this.ctx.lineTo(p.x, p.y);
                }
                this.ctx.strokeStyle = "rgba(255,255,255,0.7)";
                this.ctx.lineWidth = 24;
                this.ctx.stroke();

                let current = b.path[b.progress || 0];
                this.ctx.beginPath();
                this.ctx.arc(current.x, current.y, this.DRAG_R, 0, Math.PI * 2);
                this.ctx.fillStyle = "#3b82f6";
                this.ctx.fill();
            }
        }
    }

    drawSegmentWarnings() {
        const t = this.now();

        for (const seg of this.segments) {
            const leadStart = seg.start - this.FREESTYLE_LEAD_MS;

            if (t >= leadStart && t <= seg.start) {
                const progress = (t - leadStart) / this.FREESTYLE_LEAD_MS;
                const pulse = 0.4 + 0.6 * Math.abs(Math.sin(t / 90));
                const alpha = progress * pulse;

                this.ctx.fillStyle = `rgba(255,40,80,${alpha * 0.55})`;
                this.ctx.fillRect(0, 0, 60, this.H);
                this.ctx.fillRect(this.W - 60, 0, 60, this.H);

                this.ctx.fillStyle = `rgba(255,255,255,${Math.min(1, alpha + 0.2)})`;
                this.ctx.font = "bold 34px sans-serif";
                this.ctx.fillText("!", 18, 60);
                this.ctx.fillText("!", this.W - 42, 60);
            }
        }
    }

    drawGhostFlashes() {
        for (const f of this.ghostFlashes) {
            const lane = this.LANES[f.lane];
            this.ctx.globalAlpha = f.life * 0.5;
            this.ctx.beginPath();
            this.ctx.arc(lane.x, this.HIT_Y, this.HIT_RING_R + 6, 0, Math.PI * 2);
            this.ctx.strokeStyle = "#ffffff";
            this.ctx.lineWidth = 2;
            this.ctx.stroke();
            this.ctx.globalAlpha = 1;
        }
    }

    drawPopups() {
        for (let p of this.popups) {
            this.ctx.globalAlpha = p.life;
            this.ctx.fillStyle = p.color;
            this.ctx.font = "bold 28px sans-serif";
            this.ctx.fillText(p.text, this.W / 2 - 60, 120);
            p.life -= 0.02;
        }
        this.ctx.globalAlpha = 1;
        this.popups = this.popups.filter(x => x.life > 0);
    }

    drawHUD() {
        this.ctx.fillStyle = "white";
        this.ctx.font = "22px sans-serif";
        this.ctx.fillText(`Score: ${this.score}`, 30, 40);
        this.ctx.fillText(`Combo: ${this.combo}`, 30, 75);
    }

    drawHitLine() {
        for (let lane of this.LANES) {
            this.ctx.beginPath();
            this.ctx.arc(lane.x, this.HIT_Y, this.HIT_RING_R, 0, Math.PI * 2);
            this.ctx.strokeStyle = lane.color;
            this.ctx.lineWidth = 3;
            this.ctx.stroke();
        }
    }

    getPointerPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (this.W / rect.width),
            y: (e.clientY - rect.top) * (this.H / rect.height)
        };
    }

    distance(x1, y1, x2, y2) {
        return Math.hypot(x2 - x1, y2 - y1);
    }

    loop() {
        if (this.disposed) return;

        this.ctx.clearRect(0, 0, this.W, this.H);

        if (this.startTime && !this.finished) {
            this.updateNotes();
            this.drawSegmentWarnings();
            this.drawNotes();
            this.drawBubbles();
            this.drawGhostFlashes();
            this.drawPopups();
            this.drawHUD();
            this.drawHitLine();
        } else if (!this.startTime) {
            this.ctx.fillStyle = "white";
            this.ctx.font = "bold 28px sans-serif";
            this.ctx.fillText("Click to Start", this.W / 2 - 80, this.H / 2);
        }
        // when finished, leave the canvas blank - the Blazor stats overlay
        // takes over the visuals at that point.

        requestAnimationFrame(() => this.loop());
    }

    dispose() {
        this.disposed = true;

        if (this.audioEl) {
            try { this.audioEl.pause(); } catch (e) { /* no-op */ }
        }

        window.removeEventListener("keydown", this._onKeyDown);
        window.removeEventListener("keyup", this._onKeyUp);
        window.removeEventListener("pointerup", this._onPointerUp);
        this.canvas.removeEventListener("click", this._onCanvasClick);
        this.canvas.removeEventListener("pointerdown", this._onPointerDown);
        this.canvas.removeEventListener("pointermove", this._onPointerMove);
    }
}

export function createBogorocRhytm(canvasId, mapData, audioEl, dotNetRef) {
    return new BogorocRhytm(canvasId, mapData, audioEl, dotNetRef);
}