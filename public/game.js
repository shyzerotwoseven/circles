import { init } from 'https://esm.sh/@nimiq/mini-app-sdk';
import HubApi from 'https://esm.sh/@nimiq/hub-api';

const MAP_SIZE = 2000;

const socket = io({
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    timeout: 10000
});

// DOM Elements
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const menu = document.getElementById('menu');
const ui = document.getElementById('ui');
const balanceDisplay = document.getElementById('balance');
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

const payoutModal = document.getElementById('payoutModal');
const usernameModal = document.getElementById('usernameModal');
const usernameInput = document.getElementById('usernameInput');
const saveUsernameBtn = document.getElementById('saveUsernameBtn');

const bgCanvas = document.getElementById('bgCanvas');
const bgCtx = bgCanvas.getContext('2d');

// STATE
let myId = null;
let gameState = null;
let nimiq = null;
let currentWallet = null;
let currentUsername = null;
let isGameRunning = false;
let animationFrameId = null;
let particles = [];
let foodAnimations = new Map();
let lastBalance = 0;
let dbLeaderboard = []; 

let cw = window.innerWidth; 
let ch = window.innerHeight;
let camera = { x: MAP_SIZE/2, y: MAP_SIZE/2, scale: 1 };
let lastEmitTime = 0;
let targetX = cw / 2;
let targetY = ch / 2;
let localAngle = 0;
let interpolatedPlayers = {};

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return `hsl(${Math.abs(hash) % 360}, 80%, 60%)`;
}

// BACKGROUND
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
        p.x += p.vx; p.y += p.vy;
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

// CANVAS RESIZE
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

// NIMIQ SDK
async function setupMiniApp() {
    try {
        if(statusText) statusText.innerText = "Detecting environment...";
        if(statusSpinner) statusSpinner.style.display = 'inline-block';
        
        nimiq = await init();
        
        if(payBtn) {
            payBtn.innerHTML = 'Join Free via Nimiq Pay';
            payBtn.disabled = false;
        }
        if(hubBtn) hubBtn.style.display = 'none'; 
        
        if(statusText) statusText.innerText = "Nimiq connected.";
        if(statusSpinner) statusSpinner.style.display = 'none';
    } catch (error) {
        if(payBtn) payBtn.style.display = 'none'; 
        if(hubBtn) {
            hubBtn.style.display = 'block'; 
            hubBtn.addEventListener('click', payWithHub);
        }
        if(statusText) statusText.innerText = "Ready to play on Desktop.";
        if(statusSpinner) statusSpinner.style.display = 'none';
    }
}

function resetUIOnError(msg) {
    if(statusText) statusText.innerText = msg;
    if(statusSpinner) statusSpinner.style.display = 'none';
    if(hubBtn) { hubBtn.disabled = false; hubBtn.innerText = 'Join Free via Nimiq Hub'; }
    if(payBtn) { payBtn.disabled = false; payBtn.innerText = 'Join Free via Nimiq Pay'; }
    payoutModal.style.display = 'none';
}

function executeGameJoin(address) {
    socket.emit('joinGame', { txHash: 'free_entry_' + Math.random().toString(36).substring(7), walletAddress: address });
    setTimeout(() => {
        if (!isGameRunning && statusText.innerText.includes("Deploying")) {
            statusText.innerText = "Network sync delayed. Please wait...";
        }
    }, 8000);
}

socket.on('user_status', (data) => {
    if (data.exists) {
        currentUsername = data.username;
        executeGameJoin(currentWallet);
    } else {
        usernameModal.classList.add('active');
        statusText.innerText = "Claiming username...";
        statusSpinner.style.display = 'none';
    }
});

saveUsernameBtn.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    if (username.length > 0 && currentWallet) {
        socket.emit('register_user', { wallet_address: currentWallet, username: username });
        currentUsername = username;
        usernameModal.classList.remove('active');
        
        if(statusText) statusText.innerText = "Deploying...";
        if(statusSpinner) statusSpinner.style.display = 'inline-block';
        executeGameJoin(currentWallet);
    }
});

async function payWithHub() {
    try {
        if (!socket.id) return resetUIOnError("Disconnected from server.");
        hubBtn.disabled = true;

        const hubUrl = 'https://hub.nimiq.com'; 
        const hubApi = new HubApi(hubUrl);
        
        let userAddress = localStorage.getItem('nimiq_address');
        if (!userAddress) {
            const account = await hubApi.chooseAddress({ appName: 'Cells.io' });
            userAddress = account.address;
            localStorage.setItem('nimiq_address', userAddress);
        }

        currentWallet = userAddress;
        socket.emit('check_user', currentWallet);

    } catch (e) { resetUIOnError("Login failed or cancelled."); }
}

if(payBtn) {
    payBtn.addEventListener('click', async () => {
        if (!socket.id) return resetUIOnError("Disconnected from server.");
        payBtn.disabled = true;
        if(statusText) statusText.innerText = "Authenticating...";
        if(statusSpinner) statusSpinner.style.display = 'inline-block';

        try {
            let address = null;
            if (nimiq) {
                const accounts = await nimiq.listAccounts();
                if (accounts.length > 0) address = accounts[0];
            }
            if (!address) throw new Error("Could not detect Nimiq wallet address.");

            currentWallet = address;
            socket.emit('check_user', currentWallet);
        } catch (e) { resetUIOnError("Failed to join."); }
    });
}

setupMiniApp();

// SOCKET EVENTS
socket.on('connect', () => console.log('Connected to server'));
socket.on('disconnect', () => {
    payoutModal.style.display = 'none';
    if (isGameRunning) showGameOver('Connection Lost', 'You were disconnected.', 0, 0, false);
});
socket.on('connect_error', () => resetUIOnError("Server connection failed. Retrying..."));
socket.on('error', (err) => resetUIOnError(err.message || err || "Game server error."));
socket.on('joinError', (err) => resetUIOnError(err.message || err || "Failed to join game."));

socket.on('leaderboard_update', (topPlayers) => {
    dbLeaderboard = topPlayers;
    renderLeaderboard();
});

socket.on('gameStarted', (player) => {
    myId = player.id;
    isGameRunning = true;
    lastBalance = 0;
    payoutModal.style.display = 'none';

    if(menu) menu.style.display = 'none';
    if(gameContainer) gameContainer.style.display = 'block';
    if(ui) ui.style.display = 'flex';
    if(minimap) minimap.style.display = 'block';
    
    // Ensure leaderboard moves into game container view mentally, though it remains absolute
    if(leaderboard) {
        gameContainer.appendChild(leaderboard);
        leaderboard.style.zIndex = '105';
    }

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
    updatePlayerCount();
});

socket.on('playerCount', (count) => { if (statPlayers) statPlayers.innerText = count; });

socket.on('escaping', () => { payoutModal.style.display = 'flex'; isGameRunning = false; });

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

// INPUT HANDLING
window.addEventListener('mousemove', (e) => { if (isGameRunning) { targetX = e.clientX; targetY = e.clientY; } });
window.addEventListener('touchstart', (e) => { if (isGameRunning) { targetX = e.touches[0].clientX; targetY = e.touches[0].clientY; } }, { passive: false });
window.addEventListener('touchmove', (e) => { if (isGameRunning) { e.preventDefault(); targetX = e.touches[0].clientX; targetY = e.touches[0].clientY; } }, { passive: false });

// UI & PARTICLES
function renderLeaderboard() {
    if (!lbContent) return;
    if (dbLeaderboard.length === 0) {
        lbContent.innerHTML = `<div style="font-size: 12px; color: #94a3b8; opacity: 0.75;">No entries yet</div>`;
        return;
    }
    lbContent.innerHTML = dbLeaderboard.map((p, i) => {
        const isMe = p.wallet_address === currentWallet;
        return `
            <div class="lb-entry ${isMe ? 'me' : ''}">
                <span class="lb-rank">${i+1}</span>
                <span class="lb-name">${p.username}</span>
                <span class="lb-score">${parseFloat(p.earned).toFixed(3)} NIM🟨</span>
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
        particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, decay: 0.015 + Math.random() * 0.02, size: 2 + Math.random() * 3, color });
    }
}

function drawParticles(ctx) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy; p.life -= p.decay;
        p.vx *= 0.97; p.vy *= 0.97; p.size *= 0.98;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color; ctx.globalAlpha = p.life; ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// RENDERING
function getPlayerRadius(player) { return Math.max(15, Math.sqrt((player.length || player.balance * 100 || 10)) * 5); }

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
    
    ctx.beginPath(); ctx.arc(player.x, player.y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    
    const grad = ctx.createRadialGradient(player.x - r*0.3, player.y - r*0.3, r*0.1, player.x, player.y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0.2)');
    ctx.fillStyle = grad; ctx.fill();

    ctx.lineWidth = Math.max(2, r * 0.05); ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.stroke();

    if (r * camera.scale > 15) {
        ctx.fillStyle = 'white'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
        const fontSize = Math.max(10, r * 0.25);
        ctx.font = `bold ${fontSize}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        
        const name = isMe ? (currentUsername || 'YOU') : `P-${player.id.slice(-4).toUpperCase()}`;
        ctx.strokeText(name, player.x, player.y - fontSize*0.4); ctx.fillText(name, player.x, player.y - fontSize*0.4);

        const visualMass = Math.floor(player.length || player.balance * 100 || 10);
        ctx.font = `bold ${fontSize*0.6}px Space Mono, monospace`;
        const massText = `Mass: ${visualMass}`;
        ctx.strokeText(massText, player.x, player.y + fontSize*0.8); ctx.fillText(massText, player.x, player.y + fontSize*0.8);
    }
}

function drawMinimap() {
    if (!interpolatedPlayers[myId] || !minimapCtx) return;
    const scale = 120 / MAP_SIZE;
    minimapCtx.clearRect(0, 0, 120, 120);

    if(gameState.exitGate) {
        minimapCtx.beginPath();
        minimapCtx.arc(gameState.exitGate.x * scale, gameState.exitGate.y * scale, Math.max(gameState.exitGate.radius * scale, 4), 0, Math.PI * 2);
        minimapCtx.fillStyle = 'rgba(0, 230, 255, 0.6)'; minimapCtx.fill();
    }

    Object.values(interpolatedPlayers).forEach(p => {
        const isMe = p.id === myId;
        minimapCtx.beginPath(); minimapCtx.arc(p.x * scale, p.y * scale, isMe ? 3.5 : 2.5, 0, Math.PI * 2);
        minimapCtx.fillStyle = isMe ? '#fff' : stringToColor(p.id); minimapCtx.fill();
    });

    minimapCtx.strokeStyle = 'rgba(255,255,255,0.4)'; minimapCtx.lineWidth = 1;
    const viewW = (cw / camera.scale) * scale;
    const viewH = (ch / camera.scale) * scale;
    minimapCtx.strokeRect((camera.x * scale) - viewW/2, (camera.y * scale) - viewH/2, viewW, viewH);
}

function renderLoop() {
    if (!isGameRunning) return;

    if (gameState && gameState.players) {
        for (let id in gameState.players) {
            let serverP = gameState.players[id];
            if (!interpolatedPlayers[id]) { interpolatedPlayers[id] = { ...serverP }; } 
            else {
                interpolatedPlayers[id].x += (serverP.x - interpolatedPlayers[id].x) * 0.3;
                interpolatedPlayers[id].y += (serverP.y - interpolatedPlayers[id].y) * 0.3;
                interpolatedPlayers[id].balance = serverP.balance;
                interpolatedPlayers[id].length = serverP.length;
            }
        }
        for (let id in interpolatedPlayers) { if (!gameState.players[id]) delete interpolatedPlayers[id]; }
    }

    const me = interpolatedPlayers[myId];
    if (me) {
        const screenPlayerX = cw / 2 + (me.x - camera.x) * camera.scale;
        const screenPlayerY = ch / 2 + (me.y - camera.y) * camera.scale;
        localAngle = Math.atan2(targetY - screenPlayerY, targetX - screenPlayerX);

        const now = Date.now();
        if (now - lastEmitTime > 15) { lastEmitTime = now; socket.emit('input', { angle: localAngle }); }

        camera.x += (me.x - camera.x) * 0.1;
        camera.y += (me.y - camera.y) * 0.1;
        const targetScale = Math.max(0.45, 55 / getPlayerRadius(me));
        camera.scale += (targetScale - camera.scale) * 0.05;
    }

    ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(cw / 2, ch / 2); ctx.scale(camera.scale, camera.scale); ctx.translate(-camera.x, -camera.y);

    drawGrid(ctx);
    if (gameState && gameState.exitGate) drawExitGate(ctx, gameState.exitGate.x, gameState.exitGate.y, gameState.exitGate.radius);
    
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