// wwwroot/js/BogorocRhytm.js
//
// Rhythm-game engine used by Pages/BogorocRhytm.razor.
// Exposes a single factory function, createBogorocRhytm(...), which the
// Blazor component invokes once per song via JS interop.
//
// Expected call from C#:
//   _gameInstance = await _module.InvokeAsync<IJSObjectReference>(
//       "createBogorocRhytm", "rhythmCanvas", mapData, _audioRef, _dotNetRef);
//
// mapData shape (from MapData.cs):
//   { TravelTimeMs, DurationMs, Notes: [...], Bubbles: [...], Segments: [...] }
//
// NoteData:   { Type: "tap"|"hold", Lane, Time, HoldMs }
// BubbleData: { Type: "tap"|"spin"|"drag", Time, Duration, X, Y, Path }
// SegmentData:{ Start, End }
//
// X / Y for bubbles are treated as percentages (0-100) of the canvas size,
// so the layout scales with whatever size the <canvas> is given in CSS.
//
// Drag bubbles: `Path` describes the ONE-WAY trip from point A (the bubble's
// own X/Y) to point B. The engine automatically mirrors that path to build
// the return trip B -> A, so a map only needs to define the outbound leg.
// The path can be a straight 2-point line or a longer polyline that
// approximates a curve - either way it is rendered as an osu!-style white
// guide line with a directional arrow, and straying more than
// MAX_DRAG_DEVIATION_PX away from that line counts as a miss.
//
// While a drag bubble is actively being dragged, the yellow circle itself
// tracks the pointer's live position (see activeDrag.currentX/currentY and
// its use in drawBubbles) rather than staying pinned to its anchor - the
// guide line stays fixed as the "path to trace", and the filled circle is
// the visual feedback for where the player's finger/cursor actually is.

const LANES = ["a", "s", "d"];
const LANE_KEYS = { a: 0, s: 1, d: 2 };
const HIT_TOLERANCE_PX = 5;    // max gap between note edge and receptor edge that still counts as a hit
const PERFECT_WINDOW_MS = 45;  // inside this time window counts as "perfect"
const NOTE_TRAVEL_DEFAULT_MS = 1600;
const SEGMENT_FADE_MS = 300;        // crossfade length when entering/leaving a clickable segment
const MAX_DRAG_DEVIATION_PX = 60;   // how far a drag can stray from its guide line before it's a miss
const SPINNER_START_COLOR = "#ff5d8f";
const SPINNER_DONE_COLOR = "#3ddc71";
const DEFAULT_VOLUME_SLIDER_ID = "volume-slider";

// Bubble sizing (osu!-circle scale, not the tiny mania-note scale).
const BUBBLE_OUTER_RADIUS = 36;   // outer ring / hit-area ring
const BUBBLE_FILL_RADIUS = 24;    // solid center fill (tap/drag) or spin's max fill
const BUBBLE_HIT_PERCENT = 10;    // pointerdown hit-test radius, in canvas-percent units
const BUBBLE_LABEL_FONT = "bold 12px sans-serif";

// Red "stage switching" edge-flash, shown briefly around a segment's start
// and end to call out that clickable-bubble mode is toggling.
const STAGE_FLASH_WINDOW_MS = 600;  // how long before/after a transition the flash is visible
const STAGE_FLASH_BAR_WIDTH = 56;   // width in px of each edge bar

// Reserved header strip along the top of the canvas for Score/Combo/Combo
// Break and the judgment popup. The lane grid and falling notes start below
// this strip instead of at y=0, so the HUD text never overlaps gameplay.
const HUD_HEIGHT = 84;

export function createBogorocRhytm(canvasId, mapData, audioElementRef, dotNetRef) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) {
        console.error(`BogorocRhytm: canvas #${canvasId} not found`);
        return { bindVolumeSlider() { }, dispose() { } };
    }
    const ctx = canvas.getContext("2d");

    // Prevent the browser from treating pointer drags on the canvas as a
    // scroll/pan/swipe gesture. Without this, mobile browsers (and some
    // desktop browsers with touch/trackpad gestures enabled) can swallow
    // pointermove events entirely once a drag exceeds their own gesture
    // threshold, which makes "drag" bubbles feel completely uninteractable
    // even though pointerdown fired correctly.
    canvas.style.touchAction = "true";

    // Also disable the browser's *native* drag gesture on the canvas. Some
    // browsers (Safari in particular, occasionally Chrome) interpret a
    // press-and-drag on a <canvas> as an image-drag-out gesture once the
    // pointer moves far enough - the OS then takes over the gesture and
    // pointermove stops firing entirely, even with touch-action set. This
    // is what makes "drag" bubbles specifically (not taps) feel broken.
    canvas.setAttribute("draggable", "true");
    canvas.style.setProperty("-webkit-user-drag", "true");
    canvas.style.userSelect = "none";
    canvas.style.webkitUserSelect = "none";
    canvas.addEventListener("dragstart", (e) => e.preventDefault());

    // ---- normalize incoming data ----
    const travelMs = mapData?.travelTimeMs ?? mapData?.TravelTimeMs ?? NOTE_TRAVEL_DEFAULT_MS;
    const durationMs = mapData?.durationMs ?? mapData?.DurationMs ?? 0;
    const notes = (mapData?.notes ?? mapData?.Notes ?? []).map(n => ({
        type: (n.type ?? n.Type ?? "tap").toLowerCase(),
        lane: n.lane ?? n.Lane ?? 0,
        time: n.time ?? n.Time ?? 0,
        holdMs: n.holdMs ?? n.HoldMs ?? null,
        hit: false,
        holdActive: false,
        holdReleased: false,
    }));
    const bubbles = (mapData?.bubbles ?? mapData?.Bubbles ?? []).map(b => {
        const type = (b.type ?? b.Type ?? "tap").toLowerCase();
        const rawPath = (b.path ?? b.Path ?? null);
        const hasRawXY = (b.x ?? b.X) != null && (b.y ?? b.Y) != null;

        // For drag bubbles, build the full "there and back" travel path:
        // [A, ...outbound..., B, ...outbound reversed..., A]. The map only
        // supplies the outbound leg (A -> B); we mirror it automatically.
        // The bubble's own anchor (x, y) is ALWAYS taken from the path's
        // first point when a path exists - never guessed independently -
        // so the drawn circle and the guide line can never disagree, and a
        // missing/zeroed top-level X/Y (e.g. a C# default of 0) can't pull
        // the visible bubble away from where its path actually starts.
        let fullPath = null;
        let outboundPath = null;
        let x, y;
        if (type === "drag" && rawPath && rawPath.length) {
            outboundPath = rawPath.map(p => ({ x: p.x ?? p.X ?? 0, y: p.y ?? p.Y ?? 0 }));
            x = outboundPath[0].x;
            y = outboundPath[0].y;
            const returning = outboundPath.slice(0, -1).reverse();
            fullPath = outboundPath.concat(returning);
        } else {
            x = hasRawXY ? (b.x ?? b.X) : 50;
            y = hasRawXY ? (b.y ?? b.Y) : 50;
            if (type === "drag") {
                // drag bubble with no path at all - degenerate but shouldn't crash
                outboundPath = [{ x, y }, { x, y }];
                fullPath = outboundPath;
            }
        }
    }

    function currentTimeMs() {
        if (audioEl && !audioEl.paused) {
            return audioEl.currentTime * 1000;
        }
        if (startTimestamp === null) return 0;
        return performance.now() - startTimestamp;
    }

    // Converts the fixed 5px "gap between circle edges" tolerance into a time
    // window, based on how fast notes are currently scrolling (px per ms).
    // Notes and the receptor are both circles of radius NOTE_RADIUS, so the
    // allowed center-to-center distance is (2 * NOTE_RADIUS) + tolerance.
    function currentHitWindowMs() {
        const hitLineY = canvas.clientHeight - RECEPTOR_HEIGHT;
        const travelHeight = hitLineY - HUD_HEIGHT; // notes now travel from below the header strip to the hit line
        const pxPerMs = travelHeight / travelMs;
        if (pxPerMs <= 0) return 0;
        return ((2 * NOTE_RADIUS) + HIT_TOLERANCE_PX) / pxPerMs;
    }

    // ---- "clickable segment" gating (osu!-style break behavior) ----
    // While `now` falls inside a segment's [start, end], the lane note-space
    // and hit line are fully hidden and lane input is disabled - that window
    // is reserved for the bubble-style hit objects instead. Outside segments
    // everything is fully visible/active, with a short crossfade at the edges.
    function isInsideSegment(now) {
        return segments.some(s => now >= s.start && now <= s.end);
    }
            }

    // ---- sizing ----
    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(rect.width * dpr));
        canvas.height = Math.max(1, Math.floor(rect.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ---- input handling: lane notes (A/S/D) ----
    function onKeyDown(e) {
        const key = e.key.toLowerCase();
        if (!(key in LANE_KEYS)) return;
        if (isInsideSegment(currentTimeMs())) return; // lanes are disabled during clickable segments
        const lane = LANE_KEYS[key];
        tryHitLane(lane);
    }
    function onKeyUp(e) {
        const key = e.key.toLowerCase();
        if (!(key in LANE_KEYS)) return;
        if (isInsideSegment(currentTimeMs())) return;
        const lane = LANE_KEYS[key];
        tryReleaseHold(lane);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    function tryHitLane(lane) {
        flashLane(lane);
        spawnGhost(lane);
        const now = currentTimeMs();
        const windowMs = currentHitWindowMs();
        const candidate = notes
            .filter(n => n.lane === lane && !n.hit && Math.abs(n.time - now) <= windowMs)
            .sort((a, b) => Math.abs(a.time - now) - Math.abs(b.time - now))[0];

        if (!candidate) {
            // "ghost tap" - no note in range, so this is just an empty press.
            // Show the ripple (already spawned above) but don't penalize the player.
            return;
        }

        candidate.hit = true;
        if (candidate.type === "hold") {
            candidate.holdActive = true;
        }
    }

    function tryReleaseHold(lane) {
        const active = notes.find(n => n.lane === lane && n.holdActive && !n.holdReleased);
        if (!active) return;
        const now = currentTimeMs();
        const holdEnd = active.time + (active.holdMs ?? 0);
        active.holdReleased = true;
        active.holdActive = false;
        if (Math.abs(now - holdEnd) <= currentHitWindowMs()) {
            registerHit(Math.abs(now - holdEnd));
        } else {
            registerMiss();
        }

    // ---- input handling: bubbles (tap / spin / drag) ----
    function canvasPointFromEvent(e) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: ((e.clientX - rect.left) / rect.width) * 100,
            y: ((e.clientY - rect.top) / rect.height) * 100,
        };
    }

    function distance(ax, ay, bx, by) {
        return Math.hypot(ax - bx, ay - by);
    }

    // Percentage-space point -> canvas pixel-space point.
    function toPx(p) {
        return {
            x: (p.x / 100) * canvas.clientWidth,
            y: (p.y / 100) * canvas.clientHeight,
        };
    }

    // Shortest distance (in px) from a pixel-space point to a polyline made
    // of percentage-space points. Used to enforce "don't stray off the line".
    function distanceToPolylinePx(px, py, percentPoints) {
        let best = Infinity;
        for (let i = 0; i < percentPoints.length - 1; i++) {
            const a = toPx(percentPoints[i]);
            const b = toPx(percentPoints[i + 1]);
            best = Math.min(best, distanceToSegmentPx(px, py, a, b));
        }
        return best;
    }

    function distanceToSegmentPx(px, py, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return distance(px, py, a.x, a.y);
        let t = ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const projX = a.x + t * dx;
        const projY = a.y + t * dy;
        return distance(px, py, projX, projY);
    }

    function onPointerDown(e) {
        // Stop the browser from turning this into a scroll/pan/swipe
        // gesture, which would otherwise swallow the pointermove events
        // that drag/spin bubbles depend on.
        e.preventDefault();

        const p = canvasPointFromEvent(e);
        const now = currentTimeMs();
        console.log(`[BogorocRhytm DEBUG] pointerdown at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}), now=${now.toFixed(0)}ms, pointerType=${e.pointerType}`);
        console.log(`[BogorocRhytm DEBUG] bubbles in time-window right now:`, bubbles.filter(b => !b.hit && now >= b.time && now <= b.time + b.duration).map(b => ({ type: b.type, x: b.x, y: b.y, time: b.time, duration: b.duration })));

        const candidate = bubbles
            .filter(b => !b.hit && now >= b.time && now <= b.time + b.duration)
            .filter(b => distance(p.x, p.y, b.x, b.y) < BUBBLE_HIT_PERCENT)
            .sort((a, b) => distance(p.x, p.y, a.x, a.y) - distance(p.x, p.y, b.x, b.y))[0];

        if (!candidate) {
            console.log("[BogorocRhytm DEBUG] no candidate found within hit radius");
            return;
        }
        console.log(`[BogorocRhytm DEBUG] candidate found: type=${candidate.type}, fullPath?.length=${candidate.fullPath?.length}`);

        if (candidate.type === "tap") {
            candidate.hit = true;
            registerHit(0);
        } else if (candidate.type === "spin") {
            candidate.progress = 0.01; // start tracking rotation progress
            activeDrag = { bubble: candidate, lastAngle: null, accumulated: 0, currentX: p.x, currentY: p.y };
            canvas.setPointerCapture(e.pointerId);
        } else if (candidate.type === "drag" && candidate.fullPath?.length > 1) {
            candidate.progress = 0;
            // pointIndex starts at 1, not 0: fullPath[0] is the point the
            // player just pressed down on, so it's already satisfied - the
            // first real target is fullPath[1].
            // currentX/currentY seed at the bubble's own anchor so it
            // doesn't jump before the first pointermove arrives.
            activeDrag = { bubble: candidate, pointIndex: 1, currentX: candidate.x, currentY: candidate.y };
            canvas.setPointerCapture(e.pointerId);
            console.log("[BogorocRhytm DEBUG] activeDrag set for drag bubble", activeDrag);
        } else {
            console.log(`[BogorocRhytm DEBUG] candidate type "${candidate.type}" did not match any branch (fullPath check may have failed)`);
        }
    }

    function onPointerMove(e) {
        if (!activeDrag) return;
        if (activeDrag.bubble.hit) {
            // Defensive: the bubble we were tracking already got resolved
            // elsewhere (e.g. timed out via sweepMissed while the pointer
            // was still down). Drop the stale capture instead of silently
            // swallowing input meant for whatever bubble comes next.
            console.log("[BogorocRhytm DEBUG] pointermove: activeDrag.bubble was already hit, clearing stale capture");
            activeDrag = null;
            return;
        }

        const p = canvasPointFromEvent(e);
        const { bubble } = activeDrag;

        if (bubble.type === "spin") {
            activeDrag.currentX = p.x;
            activeDrag.currentY = p.y;

            const angle = Math.atan2(p.y - bubble.y, p.x - bubble.x);
            if (activeDrag.lastAngle !== null) {
                let delta = angle - activeDrag.lastAngle;
                if (delta > Math.PI) delta -= 2 * Math.PI;
                if (delta < -Math.PI) delta += 2 * Math.PI;
                activeDrag.accumulated += Math.abs(delta);
            }
            activeDrag.lastAngle = angle;
            bubble.progress = Math.min(1, activeDrag.accumulated / (2 * Math.PI));
            if (bubble.progress >= 1 && !bubble.hit) {
                bubble.hit = true;
                registerHit(0);
                activeDrag = null;
            }
        } else if (bubble.type === "drag" && bubble.fullPath) {
            // Follow the pointer visually regardless of whether it's
            // currently on-target - this is what makes the yellow circle
            // track the mouse/finger instead of sitting pinned at anchor.
            activeDrag.currentX = p.x;
            activeDrag.currentY = p.y;

            // Enforce that the pointer stays on the guide line.
            const pxPoint = toPx(p);
            const devPx = distanceToPolylinePx(pxPoint.x, pxPoint.y, bubble.fullPath);
            console.log(`[BogorocRhytm DEBUG] drag move: p=(${p.x.toFixed(1)},${p.y.toFixed(1)}) devPx=${devPx.toFixed(1)} (max ${MAX_DRAG_DEVIATION_PX}) pointIndex=${activeDrag.pointIndex}`);
            if (devPx > MAX_DRAG_DEVIATION_PX) {
                console.log("[BogorocRhytm DEBUG] drag registered as MISS: deviated too far from guide line");
                bubble.hit = true; // resolved (as a miss), stop tracking/drawing it
                registerMiss();
                activeDrag = null;
                return;
            }

            const target = bubble.fullPath[activeDrag.pointIndex];
            if (target && distance(p.x, p.y, target.x, target.y) < 10) {
                activeDrag.pointIndex++;
                const totalSteps = bubble.fullPath.length - 1; // transitions, not points
                bubble.progress = Math.min(1, (activeDrag.pointIndex - 1) / totalSteps);
                console.log(`[BogorocRhytm DEBUG] drag waypoint reached, pointIndex now ${activeDrag.pointIndex}`);
                if (activeDrag.pointIndex >= bubble.fullPath.length && !bubble.hit) {
                    bubble.hit = true;
                    registerHit(0);
                    activeDrag = null;
                    console.log("[BogorocRhytm DEBUG] drag bubble completed successfully");
                }
            }
        }
    }

    function onPointerUp(e) {
        if (activeDrag && !activeDrag.bubble.hit) {
            registerMiss();
            activeDrag.bubble.hit = true;
        }
        activeDrag = null;
        if (e && e.pointerId != null && canvas.hasPointerCapture?.(e.pointerId)) {
            canvas.releasePointerCapture(e.pointerId);
        }
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    // ---- scoring ----
    let judgment = null; // { text, color, until }

    function popJudgment(text, color) {
        judgment = { text, color, until: performance.now() + 500 };
    }
    }

    function registerMiss() {
        combo = 0;
        comboBreaks++;
        popJudgment("COMBO BREAK", "#ff5d8f");
    }

    // ---- receptor key-press flash state (for the bottom key bar) ----
    const laneFlash = [0, 0, 0]; // performance.now() timestamp each lane was last pressed
    function flashLane(lane) {
        laneFlash[lane] = performance.now();
    }

    // ---- missed-note sweep (things that scrolled past without input) ----
    function sweepMissed(now) {
        const windowMs = currentHitWindowMs();
        for (const n of notes) {
            if (!n.hit && now - n.time > windowMs) {
                n.hit = true; // mark resolved so it stops being drawn/checked
                registerMiss();
            }
        }
        for (const b of bubbles) {
            if (!b.hit && now - (b.time + b.duration) > 0) {
                b.hit = true;
                registerMiss();
                if (activeDrag && activeDrag.bubble === b) {
                    // Free the pointer so a currently-held-down gesture
                    // doesn't keep "capturing" input meant for the next
                    // bubble (e.g. a drag bubble right after a missed spin).
                    activeDrag = null;
                }
            }
        }
    }

    // ---- rendering (osu!mania style: scrolling lanes + receptor bar) ----
    const NOTE_RADIUS = 32;
    const RECEPTOR_HEIGHT = 64;
    const ghosts = []; // { lane, start } - fading ripple rings spawned on tap

    function laneColor(lane) {
        return ["#ff5d8f", "#ffd447", "#5dc8ff"][lane % 3];
    }

    function spawnGhost(lane) {
        ghosts.push({ lane, start: performance.now() });
    }

    function drawLanes(now) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const laneWidth = w / LANES.length;
        const hitLineY = h - RECEPTOR_HEIGHT;
        const gridTop = HUD_HEIGHT; // grid starts below the reserved HUD strip, not at y=0
        const travelHeight = hitLineY - gridTop;

        // alternating dark column backgrounds (classic mania skin look)
        for (let i = 0; i < LANES.length; i++) {
            ctx.fillStyle = i % 2 === 0 ? "#15121f" : "#1b1730";
            ctx.fillRect(i * laneWidth, gridTop, laneWidth, h - gridTop);
        }
}