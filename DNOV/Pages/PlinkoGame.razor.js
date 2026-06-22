let canvas, ctx, balls, pegs, slots, dotnetRef, animFrameId;
const settings = { gravity: 0.35, ballSpeedMultiplier: 1.0, restitution: 0.5 };

// ---- Ball image ----
let ballImage = new Image();
ballImage.src = './images/pgit-logo.png';
// --------------------

export function init(canvasId, ref) {
    dotnetRef = ref;
    canvas = document.getElementById(canvasId);
    ctx = canvas.getContext("2d");
    balls = [];
    buildBoard();
    if (animFrameId) cancelAnimationFrame(animFrameId);
    gameLoop();
}

function buildBoard() {
    pegs = [];
    slots = [];
    const rows = 10, cols = 9;
    const spacingX = canvas.width / (cols + 1);
    const spacingY = (canvas.height - 100) / (rows + 1);

    for (let r = 0; r < rows; r++) {
        const count = (r % 2 === 0) ? cols : cols - 1;
        const offsetX = (r % 2 === 0) ? spacingX : spacingX * 1.5;
        for (let c = 0; c < count; c++) {
            pegs.push({ x: offsetX + c * spacingX, y: 60 + r * spacingY, r: 5 });
        }
    }

    const slotCount = 9;
    const slotW = canvas.width / slotCount;
    const multipliers = [5, 2, 1, 0.5, 3, 0.5, 1, 2, 5];
    for (let i = 0; i < slotCount; i++) {
        slots.push({
            x: i * slotW,
            y: canvas.height - 40,
            w: slotW,
            multiplier: multipliers[i]
        });
    }
}

export function dropBall(xOverride) {
    const x = (xOverride !== null && xOverride !== undefined)
        ? xOverride
        : canvas.width / 2 + (Math.random() - 0.5) * 20;
    balls.push({
        x, y: 20,
        vx: (Math.random() - 0.5) * 1.5,
        vy: 2 * settings.ballSpeedMultiplier,
        r: 12,
        landed: false
    });
}

export function updateSettings(s) {
    Object.assign(settings, s);
}

function gameLoop() {
    const W = canvas.width, H = canvas.height;

    // White background
    ctx.fillStyle = "#F5F5F5";
    ctx.fillRect(0, 0, W, H);

    // Draw slots
    const slotColors = ["#FFD700", "#FFA500", "#FF6347", "#90EE90", "#00CED1", "#90EE90", "#FF6347", "#FFA500", "#FFD700"];
    slots.forEach((s, i) => {
        ctx.fillStyle = slotColors[i];
        ctx.fillRect(s.x + 1, s.y, s.w - 2, 40);
        ctx.fillStyle = "#000";
        ctx.font = "bold 11px Arial";
        ctx.textAlign = "center";
        ctx.fillText(`${s.multiplier}x`, s.x + s.w / 2, s.y + 25);
    });

    // Draw pegs
    pegs.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = "#111111";
        ctx.fill();
    });

    // Update + draw balls
    balls = balls.filter(b => {
        if (b.landed) return false;

        b.vy += settings.gravity;
        b.vx *= 0.99;
        b.x += b.vx;
        b.y += b.vy;

        // Peg collisions
        pegs.forEach(p => {
            const dx = b.x - p.x, dy = b.y - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < b.r + p.r) {
                const nx = dx / dist, ny = dy / dist;
                const overlap = (b.r + p.r) - dist;
                b.x += nx * overlap;
                b.y += ny * overlap;
                const dot = b.vx * nx + b.vy * ny;
                b.vx -= 2 * dot * nx * settings.restitution;
                b.vy -= 2 * dot * ny * settings.restitution;
                b.vy = Math.abs(b.vy) * settings.ballSpeedMultiplier;
                b.vx += (Math.random() - 0.5) * 0.5;
            }
        });

        // Wall bounce
        if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); }
        if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx); }

        // Slot detection
        if (b.y + b.r >= slots[0].y) {
            const slot = slots.find(s => b.x >= s.x && b.x < s.x + s.w);
            if (slot) {
                b.landed = true;
                dotnetRef.invokeMethodAsync("OnBallLanded", slot.multiplier);
                return false;
            }
        }

        // Draw ball as image, fallback to circle
        if (ballImage.complete && ballImage.naturalWidth > 0) {
            const aspectRatio = ballImage.naturalWidth / ballImage.naturalHeight;
            const h = b.r * 2;
            const w = h * aspectRatio;
            ctx.drawImage(ballImage, b.x - w / 2, b.y - b.r, w, h);
        } else {
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
            ctx.fillStyle = "#f97316";
            ctx.fill();
        }

        return true;
    });

    animFrameId = requestAnimationFrame(gameLoop);
}

export function dispose() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
}