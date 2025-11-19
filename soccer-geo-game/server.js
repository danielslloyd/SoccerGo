const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Game storage
const games = new Map();

// Physics constants
const FRICTION = 0.98; // Speed decay per tick
const GRAVITY_STRENGTH = 0.00001; // Pull towards players when stopped
const KICK_THRESHOLD = 0.0001; // Distance in degrees (~11 meters)
const STOPPED_THRESHOLD = 0.000001; // Speed threshold to consider ball stopped

// Game update interval (ms)
const TICK_RATE = 50;

class Game {
    constructor(id, config) {
        this.id = id;
        this.field = config.field; // Array of 4 corner coordinates
        this.fieldCenter = this.calculateCenter();
        this.fieldBounds = this.calculateBounds();
        this.goals = this.calculateGoals();
        this.timeLimit = config.timeLimit || 10; // minutes
        this.ballSpeed = config.ballSpeed || 1.0; // multiplier
        this.kickPower = config.kickPower || 0.0005; // base kick power in degrees

        this.players = new Map();
        this.ball = {
            lat: this.fieldCenter.lat,
            lng: this.fieldCenter.lng,
            vLat: 0,
            vLng: 0
        };
        this.score = { team1: 0, team2: 0 };
        this.startTime = null;
        this.isRunning = false;
        this.interval = null;
    }

    calculateCenter() {
        const lats = this.field.map(p => p.lat);
        const lngs = this.field.map(p => p.lng);
        return {
            lat: (Math.min(...lats) + Math.max(...lats)) / 2,
            lng: (Math.min(...lngs) + Math.max(...lngs)) / 2
        };
    }

    calculateBounds() {
        // Calculate the field's local coordinate system
        // Using first edge as the "length" direction
        const p0 = this.field[0];
        const p1 = this.field[1];
        const p2 = this.field[2];
        const p3 = this.field[3];

        // Calculate edge lengths to determine which is longer
        const edge01 = Math.sqrt(Math.pow(p1.lat - p0.lat, 2) + Math.pow(p1.lng - p0.lng, 2));
        const edge12 = Math.sqrt(Math.pow(p2.lat - p1.lat, 2) + Math.pow(p2.lng - p1.lng, 2));

        let lengthDir, widthDir;
        if (edge01 >= edge12) {
            // p0-p1 is the length direction
            lengthDir = { lat: p1.lat - p0.lat, lng: p1.lng - p0.lng };
            widthDir = { lat: p2.lat - p1.lat, lng: p2.lng - p1.lng };
        } else {
            // p1-p2 is the length direction
            lengthDir = { lat: p2.lat - p1.lat, lng: p2.lng - p1.lng };
            widthDir = { lat: p1.lat - p0.lat, lng: p1.lng - p0.lng };
        }

        // Normalize directions
        const lengthMag = Math.sqrt(lengthDir.lat ** 2 + lengthDir.lng ** 2);
        const widthMag = Math.sqrt(widthDir.lat ** 2 + widthDir.lng ** 2);

        return {
            lengthDir: { lat: lengthDir.lat / lengthMag, lng: lengthDir.lng / lengthMag },
            widthDir: { lat: widthDir.lat / widthMag, lng: widthDir.lng / widthMag },
            length: lengthMag,
            width: widthMag,
            corners: this.field
        };
    }

    calculateGoals() {
        // Goals are at each narrow end (width side), taking 1/4 of the width, centered
        const bounds = this.fieldBounds;
        const goalWidth = bounds.width / 4;
        const center = this.fieldCenter;

        // Calculate goal positions at each end
        const halfLength = bounds.length / 2;

        // Goal 1 (team 1 defends, team 2 attacks)
        const goal1Center = {
            lat: center.lat - bounds.lengthDir.lat * halfLength,
            lng: center.lng - bounds.lengthDir.lng * halfLength
        };

        // Goal 2 (team 2 defends, team 1 attacks)
        const goal2Center = {
            lat: center.lat + bounds.lengthDir.lat * halfLength,
            lng: center.lng + bounds.lengthDir.lng * halfLength
        };

        return {
            goal1: {
                center: goal1Center,
                width: goalWidth,
                team: 2 // Team 2 scores here
            },
            goal2: {
                center: goal2Center,
                width: goalWidth,
                team: 1 // Team 1 scores here
            }
        };
    }

    addPlayer(playerId, name, socketId) {
        // Balance teams
        const team1Count = Array.from(this.players.values()).filter(p => p.team === 1).length;
        const team2Count = Array.from(this.players.values()).filter(p => p.team === 2).length;
        const team = team1Count <= team2Count ? 1 : 2;

        this.players.set(playerId, {
            id: playerId,
            name: name,
            socketId: socketId,
            team: team,
            lat: this.fieldCenter.lat,
            lng: this.fieldCenter.lng,
            lastUpdate: Date.now()
        });

        return team;
    }

    removePlayer(playerId) {
        this.players.delete(playerId);
    }

    updatePlayerPosition(playerId, lat, lng) {
        const player = this.players.get(playerId);
        if (player) {
            player.lat = lat;
            player.lng = lng;
            player.lastUpdate = Date.now();
        }
    }

    start() {
        if (this.isRunning) return;

        this.isRunning = true;
        this.startTime = Date.now();
        this.resetBall();

        this.interval = setInterval(() => this.tick(), TICK_RATE);
    }

    stop() {
        this.isRunning = false;
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    resetBall() {
        this.ball = {
            lat: this.fieldCenter.lat,
            lng: this.fieldCenter.lng,
            vLat: 0,
            vLng: 0
        };
    }

    tick() {
        if (!this.isRunning) return;

        // Check time limit
        const elapsed = (Date.now() - this.startTime) / 1000 / 60;
        if (elapsed >= this.timeLimit) {
            this.stop();
            io.to(this.id).emit('gameOver', { score: this.score });
            return;
        }

        // Update ball physics
        this.updateBall();

        // Check for goals
        this.checkGoals();

        // Broadcast game state
        this.broadcastState();
    }

    updateBall() {
        // Apply velocity
        this.ball.lat += this.ball.vLat;
        this.ball.lng += this.ball.vLng;

        // Apply friction
        this.ball.vLat *= FRICTION;
        this.ball.vLng *= FRICTION;

        // Check for bounces off field boundaries
        this.checkBounces();

        // Apply gravity towards players when ball is nearly stopped
        const speed = Math.sqrt(this.ball.vLat ** 2 + this.ball.vLng ** 2);
        if (speed < STOPPED_THRESHOLD && this.players.size > 0) {
            this.applyGravity();
        }
    }

    checkBounces() {
        // Project ball position onto field coordinate system
        const bounds = this.fieldBounds;
        const center = this.fieldCenter;

        // Vector from center to ball
        const toBall = {
            lat: this.ball.lat - center.lat,
            lng: this.ball.lng - center.lng
        };

        // Project onto length and width directions
        const lengthProj = toBall.lat * bounds.lengthDir.lat + toBall.lng * bounds.lengthDir.lng;
        const widthProj = toBall.lat * bounds.widthDir.lat + toBall.lng * bounds.widthDir.lng;

        // Check if outside bounds and bounce
        const halfLength = bounds.length / 2;
        const halfWidth = bounds.width / 2;

        let bounced = false;

        // Bounce off length ends (goals are here, but we handle that separately)
        if (Math.abs(lengthProj) > halfLength) {
            // Reflect velocity in length direction
            const vLength = this.ball.vLat * bounds.lengthDir.lat + this.ball.vLng * bounds.lengthDir.lng;
            this.ball.vLat -= 2 * vLength * bounds.lengthDir.lat;
            this.ball.vLng -= 2 * vLength * bounds.lengthDir.lng;

            // Push ball back inside
            const sign = lengthProj > 0 ? 1 : -1;
            const excess = Math.abs(lengthProj) - halfLength;
            this.ball.lat -= sign * excess * bounds.lengthDir.lat;
            this.ball.lng -= sign * excess * bounds.lengthDir.lng;
            bounced = true;
        }

        // Bounce off width sides
        if (Math.abs(widthProj) > halfWidth) {
            // Reflect velocity in width direction
            const vWidth = this.ball.vLat * bounds.widthDir.lat + this.ball.vLng * bounds.widthDir.lng;
            this.ball.vLat -= 2 * vWidth * bounds.widthDir.lat;
            this.ball.vLng -= 2 * vWidth * bounds.widthDir.lng;

            // Push ball back inside
            const sign = widthProj > 0 ? 1 : -1;
            const excess = Math.abs(widthProj) - halfWidth;
            this.ball.lat -= sign * excess * bounds.widthDir.lat;
            this.ball.lng -= sign * excess * bounds.widthDir.lng;
            bounced = true;
        }

        return bounced;
    }

    applyGravity() {
        // Calculate combined gravitational pull from all players
        let totalForce = { lat: 0, lng: 0 };

        this.players.forEach(player => {
            const dx = player.lat - this.ball.lat;
            const dy = player.lng - this.ball.lng;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > 0.000001) {
                // Inverse square law with cap
                const force = Math.min(GRAVITY_STRENGTH, GRAVITY_STRENGTH / (dist * 1000));
                totalForce.lat += (dx / dist) * force;
                totalForce.lng += (dy / dist) * force;
            }
        });

        this.ball.vLat += totalForce.lat;
        this.ball.vLng += totalForce.lng;
    }

    checkGoals() {
        const bounds = this.fieldBounds;
        const center = this.fieldCenter;

        // Vector from center to ball
        const toBall = {
            lat: this.ball.lat - center.lat,
            lng: this.ball.lng - center.lng
        };

        // Project onto directions
        const lengthProj = toBall.lat * bounds.lengthDir.lat + toBall.lng * bounds.lengthDir.lng;
        const widthProj = toBall.lat * bounds.widthDir.lat + toBall.lng * bounds.widthDir.lng;

        const halfLength = bounds.length / 2;
        const goalHalfWidth = bounds.width / 8; // 1/4 of width, so half is 1/8

        // Check goal 1 (negative length direction)
        if (lengthProj < -halfLength && Math.abs(widthProj) < goalHalfWidth) {
            this.score.team2++;
            io.to(this.id).emit('goal', { team: 2, score: this.score });
            this.resetBall();
        }
        // Check goal 2 (positive length direction)
        else if (lengthProj > halfLength && Math.abs(widthProj) < goalHalfWidth) {
            this.score.team1++;
            io.to(this.id).emit('goal', { team: 1, score: this.score });
            this.resetBall();
        }
    }

    kickBall(playerId) {
        const player = this.players.get(playerId);
        if (!player) return false;

        // Check distance to ball
        const dx = this.ball.lat - player.lat;
        const dy = this.ball.lng - player.lng;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > KICK_THRESHOLD) return false;

        // Kick the ball away from the player
        if (dist > 0.0000001) {
            const power = this.kickPower * this.ballSpeed;
            this.ball.vLat = (dx / dist) * power;
            this.ball.vLng = (dy / dist) * power;
        } else {
            // Player is exactly on ball, kick in random direction
            const angle = Math.random() * 2 * Math.PI;
            const power = this.kickPower * this.ballSpeed;
            this.ball.vLat = Math.cos(angle) * power;
            this.ball.vLng = Math.sin(angle) * power;
        }

        return true;
    }

    broadcastState() {
        const state = {
            ball: this.ball,
            players: Array.from(this.players.values()).map(p => ({
                id: p.id,
                name: p.name,
                team: p.team,
                lat: p.lat,
                lng: p.lng
            })),
            score: this.score,
            timeRemaining: Math.max(0, this.timeLimit * 60 - (Date.now() - this.startTime) / 1000),
            isRunning: this.isRunning
        };

        io.to(this.id).emit('gameState', state);
    }

    getState() {
        return {
            id: this.id,
            field: this.field,
            goals: this.goals,
            ball: this.ball,
            players: Array.from(this.players.values()),
            score: this.score,
            timeLimit: this.timeLimit,
            ballSpeed: this.ballSpeed,
            isRunning: this.isRunning,
            timeRemaining: this.startTime ?
                Math.max(0, this.timeLimit * 60 - (Date.now() - this.startTime) / 1000) :
                this.timeLimit * 60
        };
    }
}

// API Routes
app.post('/api/games', (req, res) => {
    const { field, timeLimit, ballSpeed } = req.body;

    if (!field || field.length !== 4) {
        return res.status(400).json({ error: 'Invalid field configuration' });
    }

    const gameId = uuidv4().substring(0, 8);
    const game = new Game(gameId, { field, timeLimit, ballSpeed });
    games.set(gameId, game);

    res.json({ gameId, inviteUrl: `/game/${gameId}` });
});

app.get('/api/games/:id', (req, res) => {
    const game = games.get(req.params.id);
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }
    res.json(game.getState());
});

// Serve game page
app.get('/game/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('joinGame', ({ gameId, playerName }) => {
        const game = games.get(gameId);
        if (!game) {
            socket.emit('error', { message: 'Game not found' });
            return;
        }

        const playerId = uuidv4().substring(0, 8);
        const team = game.addPlayer(playerId, playerName, socket.id);

        socket.join(gameId);
        socket.gameId = gameId;
        socket.playerId = playerId;

        socket.emit('joined', {
            playerId,
            team,
            gameState: game.getState()
        });

        io.to(gameId).emit('playerJoined', {
            player: game.players.get(playerId),
            players: Array.from(game.players.values())
        });
    });

    socket.on('updatePosition', ({ lat, lng }) => {
        if (!socket.gameId || !socket.playerId) return;

        const game = games.get(socket.gameId);
        if (game) {
            game.updatePlayerPosition(socket.playerId, lat, lng);
        }
    });

    socket.on('kick', () => {
        if (!socket.gameId || !socket.playerId) return;

        const game = games.get(socket.gameId);
        if (game && game.isRunning) {
            const kicked = game.kickBall(socket.playerId);
            if (kicked) {
                io.to(socket.gameId).emit('ballKicked', {
                    playerId: socket.playerId,
                    ball: game.ball
                });
            }
        }
    });

    socket.on('startGame', () => {
        if (!socket.gameId) return;

        const game = games.get(socket.gameId);
        if (game && !game.isRunning) {
            game.start();
            io.to(socket.gameId).emit('gameStarted', {
                startTime: game.startTime,
                timeLimit: game.timeLimit
            });
        }
    });

    socket.on('disconnect', () => {
        if (socket.gameId && socket.playerId) {
            const game = games.get(socket.gameId);
            if (game) {
                game.removePlayer(socket.playerId);
                io.to(socket.gameId).emit('playerLeft', {
                    playerId: socket.playerId,
                    players: Array.from(game.players.values())
                });

                // Clean up empty games
                if (game.players.size === 0) {
                    game.stop();
                    games.delete(socket.gameId);
                }
            }
        }
        console.log('Client disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Soccer Geo Game server running on port ${PORT}`);
});
