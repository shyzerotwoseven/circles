const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const env = require('dotenv').config();
const mysql = require('mysql2/promise');

const Nimiq = require('@nimiq/core');
const { KeyPair, ClientConfiguration, Client, Address, SerialBuffer, TransactionBuilder } = Nimiq;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// DATABASE CONFIGURATION
// ==========================================
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        const connection = await pool.getConnection();
        await connection.query(`
            CREATE TABLE IF NOT EXISTS leaderboard (
                wallet_address VARCHAR(255) PRIMARY KEY,
                username VARCHAR(50) NOT NULL,
                earned DECIMAL(18, 4) DEFAULT 0.0000
            );
        `);
        console.log('✅ Database connected and leaderboard table verified.');
        connection.release();
    } catch (err) {
        console.error('❌ Database initialization failed:', err);
    }
}
initDB();

async function broadcastLeaderboard() {
    try {
        const [rows] = await pool.query('SELECT wallet_address, username, earned FROM leaderboard ORDER BY earned DESC LIMIT 10');
        io.emit('leaderboard_update', rows);
    } catch (err) {
        console.error('Error fetching leaderboard:', err);
    }
}

// ==========================================
// NIMIQ BACKEND
// ==========================================
let nimiqClient = null;
let serverKeyPair = null;
let serverAddress = null;

const serverHex = process.env.HEX || "";

async function initNimiq() {
    try {
        if (!serverHex) throw new Error("No HEX key provided in .env");
        const cleanHex = serverHex.trim();
        const buffer = Buffer.from(cleanHex, 'hex');
        serverKeyPair = KeyPair.deserialize(new SerialBuffer(buffer));
        serverAddress = serverKeyPair.toAddress();

        const config = new ClientConfiguration();
        config.network('mainalbatross');
        nimiqClient = await Client.create(config.build());

        console.log("🟢 Nimiq WASM loaded successfully.");
        console.log(`🟢 Server Address: ${serverAddress.toUserFriendlyAddress()}`);
    } catch (e) {
        console.error("🔴 Nimiq init failed:", e.message);
        console.log("⚠️  Running without payout functionality.");
    }
}
initNimiq();

// ==========================================
// GAME CONSTANTS & STATE
// ==========================================
const MAP_SIZE = 2000;
const NIM_PER_FOOD = 0.001;
const FOOD_RADIUS = 6;
const TICK_RATE = 30; 
const EXIT_GATE = { x: MAP_SIZE / 2, y: MAP_SIZE / 2, radius: 40 };

let players = {};
let foods = [];

function getPlayerHitbox(player) {
    return Math.max(15, Math.sqrt((player.length || player.balance * 100 || 10)) * 5);
}

// SAFE SPAWN LOGIC (Prevents instant death on spawn)
function getSafeSpawnPosition() {
    const padding = 100;
    for (let attempts = 0; attempts < 15; attempts++) {
        const x = padding + Math.random() * (MAP_SIZE - padding * 2);
        const y = padding + Math.random() * (MAP_SIZE - padding * 2);
        let safe = true;
        
        Object.values(players).forEach(p => {
            if (p.alive && Math.hypot(p.x - x, p.y - y) < 400) {
                safe = false;
            }
        });
        
        if (safe) return { x, y };
    }
    return { 
        x: padding + Math.random() * (MAP_SIZE - padding * 2), 
        y: padding + Math.random() * (MAP_SIZE - padding * 2) 
    };
}

for (let i = 0; i < 100; i++) spawnFood();

function spawnFood() {
    foods.push({
        x: 30 + Math.random() * (MAP_SIZE - 60),
        y: 30 + Math.random() * (MAP_SIZE - 60),
        id: Math.random().toString(36).substring(2, 11)
    });
}

function getRealPlayerCount() { 
    return Object.values(players).filter(p => !p.isBot).length; 
}
function broadcastPlayerCount() { io.emit('playerCount', getRealPlayerCount()); }

// ==========================================
// BOT MANAGEMENT
// ==========================================
const MAX_BOTS = 3;
const BOT_NAMES = ["ProSniper", "CryptoKing", "NimiqFan", "Shadow", "Ghost", "NoobSlayer", "Alpha", "Guest_928", "SnakeBoss"];

function spawnBot() {
    const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    const id = botName + '_' + Math.random().toString(36).substring(2, 6);
    const spawnPos = getSafeSpawnPosition();
    
    players[id] = {
        id: id,
        walletAddress: 'BOT_WALLET',
        x: spawnPos.x,
        y: spawnPos.y,
        angle: Math.random() * Math.PI * 2,
        speed: 8,
        history: [],
        segments: [],
        length: 12,
        balance: 0,
        alive: true,
        isBot: true,
        displayName: botName,
        lastBoost: 0,
        boostEndTime: 0
    };
    console.log(`🤖 Bot activated: ${id}`);
}

setInterval(() => {
    const realCount = getRealPlayerCount();
    const activeBots = Object.values(players).filter(p => p.isBot);

    if (realCount > 0 && realCount < 5) {
        if (activeBots.length < MAX_BOTS) spawnBot();
    } else {
        activeBots.forEach(bot => { delete players[bot.id]; });
    }
}, 2000);

// ==========================================
// SOCKET HANDLERS
// ==========================================
io.on('connection', (socket) => {
    console.log(`✅ Player connected: ${socket.id}`);
    broadcastPlayerCount();
    broadcastLeaderboard();

    socket.on('check_user', async (walletAddress) => {
        try {
            const [rows] = await pool.query('SELECT username FROM leaderboard WHERE wallet_address = ?', [walletAddress]);
            if (rows.length > 0) socket.emit('user_status', { exists: true, username: rows[0].username });
            else socket.emit('user_status', { exists: false });
        } catch (err) { console.error('Error checking user:', err); }
    });

    socket.on('register_user', async (data) => {
        try {
            await pool.query(
                'INSERT INTO leaderboard (wallet_address, username, earned) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE username = ?', 
                [data.wallet_address, data.username, data.username]
            );
            console.log(`📝 Registered user: ${data.username}`);
            broadcastLeaderboard(); 
        } catch (err) { console.error('Error registering user:', err); }
    });

    socket.on('joinGame', async (data) => {
        try {
            if (!data || !data.walletAddress || players[socket.id]) return;

            const spawnPos = getSafeSpawnPosition();

            players[socket.id] = {
                id: socket.id,
                walletAddress: data.walletAddress,
                x: spawnPos.x,
                y: spawnPos.y,
                angle: Math.random() * Math.PI * 2,
                speed: 8,
                history: [],
                segments: [],
                length: 8,
                balance: 0,
                alive: true,
                isBot: false,
                displayName: "Player",
                lastBoost: 0,
                boostEndTime: 0
            };

            console.log(`🎮 Player ${socket.id} joined at (${spawnPos.x.toFixed(0)}, ${spawnPos.y.toFixed(0)})`);
            socket.emit('gameStarted', players[socket.id]);
            broadcastPlayerCount();
        } catch (err) { console.error(`Error in joinGame:`, err); }
    });

    socket.on('input', (data) => {
        const player = players[socket.id];
        if (!player || !player.alive || player.isBot) return;
        if (data && typeof data.angle === 'number' && isFinite(data.angle)) {
            player.angle = data.angle;
        }
    });

    // BOOST LISTENER
    socket.on('boost', () => {
        const player = players[socket.id];
        const now = Date.now();
        if (player && player.alive && !player.isBot) {
            if (!player.lastBoost || now - player.lastBoost > 15000) {
                player.lastBoost = now;
                player.boostEndTime = now + 10000;
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ Player disconnected: ${socket.id}`);
        if (players[socket.id]) delete players[socket.id];
        broadcastPlayerCount();
    });
});

// ==========================================
// MAIN GAME LOOP
// ==========================================
setInterval(() => {
    try {
        const playerList = Object.values(players);

        playerList.forEach(player => {
            if (!player.alive) return;

            // --- BOT AI ---
            if (player.isBot) {
                const botHitbox = getPlayerHitbox(player);
                let targetAngle = player.angle;
                let nearestSmaller = null;
                let distSmaller = Infinity;
                let nearestLarger = null;
                let distLarger = Infinity;

                playerList.forEach(other => {
                    if (other.id !== player.id && other.alive) {
                        const dist = Math.hypot(player.x - other.x, player.y - other.y);
                        const otherHitbox = getPlayerHitbox(other);
                        if (botHitbox > otherHitbox) {
                            if (dist < distSmaller) { distSmaller = dist; nearestSmaller = other; }
                        } else {
                            if (dist < distLarger) { distLarger = dist; nearestLarger = other; }
                        }
                    }
                });

                if (nearestLarger && distLarger < 400) {
                    targetAngle = Math.atan2(player.y - nearestLarger.y, player.x - nearestLarger.x);
                } else if (nearestSmaller && distSmaller < 500) {
                    targetAngle = Math.atan2(nearestSmaller.y - player.y, nearestSmaller.x - player.x);
                } else {
                    let nearestFood = null;
                    let distFood = Infinity;
                    foods.forEach(f => {
                        const dist = Math.hypot(player.x - f.x, player.y - f.y);
                        if (dist < distFood) { distFood = dist; nearestFood = f; }
                    });

                    if (nearestFood) targetAngle = Math.atan2(nearestFood.y - player.y, nearestFood.x - player.x);
                    else targetAngle += (Math.random() - 0.5) * 0.5;
                }

                const wallMargin = 150;
                if (player.x < wallMargin) targetAngle = 0;
                else if (player.x > MAP_SIZE - wallMargin) targetAngle = Math.PI;
                if (player.y < wallMargin) targetAngle = Math.PI / 2;
                else if (player.y > MAP_SIZE - wallMargin) targetAngle = -Math.PI / 2;

                const angleDiff = targetAngle - player.angle;
                const normalizedDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
                player.angle += normalizedDiff * 0.15;
            }

            // --- MOVEMENT, BOOST & PHYSICS ---
            const currentRadius = getPlayerHitbox(player);
            let baseSpeed = Math.min(8, 2.5 + (currentRadius * 0.055));

            player.isBoosting = Date.now() < player.boostEndTime;
            if (player.isBoosting) baseSpeed *= 2;
            player.speed = baseSpeed;

            player.history.unshift({ x: player.x, y: player.y });
            player.x += Math.cos(player.angle) * player.speed;
            player.y += Math.sin(player.angle) * player.speed;

            const margin = currentRadius;
            if (player.x < margin) player.x = margin;
            if (player.x > MAP_SIZE - margin) player.x = MAP_SIZE - margin;
            if (player.y < margin) player.y = margin;
            if (player.y > MAP_SIZE - margin) player.y = MAP_SIZE - margin;

            const spacing = 3;
            const maxHistory = player.length * spacing;

            while (player.history.length > maxHistory) player.history.pop();

            player.segments = [];
            for (let i = 1; i <= player.length; i++) {
                const idx = Math.min(i * spacing, player.history.length - 1);
                if (player.history[idx]) player.segments.push(player.history[idx]);
            }

            if (player.x <= 0 || player.x >= MAP_SIZE || player.y <= 0 || player.y >= MAP_SIZE) {
                return killPlayer(player.id, "You hit the boundary!");
            }

            for (let i = foods.length - 1; i >= 0; i--) {
                const f = foods[i];
                const dist = Math.hypot(player.x - f.x, player.y - f.y);
                if (dist < currentRadius + FOOD_RADIUS) {
                    foods.splice(i, 1);
                    player.length += 6; 
                    player.balance += NIM_PER_FOOD;
                    spawnFood();
                }
            }

            const distToGate = Math.hypot(player.x - EXIT_GATE.x, player.y - EXIT_GATE.y);
            if (distToGate < EXIT_GATE.radius + currentRadius) {
                return cashoutPlayer(player.id);
            }
        });

        // --- COMBAT COLLISION ---
     // --- COMBAT COLLISION ---
       // --- COMBAT COLLISION ---
        playerList.forEach(player => {
            if (!player.alive) return;
            const playerRadius = getPlayerHitbox(player);

            playerList.forEach(other => {
                if (!player.alive) return; 
                if (other.id === player.id || !other.alive) return;
                
                const otherRadius = getPlayerHitbox(other);

                // CRITICAL FIX: We are now checking the distance between the two actual player centers.
                // No more invisible segments/tails!
                const dist = Math.hypot(player.x - other.x, player.y - other.y);
                
                // If the circles physically overlap significantly
                if (dist < (playerRadius + otherRadius) * 0.85) {
                    
                    if (player.length > other.length) {
                        // Player eats Other
                        player.balance += other.balance;
                        player.length += other.length;
                        other.balance = 0; 
                        other.length = 0;
                        const killerName = player.isBot ? player.displayName : `Player ${player.id.slice(0, 4)}`;
                        killPlayer(other.id, `Crushed by ${killerName}!`);
                        
                    } else if (other.length > player.length) {
                        // Other eats Player
                        other.balance += player.balance;
                        other.length += player.length;
                        player.balance = 0;
                        player.length = 0;
                        const killerName = other.isBot ? other.displayName : `Player ${other.id.slice(0, 4)}`;
                        killPlayer(player.id, `Eaten by ${killerName}!`);
                    }
                }
            });
        });

        const sanitizedPlayers = {};
        Object.values(players).forEach(p => {
            sanitizedPlayers[p.id] = {
                id: p.id, x: p.x, y: p.y, angle: p.angle,
                segments: p.segments, length: p.length, balance: p.balance,
                isBot: p.isBot, displayName: p.displayName,
                isBoosting: p.isBoosting 
            };
        });

        io.emit('gameState', { players: sanitizedPlayers, foods: foods, exitGate: EXIT_GATE });
    } catch (err) {
        console.error("Game loop error:", err);
    }
}, TICK_RATE);

// ==========================================
// PLAYER MANAGEMENT
// ==========================================
function killPlayer(id, message) {
    const player = players[id];
    if (!player) return;
    
    player.alive = false;
    
    if (!player.isBot) {
        io.to(id).emit('gameOver', { message: message || "You died! Tokens lost.", playerId: id });
    }
    
    setTimeout(() => { delete players[id]; broadcastPlayerCount(); }, 1000);
}

async function cashoutPlayer(id) {
    const player = players[id];
    if (!player) return;

    if (player.isBot) {
        player.alive = false;
        setTimeout(() => { delete players[id]; }, 1000);
        return; 
    }

    io.to(id).emit('escaping');
    player.alive = false; 
    console.log(`💰 Cashing out ${player.balance.toFixed(3)} NIM for ${player.walletAddress}`);

    if (player.balance > 0) {
        try {
            await pool.query('UPDATE leaderboard SET earned = earned + ? WHERE wallet_address = ?', [player.balance, player.walletAddress]);
            broadcastLeaderboard();
        } catch (err) { console.error('Failed to update DB on cashout:', err); }
    }

    if (nimiqClient && player.balance > 0) {
        try {
            const amountInLuna = BigInt(Math.floor(player.balance * 1e5));
            const recipientAddress = Address.fromUserFriendlyAddress(player.walletAddress);
            const headHeight = await nimiqClient.getHeadHeight();
            const networkId = await nimiqClient.getNetworkId();

            const tx = TransactionBuilder.newBasic(serverAddress, recipientAddress, amountInLuna, 0n, headHeight, networkId);
            tx.sign(serverKeyPair);
            await nimiqClient.sendTransaction(tx);

            io.to(id).emit('gameOver', { message: `Escaped! ${player.balance.toFixed(3)} NIM sent.`, playerId: id });
        } catch (error) {
            io.to(id).emit('gameOver', { message: `Escaped, but payout failed. Contact support.`, playerId: id });
        }
    } else {
        io.to(id).emit('gameOver', { message: `Escaped safely! (Balance: ${player.balance.toFixed(3)} NIM)`, playerId: id });
    }

    setTimeout(() => { delete players[id]; broadcastPlayerCount(); }, 1000);
}

setInterval(() => { if (foods.length < 80) spawnFood(); }, 2000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`📡 Server running on http://localhost:${PORT}`));