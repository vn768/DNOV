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

        // Song volume, 0-1. Kept as its own field (rather than just reading
        // audioEl.volume) so it survives even before/without an audio
        // element, and so bindVolumeSlider() has a single source of truth.
        this.volume = this.audioEl ? this.audioEl.volume : 1;

        this.score = 0;
        this.combo = 0;
        this.maxCombo = 0;
        this.misses = 0;
        this.ghostTaps = 0;

        this.startTime = null;
        this.activeBubble = null;
        this.popups = [];
        this.ghostFlashes = [];
        this.bubbleBursts = [];
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

        // Hit-line rings are now exactly the same radius as the falling
        // notes, so the "socket" a note drops into is the same size as the
        // note itself instead of being larger than it.
        this.HIT_RING_R = this.NOTE_R;

        this.WINDOWS = [
            { name: "PERFECT", max: 60, score: 100, color: "#ffd447" },
            { name: "GOOD", max: 120, score: 70, color: "#7dfca1" },
            { name: "MEH", max: 180, score: 40, color: "#7dc3fc" },
            { name: "SAD", max: 200, score: 15, color: "#b98cff" }
        ];

        this.notes = structuredClone(this.map.notes || []);
        this.bubbles = structuredClone(this.map.bubbles || []);
        this.segments = structuredClone(this.map.segments || []);

        // How long before a freestyle segment the keyboard notes start
        // dissolving away. Longer than the note travel time so the fade
        // reads as a deliberate wind-down rather than a last-second cut.
        this.FREESTYLE_LEAD_MS = 1300;

        // How long after a freestyle segment ends the keyboard notes take
        // to fade back in. Mirrors FREESTYLE_LEAD_MS so the return to
        // keyboard play feels like the reverse of the wind-down.
        this.FREESTYLE_FADEIN_MS = 1300;

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

    // ---- volume control ----

    // fraction is 0 (silent) to 1 (full volume).
    setVolume(fraction) {
        const v = Math.min(1, Math.max(0, Number(fraction) || 0));
        this.volume = v;
        if (this.audioEl) this.audioEl.volume = v;
    }

    getVolume() {
        return this.volume;
    }

    // Wires up an existing <input type="range"> element as the song's
    // volume slider. Works with any min/max/step the slider declares
    // (e.g. 0-1 with step="0.01", or the more common 0-100) - the actual
    // range is read off the element itself and mapped to a 0-1 fraction.
    // Safe to call any time after construction, before or after start().
    bindVolumeSlider(sliderId) {
        const slider = document.getElementById(sliderId);
        if (!slider) return;

        this._volumeSlider = slider;

        const min = Number(slider.min) || 0;
        const max = Number(slider.max) || 1;
        const toFraction = (raw) => (max === min) ? 1 : (Number(raw) - min) / (max - min);
        const fromFraction = (frac) => min + frac * (max - min);

        // Reflect whatever volume is already set (e.g. from a saved
        // preference) onto the slider's own scale.
        slider.value = fromFraction(this.volume);

        this._onVolumeInput = () => this.setVolume(toFraction(slider.value));
        slider.addEventListener("input", this._onVolumeInput);
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
        this.misses++;
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

        // A note only becomes pressable once its circle is within 5px of
        // touching the hit-line ring - measured edge-to-edge, not
        // center-to-center. Since the note and the ring share the same
        // radius (NOTE_R), their edges are `5px` apart once their centers
        // are `2 * NOTE_R + 5` apart. Convert that pixel distance into the
        // equivalent time window using the note's fall speed, so this
        // stays correct regardless of canvas size or a map's travelTimeMs.
        const pxPerMs = this.HIT_Y / this.TRAVEL_TIME;
        const maxCenterDistancePx = (2 * this.NOTE_R) + 5;
        const maxDeltaMs = maxCenterDistancePx / pxPerMs;

        for (let n of this.notes) {
            if (n.hit || n.missed) continue;
            if (n.lane !== laneIdx) continue;

            let delta = Math.abs(t - n.time);
            if (delta > maxDeltaMs) continue; // too far from the note space to be pressed at all

            if (delta < bestDelta) {
                best = n;
                bestDelta = delta;
            }
        }

        if (!best) {
            // Ghost tap: pressed a lane with nothing close enough to hit. This must
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
                // You have to actually grab the knob where it currently sits
                // (its last-reached waypoint) to start dragging - clicking
                // anywhere on screen shouldn't pick it up.
                const anchor = b.path[b.progress || 0];
                const grabR = this.DRAG_R + 24;
                if (this.distance(pos.x, pos.y, anchor.x, anchor.y) <= grabR) {
                    b.holding = true;
                    b.knobPos = { x: anchor.x, y: anchor.y };
                    this.activeBubble = b;
                }
            }
        }
    }

    handlePointerMove(e) {
        if (!this.activeBubble || this.activeBubble.done) return;
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
            const b = this.activeBubble;
            const path = b.path;

            // The knob now follows the pointer directly so it reads as a
            // real drag instead of teleporting between waypoints.
            b.knobPos = { x: pos.x, y: pos.y };

            const progress = b.progress || 0;
            if (progress < path.length - 1) {
                // Bug fix: this used to check distance against path[progress]
                // (the waypoint you're already standing on), which is nearly
                // always true right after grabbing it - so a single small
                // move instantly finished the whole path. It now checks
                // against path[progress + 1], the waypoint you actually have
                // to travel to next.
                const target = path[progress + 1];
                if (this.distance(pos.x, pos.y, target.x, target.y) < 40) {
                    b.progress = progress + 1;
                    // Snap cleanly onto the waypoint once reached, rather
                    // than leaving the knob wherever the pointer happened
                    // to be when it crossed the threshold.
                    b.knobPos = { x: target.x, y: target.y };
                }
            }

            if (b.progress >= path.length - 1) {
                this.completeBubble(b);
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
                const progress = (t - leadStart) / this.FREESTYLE_LEAD_MS;
                // Smoothstep easing: holds near full opacity a touch longer,
                // then dissolves away with acceleration rather than a flat
                // linear fade - reads as a much slower, gentler wind-down.
                const eased = progress * progress * (3 - 2 * progress);
                fade = Math.min(fade, 1 - eased);
            } else if (t > seg.start && t < seg.end) {
                fade = 0;
            } else if (t >= seg.end && t <= seg.end + this.FREESTYLE_FADEIN_MS) {
                // Mirror of the lead-out fade: notes dissolve back in over
                // FREESTYLE_FADEIN_MS once the freestyle segment ends,
                // instead of snapping straight back to full opacity.
                const progress = (t - seg.end) / this.FREESTYLE_FADEIN_MS;
                const eased = progress * progress * (3 - 2 * progress);
                fade = Math.min(fade, eased);
            }
        }
        return Math.max(0, fade);
    }

    drawNotes() {
        let t = this.now();
        const fade = this.noteFadeFactor(t);
        if (fade <= 0) return;

        this.ctx.globalAlpha = fade;

        // As a note dissolves (fade < 1) it also eases down a little and
        // shrinks slightly, instead of just cutting opacity - reads as the
        // note melting away rather than an abrupt disappearance. Both are
        // no-ops while fade is 1 (normal play).
        const dissolveShrink = 0.78 + 0.22 * fade;
        const dissolveDrift = (1 - fade) * 12;

        for (let note of this.notes) {
            if (note.hit && note.type !== "hold") continue;
            if (note.missed || note.done) continue;

            let lane = this.LANES[note.lane];

            if (note.type === "hold") {
                const headY = this.HIT_Y - ((note.time - t) / this.TRAVEL_TIME) * this.HIT_Y + dissolveDrift;
                const tailTime = note.time + note.holdMs;
                const tailY = this.HIT_Y - ((tailTime - t) / this.TRAVEL_TIME) * this.HIT_Y + dissolveDrift;

                this.ctx.fillStyle = lane.color + "aa";
                this.ctx.fillRect(lane.x - this.HOLD_WIDTH / 2, tailY, this.HOLD_WIDTH, headY - tailY);

                if (!note.hit) {
                    this.ctx.beginPath();
                    this.ctx.arc(lane.x, headY, this.NOTE_R * dissolveShrink, 0, Math.PI * 2);
                    this.ctx.fillStyle = lane.color;
                    this.ctx.fill();
                    this.drawLabel(lane.x, headY, lane.label, this.NOTE_R * 0.55 * dissolveShrink);
                }

                const active = this.activeHolds[note.lane];
                if (active && active.note === note) {
                    this.ctx.strokeStyle = "#ffffff";
                    this.ctx.lineWidth = 4;
                    this.ctx.strokeRect(lane.x - this.HOLD_WIDTH / 2, this.HIT_Y - 6, this.HOLD_WIDTH, 12);
                }
            } else {
                let y = this.HIT_Y - ((note.time - t) / this.TRAVEL_TIME) * this.HIT_Y + dissolveDrift;
                this.ctx.beginPath();
                this.ctx.arc(lane.x, y, this.NOTE_R * dissolveShrink, 0, Math.PI * 2);
                this.ctx.fillStyle = lane.color;
                this.ctx.fill();
                this.drawLabel(lane.x, y, lane.label, this.NOTE_R * 0.55 * dissolveShrink);
            }
        }

        this.ctx.globalAlpha = 1;
    }

    // Draws bold, high-contrast centered text - used for the A/S/D lane
    // letters on keyboard notes and the CLICK/SPIN/DRAG labels on bubbles.
    // A stroke opposite the fill keeps it legible over any note/bubble color.
    drawLabel(x, y, text, fontSize, fillColor = "#ffffff", strokeColor = "rgba(0,0,0,0.55)") {
        if (fontSize <= 0) return;
        this.ctx.save();
        this.ctx.font = `bold ${fontSize}px sans-serif`;
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.lineWidth = Math.max(2, fontSize * 0.16);
        this.ctx.strokeStyle = strokeColor;
        this.ctx.strokeText(text, x, y);
        this.ctx.fillStyle = fillColor;
        this.ctx.fillText(text, x, y);
        this.ctx.restore();
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

    // Draws a small white arrowhead ahead of the drag knob, oriented toward
    // `target`. Used to tell the player which direction to drag next -
    // including back toward an earlier point on round-trip paths.
    drawDragArrow(current, target) {
        const angle = Math.atan2(target.y - current.y, target.x - current.x);
        const dist = this.distance(current.x, current.y, target.x, target.y);

        // Sit the arrow just past the knob, but never past the target itself.
        const arrowDist = Math.min(this.DRAG_R + 26, Math.max(dist - 12, 0));
        if (arrowDist <= 0) return;

        const ax = current.x + Math.cos(angle) * arrowDist;
        const ay = current.y + Math.sin(angle) * arrowDist;

        const size = 15;
        this.ctx.save();
        this.ctx.translate(ax, ay);
        this.ctx.rotate(angle);
        this.ctx.beginPath();
        this.ctx.moveTo(size, 0);
        this.ctx.lineTo(-size * 0.6, -size * 0.7);
        this.ctx.lineTo(-size * 0.6, size * 0.7);
        this.ctx.closePath();
        this.ctx.fillStyle = "#ffffff";
        this.ctx.globalAlpha = 0.95;
        this.ctx.fill();
        this.ctx.restore();
    }

    // ---- small easing helpers used to make bubbles feel alive ----
    smoothstep01(x) {
        x = Math.max(0, Math.min(1, x));
        return x * x * (3 - 2 * x);
    }

    easeOutBack(x) {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }

    // Scale factor for a bubble's "pop-in" entrance: snaps in with a slight
    // overshoot over ~220ms rather than appearing instantly at full size.
    bubbleEntranceScale(b, t) {
        const age = t - b.time;
        const dur = 220;
        if (age >= dur) return 1;
        if (age <= 0) return 0;
        return Math.max(0, this.easeOutBack(age / dur));
    }

    drawBubbles() {
        const t = this.now();

        for (let b of this.bubbles) {
            if (b.done) continue;
            if (t < b.time || t > b.time + b.duration) continue;

            const entrance = this.bubbleEntranceScale(b, t);
            // Per-bubble phase offset (derived from its own spawn time) so
            // multiple bubbles don't all breathe in perfect lockstep.
            const phase = (b.time % 1000) * 0.01;
            const breathe = 1 + 0.05 * Math.sin(t / 220 + phase);
            const scale = entrance * breathe;

            // 1 right when the bubble appears, 0 right as its window closes.
            const remaining = 1 - Math.min(1, Math.max(0, (t - b.time) / b.duration));

            if (b.type === "tap") this.drawTapBubble(b, scale, remaining);
            if (b.type === "spin") this.drawSpinBubble(b, scale, t);
            if (b.type === "drag") this.drawDragBubble(b, scale, t);
        }
    }

    drawTapBubble(b, scale, remaining) {
        const r = this.TAP_R * scale;
        if (r <= 0) return;

        this.ctx.save();
        this.ctx.shadowColor = "#c084fc";
        this.ctx.shadowBlur = 22;

        const grad = this.ctx.createRadialGradient(
            b.x - r * 0.3, b.y - r * 0.3, r * 0.15,
            b.x, b.y, r
        );
        grad.addColorStop(0, "#f3e8ff");
        grad.addColorStop(0.55, "#a855f7");
        grad.addColorStop(1, "#6b21a8");

        this.ctx.beginPath();
        this.ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        this.ctx.fillStyle = grad;
        this.ctx.fill();
        this.ctx.restore();

        this.drawLabel(b.x, b.y, "CLICK", r * 0.32);

        // Approach ring: starts larger than the bubble and shrinks in as its
        // window runs out, shifting from white to red for urgency - the
        // same visual language as an osu!-style approach circle.
        const approachR = r + remaining * r * 0.9;
        const ringColor = this.lerpColor("#ffffff", "#ff3b5c", 1 - remaining);
        this.ctx.beginPath();
        this.ctx.arc(b.x, b.y, approachR, 0, Math.PI * 2);
        this.ctx.strokeStyle = ringColor;
        this.ctx.globalAlpha = 0.85;
        this.ctx.lineWidth = 3;
        this.ctx.stroke();
        this.ctx.globalAlpha = 1;
    }

    drawSpinBubble(b, scale, t) {
        const ringR = this.SPIN_R * scale;
        if (ringR <= 0) return;

        // The ring starts pure white and eases toward green as the player
        // accumulates rotation around the bubble; it also thickens and
        // glows harder the closer they get to finishing the spin.
        const frac = Math.min(1, (b.angleAccum || 0) / (Math.PI * 4));
        const ringColor = this.lerpColor("#ffffff", "#22c55e", frac);

        this.ctx.save();
        this.ctx.shadowColor = ringColor;
        this.ctx.shadowBlur = 14 + frac * 12;
        this.ctx.beginPath();
        this.ctx.arc(b.x, b.y, ringR, 0, Math.PI * 2);
        this.ctx.strokeStyle = ringColor;
        this.ctx.lineWidth = 8 + frac * 4;
        this.ctx.stroke();
        this.ctx.restore();

        // Before the player grabs it, three chevrons drift slowly around
        // the ring hinting at the spin motion, so the bubble doesn't just
        // sit there looking static while it waits to be touched.
        if (!b.holding) {
            const hintAngle = t / 280;
            for (let i = 0; i < 3; i++) {
                const a = hintAngle + (i * Math.PI * 2) / 3;
                this.drawChevron(
                    b.x + Math.cos(a) * ringR,
                    b.y + Math.sin(a) * ringR,
                    a + Math.PI / 2,
                    ringColor
                );
            }
        }

        // The bubble itself stays white the whole time - only the ring and
        // ambient hints communicate spin progress - and gently breathes
        // via `scale`.
        this.ctx.beginPath();
        this.ctx.arc(b.x, b.y, 36 * scale, 0, Math.PI * 2);
        this.ctx.fillStyle = "#ffffff";
        this.ctx.fill();

        this.drawLabel(b.x, b.y, "SPIN", 36 * scale * 0.42, "#1f2937", "rgba(255,255,255,0.65)");
    }

    drawChevron(x, y, angle, color) {
        const size = 10;
        this.ctx.save();
        this.ctx.translate(x, y);
        this.ctx.rotate(angle);
        this.ctx.beginPath();
        this.ctx.moveTo(-size * 0.6, -size);
        this.ctx.lineTo(size * 0.6, 0);
        this.ctx.lineTo(-size * 0.6, size);
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 3;
        this.ctx.lineCap = "round";
        this.ctx.lineJoin = "round";
        this.ctx.stroke();
        this.ctx.restore();
    }

    drawDragBubble(b, scale, t) {
        // Guide line: a soft wide base plus an animated "marching ants"
        // overlay so the path reads as something actively flowing rather
        // than a static bar. Paths with 3+ points (out -> back) already
        // read as round-trip; more waypoints along a curve shape make the
        // line read as curved instead of straight.
        this.ctx.save();
        this.ctx.beginPath();
        for (let i = 0; i < b.path.length; i++) {
            const p = b.path[i];
            if (i === 0) this.ctx.moveTo(p.x, p.y);
            else this.ctx.lineTo(p.x, p.y);
        }
        this.ctx.strokeStyle = "rgba(255,255,255,0.32)";
        this.ctx.lineWidth = 26;
        this.ctx.stroke();

        this.ctx.setLineDash([18, 14]);
        this.ctx.lineDashOffset = -t / 18;
        this.ctx.strokeStyle = "rgba(255,255,255,0.9)";
        this.ctx.lineWidth = 6;
        this.ctx.stroke();
        this.ctx.restore();

        const progress = b.progress || 0;
        // The knob renders at its live, pointer-tracked position while being
        // dragged, falling back to its last-reached waypoint before it's
        // been grabbed at all.
        const current = b.knobPos || b.path[progress];

        // Direction arrow: points from the current knob position toward the
        // next waypoint, so the player always knows which way to drag next
        // - including the "drag back" portion of a round-trip path.
        const nextIdx = progress + 1;
        if (nextIdx < b.path.length) {
            this.drawDragArrow(current, b.path[nextIdx]);
        }

        const r = this.DRAG_R * scale;
        if (r <= 0) return;

        this.ctx.save();
        this.ctx.shadowColor = "#60a5fa";
        this.ctx.shadowBlur = 18;
        const grad = this.ctx.createRadialGradient(
            current.x - r * 0.3, current.y - r * 0.3, r * 0.15,
            current.x, current.y, r
        );
        grad.addColorStop(0, "#dbeafe");
        grad.addColorStop(0.6, "#3b82f6");
        grad.addColorStop(1, "#1d4ed8");
        this.ctx.beginPath();
        this.ctx.arc(current.x, current.y, r, 0, Math.PI * 2);
        this.ctx.fillStyle = grad;
        this.ctx.fill();
        this.ctx.restore();

        this.drawLabel(current.x, current.y, "DRAG", r * 0.32);
    }

    // Short-lived expanding ring drawn wherever a bubble was just completed
    // - a small "pop" of feedback instead of the bubble just vanishing.
    drawBubbleBursts() {
        for (const burst of this.bubbleBursts) {
            const grow = (1 - burst.life) * 55;
            this.ctx.globalAlpha = burst.life;
            this.ctx.beginPath();
            this.ctx.arc(burst.x, burst.y, 18 + grow, 0, Math.PI * 2);
            this.ctx.strokeStyle = "#ffffff";
            this.ctx.lineWidth = 4;
            this.ctx.stroke();
            burst.life -= 0.06;
        }
        this.ctx.globalAlpha = 1;
        this.bubbleBursts = this.bubbleBursts.filter(x => x.life > 0);
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
        this.ctx.fillText(`Combo Break: ${this.misses}`, 30, 110);
    }

    drawHitLine() {
        // The hit-ring "sockets" fade out/in in lockstep with the falling
        // notes, since they're meaningless once the keyboard lanes go
        // quiet for a freestyle segment.
        const fade = this.noteFadeFactor(this.now());
        if (fade <= 0) return;

        this.ctx.globalAlpha = fade;
        for (let lane of this.LANES) {
            this.ctx.beginPath();
            this.ctx.arc(lane.x, this.HIT_Y, this.HIT_RING_R, 0, Math.PI * 2);
            this.ctx.strokeStyle = lane.color;
            this.ctx.lineWidth = 3;
            this.ctx.stroke();
        }
        this.ctx.globalAlpha = 1;
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

        if (this._volumeSlider && this._onVolumeInput) {
            this._volumeSlider.removeEventListener("input", this._onVolumeInput);
        }
    }
}

export function createBogorocRhytm(canvasId, mapData, audioEl, dotNetRef) {
    return new BogorocRhytm(canvasId, mapData, audioEl, dotNetRef);
}