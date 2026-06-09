import { init } from 'https://esm.sh/@nimiq/mini-app-sdk';
import HubApi from 'https://esm.sh/@nimiq/hub-api';

// ==========================================
// FORCE HIDE OLD HTML ELEMENTS & ADD BEAUTIFUL HUD STYLES
// ==========================================
const style = document.createElement('style');
style.innerHTML = `
    footer, .footer, #footer, [class*="footer"], [id*="footer"], 
    .joystick, #joystick, [class*="joystick"], [id*="joystick"],
    #joystickZone, #joystickBase, #joystickKnob,
    .snake-arena-branding, .branding, [class*="SnakeArena"] {
        display: none !important;
        opacity: 0 !important;
        pointer-events: none !important;
    }
    /* Style the top-left HUD container to look crisp, modern, and high-contrast */
    #ui {
        position: fixed;
        top: 20px;
        left: 20px;
        z-index: 40;
        background: rgba(15, 23, 42, 0.75) !important;
        backdrop-filter: blur(8px);
        padding: 12px 20px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }
    /* Force all child text inside the HUD to be white */
    #ui, #ui * {
        color: #ffffff !important;
        font-family: system-ui, -apple-system, sans-serif;
    }
    @keyframes spin { 
        to { transform: rotate(360deg); } 
    }
`;
document.head.appendChild(style);

// ==========================================
// ESCAPING UI OVERLAY
// ==========================================
const escapingOverlay = document.createElement('div');
escapingOverlay.innerHTML = `
    <div id="payoutModal" style="display: none; position: fixed; inset: 0; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(4px); z-index: 50; flex-direction: column; align-items: center; justify-content: center; color: white; font-family: sans-serif;">
        <div style="width: 50px; height: 50px; border: 5px solid #6366f1; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 20px;"></div>
        <h2 style="font-size: 24px; font-weight: bold; margin: 0;">Escaping...</h2>
        <p style="color: #cbd5e1; margin-top: 10px;">Processing blockchain payout. Do not close the window!</p>
    </div>
`;
document.body.appendChild(escapingOverlay);
const payoutModal = document.getElementById('payoutModal');

// ==========================================
// CONFIG & DOM CONFIGURATION WITH AUTOMATIC FALLBACKS
// ==========================================
const SERVER_WALLET = 'NQ78 MYM9 T9BM ESYK MV40 YTN2 VTR4 J0UC EDDS';
const MAP_SIZE = 2000;

const socket = io({
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    timeout: 10000
});

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const menu = document.getElementById('menu');
const ui = document.getElementById('ui');

// DEFENSIVE FIX: Automatically inject a gorgeous balance counter if your HTML layout lacks one
let balanceDisplay = document.getElementById('balance');
if (ui && !balanceDisplay) {
    ui.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; letter-spacing: 0.05em;">
            <span>EARNED:</span>
            <span id="balance" style="color: #818cf8 !important; font-size: 20px; font-family: monospace; font-weight: 700;">0.000</span>
            <span style="color: #94a3b8 !important; font-size: 12px;">NIM</span>
        </div>
    `;
    balanceDisplay = document.getElementById('balance');
}

const gameContainer = document.getElementById('gameContainer');
const payBtn = document.getElementById('payBtn');
const hubBtn = document.getElementById('hubBtn');
const statusText = document.querySelector('#status .status-text');
const statusSpinner = document.querySelector('#status .spinner');
const leaderboard = document.getElementById('leaderboard');
const lbContent = document.getElementById('lbContent');
const minimap = document.getElementById('minimap');
const minimapCanvas = document.getElementById('minimapCanvas');
const minimapCtx = minimapCanvas.getContext('2d');
const gameOverModal = document.getElementById('gameOverModal');
const modalIcon = document.getElementById('modalIcon');
const modalTitle = document.getElementById('modalTitle');
const modalMessage = document.getElementById('modalMessage');
const modalBalance = document.getElementById('modalBalance');
const modalLength = document.getElementById('modalLength');
const statPlayers = document.getElementById('statPlayers');
const bgCanvas = document.getElementById('bgCanvas');
const bgCtx = bgCanvas.getContext('2d');

// ==========================================
// STATE
// ==========================================
let myId = null;
let gameState = null;
let nimiq = null;
let playerAddress = null;
let isGameRunning = false;
let animationFrameId = null;
let particles = [];
let foodAnimations = new Map();
let lastBalance = 0;

// Visual properties & Client-side prediction
let cw = window.innerWidth; 
let ch = window.innerHeight;
let camera = { x: MAP_SIZE/2, y: MAP_SIZE/2, scale: 1 };
let lastEmitTime = 0;
let targetX = cw / 2;
let targetY = ch / 2;
let localAngle = 0;

// Smooth interpolation for jitter-free rendering
let interpolatedPlayers = {};

// Colors generator for bots/other players
function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return `hsl(${Math.abs(hash) % 360}, 80%, 60%)`;
}

// ==========================================
// BACKGROUND ANIMATION (Landing Page)
// ==========================================
let bgParticles = [];
function initBackground() {
    bgCanvas.width = window.innerWidth;
    bgCanvas.height = window.innerHeight;
    bgParticles = [];
    for (let i = 0; i < 80; i++) {
        bgParticles.push({
            x: Math.random() * bgCanvas.width,
            y: Math.random() * bgCanvas.height,
            vx: (Math.random() - 0.5) * 0.4,
            vy: (Math.random() - 0.5) * 0.4,
            radius: Math.random() * 2 + 0.5,
            alpha: Math.random() * 0.4 + 0.1,
            color: Math.random() > 0.5 ? '#6366f1' : '#a855f7',
            pulseSpeed: Math.random() * 0.02 + 0.5
        });
    }
}

function drawBackground() {
    bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
    const time = Date.now() * 0.001;

    bgParticles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = bgCanvas.width;
        if (p.x > bgCanvas.width) p.x = 0;
        if (p.y < 0) p.y = bgCanvas.height;
        if (p.y > bgCanvas.height) p.y = 0;

        const pulse = Math.sin(time * p.pulseSpeed * 10) * 0.3 + 0.7;
        bgCtx.beginPath();
        bgCtx.arc(p.x, p.y, p.radius * pulse, 0, Math.PI * 2);
        bgCtx.fillStyle = p.color;
        bgCtx.globalAlpha = p.alpha * pulse;
        bgCtx.fill();
    });
    bgCtx.globalAlpha = 1;
    requestAnimationFrame(drawBackground);
}

// ==========================================
// CANVAS RESIZING
// ==========================================
function resizeCanvas() {
    cw = window.innerWidth;
    ch = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (gameContainer && gameContainer.style.display !== 'none') {
        canvas.width = cw * dpr;
        canvas.height = ch * dpr;
        canvas.style.width = cw + 'px';
        canvas.style.height = ch + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if(minimapCanvas) {
            minimapCanvas.width = 120 * dpr;
            minimapCanvas.height = 120 * dpr;
            minimapCanvas.style.width = '120px';
            minimapCanvas.style.height = '120px';
            minimapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
    } else {
        initBackground();
    }
}

window.addEventListener('resize', resizeCanvas);

// ==========================================
// NIMIQ HUB & SDK SETUP
// ==========================================
async function setupMiniApp() {
    try {
        if(statusText) statusText.innerText = "Detecting environment...";
        if(statusSpinner) statusSpinner.style.display = 'inline-block';
        
        // Attempt Mobile App Initialization
        nimiq = await init();
        
        // Success: We are in the Mobile App
        if(payBtn) {
            payBtn.innerHTML = 'Play via Nimiq Pay (Mobile)';
            payBtn.disabled = false;
        }
        if(hubBtn) hubBtn.style.display = 'none'; // Hide Desktop Button
        
        if(statusText) statusText.innerText = "Nimiq Pay connected.";
        if(statusSpinner) statusSpinner.style.display = 'none';
    } catch (error) {
        console.log("SDK Init Error (Desktop detected):", error);
        
        // Fallback: We are on Desktop / Web Browser
        if(payBtn) payBtn.style.display = 'none'; // Hide Mobile Button
        
        if(hubBtn) {
            hubBtn.style.display = 'block'; // Show Desktop Button
            hubBtn.addEventListener('click', payWithHub);
        }
        
        if(statusText) statusText.innerText = "Ready to play via Desktop.";
        if(statusSpinner) statusSpinner.style.display = 'none';
    }
}

// Helper to re-enable UI on failure
function resetUIOnError(msg) {
    if(statusText) statusText.innerText = msg;
    if(statusSpinner) statusSpinner.style.display = 'none';
    if(hubBtn) {
        hubBtn.disabled = false;
        hubBtn.innerText = 'Play via Nimiq Hub (Desktop)';
    }
    if(payBtn) {
        payBtn.disabled = false;
        payBtn.innerText = 'Play via Nimiq Pay (Mobile)';
    }
    payoutModal.style.display = 'none';
}

async function payWithHub() {
    try {
        const hubUrl = 'https://hub.nimiq.com'; 
        const hubApi = new HubApi(hubUrl);
        
        let userAddress = localStorage.getItem('nimiq_address');
        if (!userAddress) {
            const account = await hubApi.chooseAddress({ appName: 'Cells.io' });
            userAddress = account.address;
            localStorage.setItem('nimiq_address', userAddress);
        }

        const txRequest = {
            appName: 'Cells.io',
            recipient: SERVER_WALLET,
            value: 100000, // 1 NIM
            fee: 0,
            sender: userAddress,
            extraData: new Uint8Array(new TextEncoder().encode(socket.id))
        };

        const txResult = await hubApi.checkout(txRequest);
        
        if(statusText) statusText.innerText = "Transaction confirmed. Deploying...";
        
        socket.emit('joinGame', { 
            txHash: txResult.hash || txResult.transactionHash || txResult, 
            walletAddress: userAddress 
        });

    } catch (e) {
        console.error(e);
        resetUIOnError("Transaction failed or cancelled.");
    }
}

if(payBtn) {
    payBtn.addEventListener('click', async () => {
        if (!socket.id) return resetUIOnError("Disconnected from server.");
        if (!nimiq) return;

        payBtn.disabled = true;
        if(statusText) statusText.innerText = "Awaiting signature...";
        if(statusSpinner) statusSpinner.style.display = 'inline-block';

        try {
            const accounts = await nimiq.listAccounts();
            if (accounts.length === 0) throw new Error("No accounts found");
            playerAddress = accounts[0];

            const txHash = await nimiq.sendBasicTransactionWithData({
                recipient: SERVER_WALLET,
                value: 100000,
                data: socket.id
            });

            if(statusText) statusText.innerText = "Transaction confirmed. Deploying...";
            socket.emit('joinGame', { txHash: txHash, walletAddress: playerAddress });
            
            setTimeout(() => {
                if (!isGameRunning && statusText.innerText.includes("Deploying")) {
                    statusText.innerText = "Network sync delayed. Please wait...";
                }
            }, 8000);

        } catch (e) {
            console.error("Transaction error:", e);
            resetUIOnError("Transaction failed or aborted.");
        }
    });
}

setupMiniApp();

// ==========================================
// SOCKET EVENTS
// ==========================================
socket.on('connect', () => console.log('Connected to server'));
socket.on('disconnect', () => {
    payoutModal.style.display = 'none';
    if (isGameRunning) showGameOver('Connection Lost', 'You were disconnected.', 0, 0, false);
});
socket.on('connect_error', () => resetUIOnError("Server connection failed. Retrying..."));

socket.on('error', (err) => resetUIOnError(err.message || err || "Game server error."));
socket.on('joinError', (err) => resetUIOnError(err.message || err || "Failed to join game."));

socket.on('gameStarted', (player) => {
    myId = player.id;
    isGameRunning = true;
    lastBalance = 0;
    payoutModal.style.display = 'none';

    if(menu) menu.style.display = 'none';
    if(gameContainer) gameContainer.style.display = 'block';
    if(ui) ui.style.display = 'flex';
    
    targetX = cw / 2;
    targetY = ch / 2;
    interpolatedPlayers = {};

    resizeCanvas();

    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    renderLoop();
});

socket.on('gameState', (state) => {
    gameState = state;

    if (gameState.players && gameState.players[myId]) {
        const newBalance = gameState.players[myId].balance;
        if (newBalance > lastBalance) {
            spawnParticles(gameState.players[myId].x, gameState.players[myId].y, '#6366f1', 6);
        }
        lastBalance = newBalance;
        if(balanceDisplay) balanceDisplay.innerText = newBalance.toFixed(3);
    }

    updateLeaderboard();
    updatePlayerCount();
});

socket.on('playerCount', (count) => { if (statPlayers) statPlayers.innerText = count; });

// TRIGGER LOADING OVERLAY
socket.on('escaping', () => {
    payoutModal.style.display = 'flex';
    isGameRunning = false; 
});

socket.on('gameOver', (data) => {
    payoutModal.style.display = 'none';
    if (data.playerId === myId) {
        const player = gameState?.players?.[myId];
        const balance = player ? player.balance : 0;
        const length = player ? player.length : 0;
        const isSuccess = data.message.includes('Escaped') || data.message.includes('sent');
        showGameOver(isSuccess ? 'Escaped!' : 'Eliminated', data.message, balance, length, isSuccess);
    }
});

// ==========================================
// UNIFIED INPUT HANDLING (Mouse & Touch)
// ==========================================
window.addEventListener('mousemove', (e) => {
    if (isGameRunning) {
        targetX = e.clientX;
        targetY = e.clientY;
    }
});

window.addEventListener('touchstart', (e) => {
    if (isGameRunning) {
        targetX = e.touches[0].clientX;
        targetY = e.touches[0].clientY;
    }
}, { passive: false });

window.addEventListener('touchmove', (e) => {
    if (isGameRunning) {
        e.preventDefault(); 
        targetX = e.touches[0].clientX;
        targetY = e.touches[0].clientY;
    }
}, { passive: false });

// ==========================================
// UI & PARTICLES
// ==========================================
function updateLeaderboard() {
    if (!gameState || !gameState.players || !lbContent) return;
    const sorted = Object.values(gameState.players).sort((a, b) => b.balance - a.balance).slice(0, 5);
    lbContent.innerHTML = sorted.map((p, i) => {
        const isMe = p.id === myId;
        const name = isMe ? 'YOU' : `P-${p.id.slice(-4).toUpperCase()}`;
        return `
            <div class="flex justify-between items-center px-2 py-1 rounded ${isMe ? 'bg-indigo-600/50 text-white font-bold' : 'text-slate-300'}">
                <span class="truncate max-w-[100px]">${i+1}. ${name}</span>
                <span class="text-xs opacity-75">${p.balance.toFixed(2)}</span>
            </div>
        `;
    }).join('');
}

function updatePlayerCount() {
    if (!gameState || !gameState.players) return;
    if (statPlayers) statPlayers.innerText = Object.keys(gameState.players).length;
}

function showGameOver(title, message, balance, length, isSuccess) {
    isGameRunning = false;
    if(modalIcon) modalIcon.textContent = isSuccess ? '🎉' : '💀';
    if(modalTitle) modalTitle.textContent = title;
    if(modalMessage) modalMessage.textContent = message;
    if(modalBalance) modalBalance.textContent = balance.toFixed(3);
    if(modalLength) modalLength.textContent = length;
    if(gameOverModal) gameOverModal.classList.add('active');
}

function spawnParticles(x, y, color, count = 8) {
    for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 / count) * i + Math.random() * 0.5;
        const speed = 2 + Math.random() * 3;
        particles.push({
            x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
            life: 1, decay: 0.015 + Math.random() * 0.02, size: 2 + Math.random() * 3, color
        });
    }
}

function drawParticles(ctx) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy;
        p.life -= p.decay;
        p.vx *= 0.97; p.vy *= 0.97; p.size *= 0.98;

        if (p.life <= 0) { particles.splice(i, 1); continue; }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// ==========================================
// AGAR.IO RENDERING ENGINE
// ==========================================
function getPlayerRadius(player) {
    return Math.max(15, Math.sqrt((player.length || player.balance * 100 || 10)) * 5);
}

function drawGrid(ctx) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 2 / camera.scale;
    const gridSize = 50;
    
    const left = camera.x - (cw / 2) / camera.scale;
    const right = camera.x + (cw / 2) / camera.scale;
    const top = camera.y - (ch / 2) / camera.scale;
    const bottom = camera.y + (ch / 2) / camera.scale;

    const startX = Math.floor(left / gridSize) * gridSize;
    const startY = Math.floor(top / gridSize) * gridSize;

    ctx.beginPath();
    for (let x = startX; x < right; x += gridSize) { ctx.moveTo(x, top); ctx.lineTo(x, bottom); }
    for (let y = startY; y < bottom; y += gridSize) { ctx.moveTo(left, y); ctx.lineTo(right, y); }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
    ctx.lineWidth = 10 / camera.scale;
    ctx.strokeRect(0, 0, MAP_SIZE, MAP_SIZE);
    ctx.restore();
}

function drawExitGate(ctx, gx, gy, gr) {
    const time = Date.now() / 300;
    const pulse = Math.abs(Math.sin(time)) * 12;

    ctx.save();
    for (let i = 3; i >= 1; i--) {
        ctx.beginPath();
        ctx.arc(gx, gy, gr + pulse + i * 15, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0, 230, 255, ${0.06 / i})`;
        ctx.fill();
    }
    
    ctx.beginPath();
    ctx.arc(gx, gy, gr, 0, Math.PI * 2);
    ctx.fillStyle = '#020617';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 230, 255, 0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.translate(gx, gy);
    ctx.rotate(time * 0.5);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        const r = gr * 0.6;
        if (i === 0) ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
        else ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0, 230, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
}

function drawFood(ctx, food, time) {
    if (!foodAnimations.has(food.id)) foodAnimations.set(food.id, Math.random() * Math.PI * 2);
    const phase = foodAnimations.get(food.id);
    const pulse = Math.sin(time * 0.005 + phase) * 0.2 + 0.8;
    
    const hash = Math.floor(food.x * 13 + food.y * 31);
    const hue = hash % 360;

    ctx.beginPath();
    ctx.arc(food.x, food.y, 6 * pulse, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${hue}, 90%, 60%)`;
    ctx.fill();
}

function drawCell(ctx, player, isMe) {
    const r = getPlayerRadius(player);
    const color = isMe ? '#6366f1' : stringToColor(player.id);
    
    if (isMe) {
        ctx.save();
        ctx.translate(player.x, player.y);
        ctx.rotate(localAngle);
        ctx.beginPath();
        const arrowOffset = r + 8;
        ctx.moveTo(arrowOffset, 0);
        ctx.lineTo(arrowOffset - 8, -6);
        ctx.lineTo(arrowOffset - 8, 6);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fill();
        ctx.restore();
    }
    
    ctx.beginPath();
    ctx.arc(player.x, player.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    
    const grad = ctx.createRadialGradient(
        player.x - r*0.3, player.y - r*0.3, r*0.1,
        player.x, player.y, r
    );
    grad.addColorStop(0, 'rgba(255,255,255,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0.2)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.lineWidth = Math.max(2, r * 0.05);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.stroke();

    if (r * camera.scale > 15) {
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 3;
        const fontSize = Math.max(10, r * 0.25);
        ctx.font = `bold ${fontSize}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        const name = isMe ? 'YOU' : `P-${player.id.slice(-4).toUpperCase()}`;
        ctx.strokeText(name, player.x, player.y - fontSize*0.4);
        ctx.fillText(name, player.x, player.y - fontSize*0.4);

        const visualMass = Math.floor(player.length || player.balance * 100 || 10);
        
        ctx.font = `bold ${fontSize*0.6}px Space Mono, monospace`;
        const massText = `Mass: ${visualMass}`;
        ctx.strokeText(massText, player.x, player.y + fontSize*0.8);
        ctx.fillText(massText, player.x, player.y + fontSize*0.8);
    }
}

function drawMinimap() {
    if (!interpolatedPlayers[myId] || !minimapCtx) return;
    const scale = 120 / MAP_SIZE;
    minimapCtx.clearRect(0, 0, 120, 120);

    if(gameState.exitGate) {
        minimapCtx.beginPath();
        minimapCtx.arc(gameState.exitGate.x * scale, gameState.exitGate.y * scale, Math.max(gameState.exitGate.radius * scale, 4), 0, Math.PI * 2);
        minimapCtx.fillStyle = 'rgba(0, 230, 255, 0.6)';
        minimapCtx.fill();
    }

    Object.values(interpolatedPlayers).forEach(p => {
        const isMe = p.id === myId;
        minimapCtx.beginPath();
        minimapCtx.arc(p.x * scale, p.y * scale, isMe ? 3.5 : 2.5, 0, Math.PI * 2);
        minimapCtx.fillStyle = isMe ? '#fff' : stringToColor(p.id);
        minimapCtx.fill();
    });

    minimapCtx.strokeStyle = 'rgba(255,255,255,0.4)';
    minimapCtx.lineWidth = 1;
    const viewW = (cw / camera.scale) * scale;
    const viewH = (ch / camera.scale) * scale;
    minimapCtx.strokeRect((camera.x * scale) - viewW/2, (camera.y * scale) - viewH/2, viewW, viewH);
}

function renderLoop() {
    if (!isGameRunning) return;

    if (gameState && gameState.players) {
        for (let id in gameState.players) {
            let serverP = gameState.players[id];
            if (!interpolatedPlayers[id]) {
                interpolatedPlayers[id] = { ...serverP };
            } else {
                interpolatedPlayers[id].x += (serverP.x - interpolatedPlayers[id].x) * 0.15;
                interpolatedPlayers[id].y += (serverP.y - interpolatedPlayers[id].y) * 0.15;
                interpolatedPlayers[id].balance = serverP.balance;
                interpolatedPlayers[id].length = serverP.length;
            }
        }
        for (let id in interpolatedPlayers) {
            if (!gameState.players[id]) delete interpolatedPlayers[id];
        }
    }

    const me = interpolatedPlayers[myId];
    if (me) {
        const screenPlayerX = cw / 2 + (me.x - camera.x) * camera.scale;
        const screenPlayerY = ch / 2 + (me.y - camera.y) * camera.scale;
        const dx = targetX - screenPlayerX;
        const dy = targetY - screenPlayerY;
        localAngle = Math.atan2(dy, dx);

        const now = Date.now();
        if (now - lastEmitTime > 33) {
            lastEmitTime = now;
            socket.emit('input', { angle: localAngle });
        }

        camera.x += (me.x - camera.x) * 0.1;
        camera.y += (me.y - camera.y) * 0.1;
        const targetScale = Math.max(0.15, 40 / getPlayerRadius(me));
        camera.scale += (targetScale - camera.scale) * 0.05;
    }

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-camera.x, -camera.y);

    drawGrid(ctx);

    if (gameState && gameState.exitGate) {
        drawExitGate(ctx, gameState.exitGate.x, gameState.exitGate.y, gameState.exitGate.radius);
    }

    const time = Date.now();
    if (gameState && gameState.foods) gameState.foods.forEach(f => drawFood(ctx, f, time));

    const sortedPlayers = Object.values(interpolatedPlayers).sort((a, b) => (a.balance || 0) - (b.balance || 0));
    sortedPlayers.forEach(p => drawCell(ctx, p, p.id === myId));

    drawParticles(ctx);
    ctx.restore();
    
    drawMinimap();
    
    animationFrameId = requestAnimationFrame(renderLoop);
}

initBackground();
drawBackground();
resizeCanvas();