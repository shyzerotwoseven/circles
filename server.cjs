const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const env =require('dotenv').config();

const Nimiq = require('@nimiq/core');
const { KeyPair, ClientConfiguration, Client, Address, SerialBuffer, TransactionBuilder } = Nimiq;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000
});

// Serve static files from the same directory
app.use(express.static(path.join(__dirname)));
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// NIMIQ BACKEND
// ==========================================
let nimiqClient = null;
let serverKeyPair = null;
let serverAddress = null;

const serverHex = process.env.HEX;

async function initNimiq() {
    try {
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
// GAME CONSTANTS
// ==========================================
const MAP_SIZE = 2000;
const NIM_PER_FOOD = 0.001;
const ENTRY_FEE_LUNA = 100000n;

const PLAYER_RADIUS = 12;
const FOOD_RADIUS = 6;
const SPEED = 6;
const TICK_RATE = 50;

const EXIT_GATE = { x: MAP_SIZE / 2, y: MAP_SIZE / 2, radius: 40 };

// ==========================================
// GAME STATE
// ==========================================
let players = {};
let foods = [];

for (let i = 0; i < 100; i++) spawnFood();

function spawnFood() {
    foods.push({
        x: 30 + Math.random() * (MAP_SIZE - 60),
        y: 30 + Math.random() * (MAP_SIZE - 60),
        id: Math.random().toString(36).substring(2, 11)
    });
}

function verifyEntryFee(txHash) {
    return true; // Simplified for this implementation
}

function getPlayerCount() {
    return Object.keys(players).length;
}

function broadcastPlayerCount() {
    io.emit('playerCount', getPlayerCount());
}

// ==========================================
// SOCKET HANDLERS
// ==========================================
io.on('connection', (socket) => {
    console.log(`✅ Player connected: ${socket.id}`);
    broadcastPlayerCount();

    socket.on('joinGame', async (data) => {
        try {
            if (!data || typeof data !== 'object') {
                socket.emit('gameOver', { message: "Invalid join data.", playerId: socket.id });
                return;
            }

            if (!data.walletAddress || !data.txHash) {
                socket.emit('gameOver', { message: "Missing wallet address or transaction hash.", playerId: socket.id });
                return;
            }

            if (players[socket.id]) {
                console.log(`Player ${socket.id} already in game`);
                return;
            }

            const feeVerified = await verifyEntryFee(data.txHash);
            if (!feeVerified) {
                socket.emit('gameOver', { message: "Entry fee verification failed.", playerId: socket.id });
                return;
            }

            const padding = 100;
            const spawnX = padding + Math.random() * (MAP_SIZE - padding * 2);
            const spawnY = padding + Math.random() * (MAP_SIZE - padding * 2);

            players[socket.id] = {
                id: socket.id,
                walletAddress: data.walletAddress,
                x: spawnX,
                y: spawnY,
                angle: Math.random() * Math.PI * 2,
                speed: SPEED,
                history: [],
                segments: [],
                length: 8,
                balance: 0,
                alive: true,
                joinedAt: Date.now()
            };

            console.log(`🎮 Player ${socket.id} joined at (${spawnX.toFixed(0)}, ${spawnY.toFixed(0)})`);

            socket.emit('gameStarted', players[socket.id]);
            broadcastPlayerCount();
        } catch (err) {
            console.error(`Error in joinGame for ${socket.id}:`, err);
            socket.emit('gameOver', { message: "Server error joining game.", playerId: socket.id });
        }
    });

    socket.on('input', (data) => {
        try {
            const player = players[socket.id];
            if (!player || !player.alive) return;

            if (data && typeof data === 'object' && typeof data.angle === 'number') {
                if (isFinite(data.angle)) {
                    player.angle = data.angle;
                }
            } else if (typeof data === 'string') {
                switch(data) {
                    case 'UP': player.angle = -Math.PI / 2; break;
                    case 'DOWN': player.angle = Math.PI / 2; break;
                    case 'LEFT': player.angle = Math.PI; break;
                    case 'RIGHT': player.angle = 0; break;
                }
            }
        } catch (err) {
            console.error(`Error in input handler for ${socket.id}:`, err);
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`❌ Player disconnected: ${socket.id} (${reason})`);
        if (players[socket.id]) {
            delete players[socket.id];
        }
        broadcastPlayerCount();
    });

    socket.on('error', (err) => {
        console.error(`Socket error for ${socket.id}:`, err);
    });
});

// ==========================================
// MAIN GAME LOOP
// ==========================================
let lastTick = Date.now();

setInterval(() => {
    const now = Date.now();
    const dt = now - lastTick;
    lastTick = now;

    try {
        const playerList = Object.values(players);

        playerList.forEach(player => {
            if (!player.alive) return;

            // Save position to history
            player.history.unshift({ x: player.x, y: player.y });

            // Move head
            player.x += Math.cos(player.angle) * player.speed;
            player.y += Math.sin(player.angle) * player.speed;

            // Clamp to map (soft boundary)
            const margin = PLAYER_RADIUS;
            if (player.x < margin) player.x = margin;
            if (player.x > MAP_SIZE - margin) player.x = MAP_SIZE - margin;
            if (player.y < margin) player.y = margin;
            if (player.y > MAP_SIZE - margin) player.y = MAP_SIZE - margin;

            // Update segments
            const spacing = 3;
            const maxHistory = player.length * spacing;

            while (player.history.length > maxHistory) {
                player.history.pop();
            }

            player.segments = [];
            for (let i = 1; i <= player.length; i++) {
                const idx = Math.min(i * spacing, player.history.length - 1);
                if (player.history[idx]) {
                    player.segments.push(player.history[idx]);
                }
            }

            // Hard boundary kill
            if (player.x <= 0 || player.x >= MAP_SIZE || player.y <= 0 || player.y >= MAP_SIZE) {
                killPlayer(player.id, "You hit the boundary!");
                return;
            }

            // Food collision
            for (let i = foods.length - 1; i >= 0; i--) {
                const f = foods[i];
                const dist = Math.hypot(player.x - f.x, player.y - f.y);
                if (dist < PLAYER_RADIUS + FOOD_RADIUS) {
                    foods.splice(i, 1);
                    player.length += 2;
                    player.balance += NIM_PER_FOOD;
                    spawnFood();
                }
            }

            // Exit gate collision
            const distToGate = Math.hypot(player.x - EXIT_GATE.x, player.y - EXIT_GATE.y);
            if (distToGate < EXIT_GATE.radius + PLAYER_RADIUS) {
                cashoutPlayer(player.id);
                return;
            }
        });

        // PvP Collision
        playerList.forEach(player => {
            if (!player.alive) return;

            playerList.forEach(other => {
                if (other.id === player.id || !other.alive) return;

                if (other.segments && other.segments.length > 0) {
                    for (let segment of other.segments) {
                        const dist = Math.hypot(player.x - segment.x, player.y - segment.y);
                        if (dist < PLAYER_RADIUS * 1.3) {
                            other.balance += player.balance;
                            killPlayer(player.id, `Eliminated by Player ${other.id.slice(0, 4)}!`);
                            break;
                        }
                    }
                }
            });
        });

        // Send sanitized state
        const sanitizedPlayers = {};
        Object.values(players).forEach(p => {
            sanitizedPlayers[p.id] = {
                id: p.id,
                x: p.x,
                y: p.y,
                angle: p.angle,
                segments: p.segments,
                length: p.length,
                balance: p.balance
            };
        });

        io.emit('gameState', {
            players: sanitizedPlayers,
            foods: foods,
            exitGate: EXIT_GATE
        });

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
    console.log(`💀 Player ${id} died: ${message}`);

    io.to(id).emit('gameOver', { 
        message: message || "You died! Tokens lost.",
        playerId: id 
    });

    setTimeout(() => {
        delete players[id];
        broadcastPlayerCount();
    }, 1000);
}

async function cashoutPlayer(id) {
    const player = players[id];
    if (!player) return;

    // 1. Inform client immediately to show loading overlay
    io.to(id).emit('escaping');

    // 2. Freeze player logic
    player.alive = false; 
    console.log(`💰 Cashing out ${player.balance.toFixed(3)} NIM for ${player.walletAddress}`);

    if (nimiqClient && player.balance > 0) {
        try {
            const amountInLuna = BigInt(Math.floor(player.balance * 1e5));
            const recipientAddress = Address.fromUserFriendlyAddress(player.walletAddress);

            const headHeight = await nimiqClient.getHeadHeight();
            const networkId = await nimiqClient.getNetworkId();

            const tx = TransactionBuilder.newBasic(
                serverAddress,
                recipientAddress,
                amountInLuna,
                0n,
                headHeight,
                networkId
            );

            tx.sign(serverKeyPair);
            const details = await nimiqClient.sendTransaction(tx);

            console.log(`✅ Payout successful! TX: ${details.hash}`);
            io.to(id).emit('gameOver', { 
                message: `Escaped! ${player.balance.toFixed(3)} NIM sent to your wallet.`,
                playerId: id 
            });
        } catch (error) {
            console.error("❌ Payout failed:", error.message);
            io.to(id).emit('gameOver', { 
                message: `Escaped, but payout failed. Contact support.`,
                playerId: id 
            });
        }
    } else {
        io.to(id).emit('gameOver', { 
            message: `Escaped safely! (Balance: ${player.balance.toFixed(3)} NIM)`,
            playerId: id 
        });
    }

    setTimeout(() => {
        delete players[id];
        broadcastPlayerCount();
    }, 1000);
}

// ==========================================
// FOOD REGENERATION
// ==========================================
setInterval(() => {
    if (foods.length < 80) {
        spawnFood();
    }
}, 2000);

// ==========================================
// SERVER START
// ==========================================
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log('🚀 Nimiq Snake Arena');
    console.log(`📡 Server running on http://${HOST}:${PORT}`);
    console.log(`🗺️  Map size: ${MAP_SIZE}x${MAP_SIZE}`);
    console.log(`⚡ Tick rate: ${1000/TICK_RATE} TPS`);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});