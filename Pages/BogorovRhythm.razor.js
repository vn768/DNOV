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

        return {
            type,
            time: b.time ?? b.Time ?? 0,
            duration: b.duration ?? b.Duration ?? 500,
            x,
            y,
            path: outboundPath,       // outbound-only, used for drawing the guide line
            fullPath,                 // outbound + return, used for hit tracking
            hit: false,
            progress: 0, // for spin/drag completion tracking
        };
    });
    const segments = (mapData?.segments ?? mapData?.Segments ?? []).map(s => ({
        start: s.start ?? s.Start ?? 0,
        end: s.end ?? s.End ?? 0,
    }));

    // ---- game state ----
    let score = 0;
    let combo = 0;
    let maxCombo = 0;
    let comboBreaks = 0;
    let startTimestamp = null;   // performance.now() when playback started
    let rafId = null;
    let finished = false;
    let disposed = false;

    // Pointer/drag tracking for "drag" bubbles.
    // currentX/currentY track the pointer's LIVE position in canvas-percent
    // space while a drag is active, so the yellow circle can follow the
    // mouse/finger instead of staying pinned to the bubble's anchor.
    let activeDrag = null; // { bubble, pointIndex | lastAngle/accumulated, currentX, currentY }

    // ---- audio ----
    const audioEl = resolveAudioElement(audioElementRef);

    function resolveAudioElement(ref) {
        // Blazor may pass an ElementReference wrapper or the element itself
        // depending on interop version; handle both.
        if (!ref) return null;
        if (ref instanceof HTMLMediaElement) return ref;
        if (ref.id) return document.getElementById(ref.id);
        return null;
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

    function segmentFadeAlpha(now) {
        for (const s of segments) {
            if (now >= s.start - SEGMENT_FADE_MS && now < s.start) {
                return 1 - (now - (s.start - SEGMENT_FADE_MS)) / SEGMENT_FADE_MS;
            }
            if (now >= s.start && now <= s.end) {
                return 0;
            }
            if (now > s.end && now <= s.end + SEGMENT_FADE_MS) {
                return (now - s.end) / SEGMENT_FADE_MS;
            }
        }
        return 1;
    }

    // ---- sizing ----
    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(rect.width * dpr));
        canvas.height = Math.max(1, Math.floor(rect.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();

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
        registerHit(Math.abs(candidate.time - now));
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

    function registerHit(offsetMs) {
        combo++;
        maxCombo = Math.max(maxCombo, combo);
        const perfect = offsetMs <= PERFECT_WINDOW_MS;
        const base = perfect ? 100 : 50;
        score += base + Math.floor(combo / 10) * 5; // small combo bonus
        popJudgment(perfect ? "PERFECT" : "GREAT", perfect ? "#5dc8ff" : "#ffd447");
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

        // thin column dividers
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        for (let i = 1; i < LANES.length; i++) {
            ctx.beginPath();
            ctx.moveTo(i * laneWidth, gridTop);
            ctx.lineTo(i * laneWidth, h);
            ctx.stroke();
        }

        // long-note bodies (drawn before circles so heads sit on top)
        for (const n of notes) {
            if (n.hit && !n.holdActive) continue;
            if (n.type !== "hold") continue;
            const progress = 1 - (n.time - now) / travelMs;
            if (progress < -0.15 || progress > 1.15) continue;

            const centerX = n.lane * laneWidth + laneWidth / 2;
            const headY = gridTop + progress * travelHeight;
            const color = laneColor(n.lane);
            const holdLenPx = ((n.holdMs ?? 0) / travelMs) * travelHeight;
            const tailY = headY - holdLenPx;
            const grad = ctx.createLinearGradient(0, tailY, 0, headY);
            grad.addColorStop(0, hexAlpha(color, 0.25));
            grad.addColorStop(1, hexAlpha(color, n.holdActive ? 0.85 : 0.5));
            ctx.fillStyle = grad;
            roundRect(centerX - laneWidth * 0.16, tailY, laneWidth * 0.32, holdLenPx, 8);
            ctx.fill();
        }

        // note circles, drawn on top of everything below the receptor bar
        for (const n of notes) {
            if (n.hit && !n.holdActive) continue;
            const progress = 1 - (n.time - now) / travelMs;
            if (progress < -0.15 || progress > 1.15) continue;

            const centerX = n.lane * laneWidth + laneWidth / 2;
            const y = gridTop + progress * travelHeight;
            drawNoteCircle(centerX, y, laneColor(n.lane), LANES[n.lane].toUpperCase(), n.holdActive);
        }

        // hit line (receptor line)
        ctx.save();
        ctx.shadowColor = "rgba(255,255,255,0.6)";
        ctx.shadowBlur = 8;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, hitLineY);
        ctx.lineTo(w, hitLineY);
        ctx.stroke();
        ctx.restore();

        drawReceptorBar(hitLineY, laneWidth, h);
        drawGhosts(hitLineY, laneWidth);
    }

    function drawNoteCircle(centerX, y, color, letter, glowing) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = glowing ? 20 : 12;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(centerX, y, NOTE_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // subtle rim highlight, like mania note skins
        ctx.strokeStyle = "rgba(255,255,255,0.65)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(centerX, y, NOTE_RADIUS - 1, 0, Math.PI * 2);
        ctx.stroke();

        // letter label on the note itself
        ctx.fillStyle = "#0d0b16";
        ctx.font = "bold 22px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(letter, centerX, y + 1);
    }

    function drawGhosts(hitLineY, laneWidth) {
        const now = performance.now();
        for (let i = ghosts.length - 1; i >= 0; i--) {
            const g = ghosts[i];
            const age = now - g.start;
            const lifespan = 300;
            if (age > lifespan) {
                ghosts.splice(i, 1);
                continue;
            }
            const t = age / lifespan; // 0 -> 1
            const cx = g.lane * laneWidth + laneWidth / 2;
            const cy = hitLineY;
            const radius = NOTE_RADIUS + t * 26;
            ctx.save();
            ctx.globalAlpha = 1 - t;
            ctx.strokeStyle = laneColor(g.lane);
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }

    function drawReceptorBar(hitLineY, laneWidth, canvasHeight) {
        const now = performance.now();
        for (let i = 0; i < LANES.length; i++) {
            const x = i * laneWidth;
            const flashAge = now - laneFlash[i];
            const isFlashing = flashAge < 120;
            const color = laneColor(i);
            const cx = x + laneWidth / 2;
            const cy = hitLineY; // sits exactly where notes visually converge

            // "note space" - circular target zone, matching the note's own shape
            const spaceRadius = NOTE_RADIUS + 8;
            ctx.save();
            if (isFlashing) {
                ctx.shadowColor = color;
                ctx.shadowBlur = 20;
            }
            ctx.fillStyle = isFlashing ? hexAlpha(color, 0.35) : "rgba(255,255,255,0.05)";
            ctx.beginPath();
            ctx.arc(cx, cy, spaceRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = isFlashing ? color : "rgba(255,255,255,0.2)";
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();

            ctx.fillStyle = isFlashing ? "#0d0b16" : "rgba(255,255,255,0.7)";
            ctx.font = "bold 22px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(LANES[i].toUpperCase(), cx, cy + 1);
        }
    }

    function roundRect(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function hexAlpha(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    // Interpolates between two "#rrggbb" colors. Used for the spinner ring,
    // which starts SPINNER_START_COLOR and eases to SPINNER_DONE_COLOR
    // (i.e. "gets greener") as spin progress approaches 1.
    function lerpHexColor(hexA, hexB, t) {
        t = Math.max(0, Math.min(1, t));
        const ar = parseInt(hexA.slice(1, 3), 16), ag = parseInt(hexA.slice(3, 5), 16), ab = parseInt(hexA.slice(5, 7), 16);
        const br = parseInt(hexB.slice(1, 3), 16), bg = parseInt(hexB.slice(3, 5), 16), bb = parseInt(hexB.slice(5, 7), 16);
        const r = Math.round(ar + (br - ar) * t);
        const g = Math.round(ag + (bg - ag) * t);
        const b = Math.round(ab + (bb - ab) * t);
        return `rgb(${r},${g},${b})`;
    }

    // Draws an arrowhead at `tip`, pointing along the direction from `from`.
    function drawArrowhead(tip, from, size, color) {
        const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
        const spread = Math.PI / 7;
        ctx.save();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(tip.x - size * Math.cos(angle - spread), tip.y - size * Math.sin(angle - spread));
        ctx.lineTo(tip.x - size * Math.cos(angle + spread), tip.y - size * Math.sin(angle + spread));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    // Draws the osu!-style white drag guide: a line/curve through the
    // bubble's outbound path, with an arrowhead pointing toward wherever the
    // player currently needs to drag to (A->B on the way out, B->A on the
    // way back).
    function drawDragGuide(bubble) {
        if (!bubble.path || bubble.path.length < 2) return;
        const pxPoints = bubble.path.map(toPx);

        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 4;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.shadowColor = "rgba(255,255,255,0.5)";
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.moveTo(pxPoints[0].x, pxPoints[0].y);
        for (let i = 1; i < pxPoints.length; i++) {
            ctx.lineTo(pxPoints[i].x, pxPoints[i].y);
        }
        ctx.stroke();
        ctx.restore();

        // Figure out which direction the player currently needs to travel.
        // pointIndex starts at 1 (targeting the outbound leg); once it
        // reaches bubble.path.length, the outbound leg is done and the
        // player is on the return trip back to point A.
        const goingBack = activeDrag && activeDrag.bubble === bubble &&
            activeDrag.pointIndex >= bubble.path.length;

        const tip = goingBack ? pxPoints[0] : pxPoints[pxPoints.length - 1];
        const prev = goingBack ? pxPoints[1] : pxPoints[pxPoints.length - 2];
        if (tip && prev) {
            drawArrowhead(tip, prev, 14, "rgba(255,255,255,0.95)");
        }

        // Small pips marking the outbound waypoints, osu!-slider style.
        ctx.save();
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        for (const p of pxPoints) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function drawBubbleLabel(cx, cy, text, color) {
        ctx.save();
        ctx.font = BUBBLE_LABEL_FONT;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = color;
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = 4;
        ctx.fillText(text, cx, cy + BUBBLE_OUTER_RADIUS + 16);
        ctx.restore();
    }

    function drawBubbles(now) {
        for (const b of bubbles) {
            if (b.hit) continue;
            if (now < b.time - 300 || now > b.time + b.duration + 200) continue;

            if (b.type === "drag") {
                drawDragGuide(b);
            }

            // While this bubble is being actively dragged, draw it at the
            // pointer's live position instead of its fixed anchor, so the
            // yellow circle visually follows the mouse/finger. Every other
            // bubble (and a drag bubble that hasn't been grabbed yet) still
            // renders at its normal x/y.
            const isActiveDrag = b.type === "drag" && activeDrag && activeDrag.bubble === b;
            const bx = isActiveDrag ? activeDrag.currentX : b.x;
            const by = isActiveDrag ? activeDrag.currentY : b.y;

            const cx = (bx / 100) * canvas.clientWidth;
            const cy = (by / 100) * canvas.clientHeight;
            const lifeProgress = Math.min(1, Math.max(0, (now - b.time) / b.duration));

            ctx.save();
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(cx, cy, BUBBLE_OUTER_RADIUS, 0, Math.PI * 2);
            ctx.stroke();

            // shrinking ring shows time remaining
            ctx.beginPath();
            ctx.strokeStyle = "rgba(255,255,255,0.5)";
            ctx.arc(cx, cy, BUBBLE_OUTER_RADIUS, -Math.PI / 2, -Math.PI / 2 + (1 - lifeProgress) * Math.PI * 2);
            ctx.stroke();

            if (b.type === "spin") {
                // Ring turns from pink to green as spin progress approaches 1.
                const spinColor = lerpHexColor(SPINNER_START_COLOR, SPINNER_DONE_COLOR, b.progress ?? 0);
                ctx.save();
                ctx.strokeStyle = spinColor;
                ctx.lineWidth = 6;
                ctx.shadowColor = spinColor;
                ctx.shadowBlur = 12;
                ctx.beginPath();
                ctx.arc(cx, cy, BUBBLE_FILL_RADIUS + 6, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();

                ctx.fillStyle = spinColor;
                ctx.beginPath();
                ctx.arc(cx, cy, (BUBBLE_FILL_RADIUS + 6) * (b.progress ?? 0), 0, Math.PI * 2);
                ctx.fill();

                drawBubbleLabel(cx, cy, "SPIN", spinColor);
            } else if (b.type === "drag") {
                ctx.fillStyle = "#ffd447";
                ctx.shadowColor = "#ffd447";
                ctx.shadowBlur = 10;
                ctx.beginPath();
                ctx.arc(cx, cy, BUBBLE_FILL_RADIUS, 0, Math.PI * 2);
                ctx.fill();

                drawBubbleLabel(cx, cy, "DRAG", "#ffd447");
            } else {
                ctx.fillStyle = "#ff5d8f";
                ctx.shadowColor = "#ff5d8f";
                ctx.shadowBlur = 10;
                ctx.beginPath();
                ctx.arc(cx, cy, BUBBLE_FILL_RADIUS, 0, Math.PI * 2);
                ctx.fill();

                drawBubbleLabel(cx, cy, "TAP", "#ff5d8f");
            }
            ctx.restore();
        }
    }

    function drawHud() {
        const w = canvas.clientWidth;

        // Header strip background - fully separate from the lane grid below,
        // so the stats never sit on top of falling notes.
        ctx.save();
        ctx.fillStyle = "rgba(13,11,22,0.65)";
        ctx.fillRect(0, 0, w, HUD_HEIGHT);
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, HUD_HEIGHT);
        ctx.lineTo(w, HUD_HEIGHT);
        ctx.stroke();
        ctx.restore();

        // Score / Combo / Combo Break, stacked top-left within the strip.
        ctx.save();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 20px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(`Score: ${score}`, 16, 28);
        ctx.fillText(`Combo: ${combo}`, 16, 52);
        ctx.fillStyle = "rgba(255,93,143,0.9)";
        ctx.font = "bold 14px sans-serif";
        ctx.fillText(`Combo Break: ${comboBreaks}`, 16, 72);
        ctx.restore();

        // Judgment popup (PERFECT / GREAT / COMBO BREAK) - top-right of the
        // same strip, so it never overlaps the stats or the grid below.
        ctx.save();
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.font = "bold 22px sans-serif";
        if (judgment) {
            const remaining = judgment.until - performance.now();
            if (remaining <= 0) {
                judgment = null;
            } else {
                const t = remaining / 500; // 1 -> 0
                ctx.globalAlpha = Math.max(0, t);
                ctx.fillStyle = judgment.color;
                ctx.shadowColor = judgment.color;
                ctx.shadowBlur = 10;
                ctx.fillText(judgment.text, w - 16, HUD_HEIGHT / 2);
            }
        }
        ctx.restore();
    }

    // How "hot" (0-1) a stage-transition flash should be at time `now` for a
    // single transition instant `t` (a segment's start or end).
    function flashIntensityFor(now, t) {
        const dist = Math.abs(now - t);
        if (dist > STAGE_FLASH_WINDOW_MS) return 0;
        return 1 - dist / STAGE_FLASH_WINDOW_MS;
    }

    // Red pulsing bars on the left/right edges with a "!" - fired around
    // every segment start AND end, signalling that lane <-> bubble mode is
    // about to switch.
    function drawStageTransitionFlash(now) {
        let intensity = 0;
        for (const s of segments) {
            intensity = Math.max(intensity, flashIntensityFor(now, s.start), flashIntensityFor(now, s.end));
        }
        if (intensity <= 0.01) return;

        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const pulse = 0.6 + 0.4 * Math.sin(now / 90); // fast strobe
        const alpha = intensity * Math.max(0.3, pulse);
        const bw = STAGE_FLASH_BAR_WIDTH;

        ctx.save();
        ctx.globalAlpha = alpha;

        const leftGrad = ctx.createLinearGradient(0, 0, bw, 0);
        leftGrad.addColorStop(0, "rgba(255,25,55,0.95)");
        leftGrad.addColorStop(1, "rgba(255,25,55,0)");
        ctx.fillStyle = leftGrad;
        ctx.fillRect(0, 0, bw, h);

        const rightGrad = ctx.createLinearGradient(w, 0, w - bw, 0);
        rightGrad.addColorStop(0, "rgba(255,25,55,0.95)");
        rightGrad.addColorStop(1, "rgba(255,25,55,0)");
        ctx.fillStyle = rightGrad;
        ctx.fillRect(w - bw, 0, bw, h);

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 34px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(255,25,55,0.9)";
        ctx.shadowBlur = 14;
        ctx.fillText("!", bw / 2, h / 2);
        ctx.fillText("!", w - bw / 2, h / 2);
        ctx.restore();
    }

    function render() {
        if (disposed) return;
        const now = currentTimeMs();
        const segAlpha = segmentFadeAlpha(now);

        ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

        // Lane note-space + hit line fade out during clickable segments and
        // fade back in once the segment ends (osu!-style break behavior).
        if (segAlpha > 0.001) {
            ctx.save();
            ctx.globalAlpha = segAlpha;
            drawLanes(now);
            ctx.restore();
        }

        drawBubbles(now);

        // Score/Combo/Combo Break HUD fades with the same rhythm as the lane
        // grid, so it's out of the way while bubbles are the focus.
        if (segAlpha > 0.001) {
            ctx.save();
            ctx.globalAlpha = segAlpha;
            drawHud();
            ctx.restore();
        }

        drawStageTransitionFlash(now);
        sweepMissed(now);

        if (!finished && durationMs > 0 && now >= durationMs) {
            finish();
            return;
        }

        rafId = requestAnimationFrame(render);
    }

    function finish() {
        if (finished) return;
        finished = true;
        if (dotNetRef) {
            dotNetRef.invokeMethodAsync("OnGameFinished", score, maxCombo)
                .catch(err => console.error("BogorocRhytm: failed to report finish", err));
        }
    }

    // ---- volume control ----
    // Wires a <input type="range"> to the audio element's volume. Called
    // automatically for the default slider id, and also exposed publicly so
    // C# can (re)bind it, e.g. if the slider is re-rendered.
    let volumeBound = false;
    function wireVolumeSlider(sliderId) {
        const slider = document.getElementById(sliderId);
        if (!slider) return;
        if (slider.dataset.bogorocBound === "1") return; // avoid double-binding
        slider.dataset.bogorocBound = "1";
        volumeBound = true;

        const applyVolume = () => {
            const vol = Math.max(0, Math.min(100, Number(slider.value))) / 100;
            if (audioEl) audioEl.volume = vol;
        };

        slider.addEventListener("input", applyVolume);
        slider.addEventListener("change", applyVolume);
        applyVolume(); // sync immediately to the slider's current value
    }

    // ---- playback start ----
    if (audioEl) {
        audioEl.currentTime = 0;
        audioEl.play().catch(err => {
            // Autoplay can be blocked until a user gesture; the "tap to play"
            // card the user already clicked usually counts as that gesture.
            console.warn("BogorocRhytm: audio play() was blocked", err);
        });
        audioEl.addEventListener("ended", finish);
    }
    // Auto-bind the default volume slider so it works even if the C# side
    // never calls bindVolumeSlider explicitly.
    wireVolumeSlider(DEFAULT_VOLUME_SLIDER_ID);

    startTimestamp = performance.now();
    rafId = requestAnimationFrame(render);

    // ---- public interface returned to C# --
    return {
        bindVolumeSlider(sliderId) {
            wireVolumeSlider(sliderId || DEFAULT_VOLUME_SLIDER_ID);
        },

        dispose() {
            disposed = true;
            if (rafId) cancelAnimationFrame(rafId);
            window.removeEventListener("resize", resizeCanvas);
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("keyup", onKeyUp);
            canvas.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            if (audioEl) {
                audioEl.removeEventListener("ended", finish);
                audioEl.pause();
            }
        },
    };
}