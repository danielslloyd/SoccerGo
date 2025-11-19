// Get game ID from URL
const gameId = window.location.pathname.split('/').pop();

// Socket connection
const socket = io();

// Map and markers
let map;
let fieldPolygon;
let goalLines = [];
let ballMarker;
let playerMarkers = new Map();
let myMarker;

// Game state
let playerId;
let playerTeam;
let gameState = null;
let watchId = null;

// DOM elements
const joinModal = document.getElementById('joinModal');
const goalModal = document.getElementById('goalModal');
const gameOverModal = document.getElementById('gameOverModal');
const playerNameInput = document.getElementById('playerNameInput');
const joinBtn = document.getElementById('joinBtn');
const kickBtn = document.getElementById('kickBtn');
const startBtn = document.getElementById('startBtn');
const shareBtn = document.getElementById('shareBtn');
const playersList = document.getElementById('playersList');
const timerDisplay = document.getElementById('timer');
const score1Display = document.getElementById('score1');
const score2Display = document.getElementById('score2');
const playerTeamDisplay = document.getElementById('playerTeam');
const playerNameDisplay = document.getElementById('playerName');
const ballDistanceDisplay = document.getElementById('ballDistance');
const kickStatusDisplay = document.getElementById('kickStatus');

// Initialize
async function init() {
    try {
        // Fetch game data
        const response = await fetch(`/api/games/${gameId}`);
        if (!response.ok) {
            alert('Game not found!');
            window.location.href = '/';
            return;
        }

        gameState = await response.json();
        initializeMap();
    } catch (error) {
        console.error('Error loading game:', error);
        alert('Failed to load game');
    }
}

function initializeMap() {
    // Calculate center of field
    const lats = gameState.field.map(p => p.lat);
    const lngs = gameState.field.map(p => p.lng);
    const center = [
        (Math.min(...lats) + Math.max(...lats)) / 2,
        (Math.min(...lngs) + Math.max(...lngs)) / 2
    ];

    // Initialize map
    map = L.map('game-map').setView(center, 16);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    // Draw field
    drawField();

    // Fit map to field
    const bounds = L.latLngBounds(gameState.field.map(p => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [50, 50] });

    // Create ball marker
    ballMarker = L.circleMarker([gameState.ball.lat, gameState.ball.lng], {
        radius: 10,
        fillColor: '#fff',
        color: '#000',
        weight: 3,
        fillOpacity: 1,
        className: 'ball-marker'
    }).addTo(map);
}

function drawField() {
    // Draw field polygon
    const points = gameState.field.map(c => [c.lat, c.lng]);
    fieldPolygon = L.polygon(points, {
        color: '#4ecca3',
        fillColor: '#4ecca3',
        fillOpacity: 0.15,
        weight: 3
    }).addTo(map);

    // Calculate and draw goals
    const corners = gameState.field;
    const edge01 = distance(corners[0], corners[1]);
    const edge12 = distance(corners[1], corners[2]);

    let goalEdges;
    if (edge01 >= edge12) {
        goalEdges = [
            [corners[1], corners[2]],
            [corners[3], corners[0]]
        ];
    } else {
        goalEdges = [
            [corners[0], corners[1]],
            [corners[2], corners[3]]
        ];
    }

    // Draw goal areas
    goalEdges.forEach(([p1, p2], index) => {
        const center = {
            lat: (p1.lat + p2.lat) / 2,
            lng: (p1.lng + p2.lng) / 2
        };

        const dir = {
            lat: p2.lat - p1.lat,
            lng: p2.lng - p1.lng
        };

        const goalStart = {
            lat: center.lat - dir.lat / 8,
            lng: center.lng - dir.lng / 8
        };
        const goalEnd = {
            lat: center.lat + dir.lat / 8,
            lng: center.lng + dir.lng / 8
        };

        const goalColor = index === 0 ? '#ff6b6b' : '#4dabf7';
        const goalLine = L.polyline([
            [goalStart.lat, goalStart.lng],
            [goalEnd.lat, goalEnd.lng]
        ], {
            color: goalColor,
            weight: 6,
            opacity: 0.8
        }).addTo(map);

        goalLines.push(goalLine);
    });
}

function distance(p1, p2) {
    return Math.sqrt(Math.pow(p2.lat - p1.lat, 2) + Math.pow(p2.lng - p1.lng, 2));
}

// Join game
joinBtn.addEventListener('click', () => {
    const name = playerNameInput.value.trim();
    if (!name) {
        alert('Please enter your name');
        return;
    }

    socket.emit('joinGame', { gameId, playerName: name });
});

// Socket event handlers
socket.on('joined', (data) => {
    playerId = data.playerId;
    playerTeam = data.team;
    gameState = data.gameState;

    joinModal.classList.add('hidden');

    // Update player info
    playerTeamDisplay.textContent = `Team ${playerTeam}`;
    playerTeamDisplay.style.color = playerTeam === 1 ? '#ff6b6b' : '#4dabf7';
    playerNameDisplay.textContent = playerNameInput.value;

    // Start location tracking
    startLocationTracking();

    // Update players list
    updatePlayersList(gameState.players);
});

socket.on('playerJoined', (data) => {
    updatePlayersList(data.players);
});

socket.on('playerLeft', (data) => {
    updatePlayersList(data.players);

    // Remove marker
    if (playerMarkers.has(data.playerId)) {
        map.removeLayer(playerMarkers.get(data.playerId));
        playerMarkers.delete(data.playerId);
    }
});

socket.on('gameState', (state) => {
    gameState = state;
    updateGameDisplay();
});

socket.on('gameStarted', (data) => {
    gameState.isRunning = true;
    gameState.startTime = data.startTime;
    startBtn.disabled = true;
    startBtn.textContent = 'Game Running';
});

socket.on('goal', (data) => {
    // Show goal celebration
    document.getElementById('goalText').textContent = `Team ${data.team} scores!`;
    goalModal.classList.remove('hidden');

    setTimeout(() => {
        goalModal.classList.add('hidden');
    }, 2000);
});

socket.on('gameOver', (data) => {
    document.getElementById('final1').textContent = data.score.team1;
    document.getElementById('final2').textContent = data.score.team2;

    let winnerText = '';
    if (data.score.team1 > data.score.team2) {
        winnerText = 'Team 1 Wins!';
    } else if (data.score.team2 > data.score.team1) {
        winnerText = 'Team 2 Wins!';
    } else {
        winnerText = "It's a Draw!";
    }
    document.getElementById('winnerText').textContent = winnerText;

    gameOverModal.classList.remove('hidden');
});

socket.on('ballKicked', (data) => {
    // Visual feedback for kick
    if (ballMarker) {
        ballMarker.setStyle({ fillColor: '#ffeb3b' });
        setTimeout(() => {
            ballMarker.setStyle({ fillColor: '#fff' });
        }, 200);
    }
});

socket.on('error', (data) => {
    alert(data.message);
});

// Location tracking
function startLocationTracking() {
    if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser');
        return;
    }

    watchId = navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude } = position.coords;

            // Send position to server
            socket.emit('updatePosition', { lat: latitude, lng: longitude });

            // Update my marker
            if (!myMarker) {
                myMarker = L.circleMarker([latitude, longitude], {
                    radius: 12,
                    fillColor: playerTeam === 1 ? '#ff6b6b' : '#4dabf7',
                    color: '#fff',
                    weight: 3,
                    fillOpacity: 1
                }).addTo(map);
            } else {
                myMarker.setLatLng([latitude, longitude]);
            }

            // Calculate distance to ball
            if (gameState && gameState.ball) {
                const dist = calculateRealDistance(
                    latitude, longitude,
                    gameState.ball.lat, gameState.ball.lng
                );
                updateKickStatus(dist);
            }
        },
        (error) => {
            console.error('Geolocation error:', error);
            // Use simulated position for testing
            simulatePosition();
        },
        {
            enableHighAccuracy: true,
            maximumAge: 1000,
            timeout: 5000
        }
    );
}

// Simulate position for testing (click on map)
function simulatePosition() {
    map.on('click', (e) => {
        const { lat, lng } = e.latlng;

        socket.emit('updatePosition', { lat, lng });

        if (!myMarker) {
            myMarker = L.circleMarker([lat, lng], {
                radius: 12,
                fillColor: playerTeam === 1 ? '#ff6b6b' : '#4dabf7',
                color: '#fff',
                weight: 3,
                fillOpacity: 1
            }).addTo(map);
        } else {
            myMarker.setLatLng([lat, lng]);
        }

        if (gameState && gameState.ball) {
            const dist = calculateRealDistance(lat, lng, gameState.ball.lat, gameState.ball.lng);
            updateKickStatus(dist);
        }
    });
}

function calculateRealDistance(lat1, lng1, lat2, lng2) {
    // Haversine formula for real distance in meters
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function updateKickStatus(distanceMeters) {
    ballDistanceDisplay.textContent = distanceMeters.toFixed(1);

    // Can kick within ~11 meters (0.0001 degrees)
    const canKick = distanceMeters < 11;

    if (canKick) {
        kickStatusDisplay.textContent = 'You can kick!';
        kickStatusDisplay.className = 'can-kick';
        kickBtn.style.opacity = '1';
    } else {
        kickStatusDisplay.textContent = 'Move closer to kick!';
        kickStatusDisplay.className = '';
        kickBtn.style.opacity = '0.5';
    }
}

// Update game display
function updateGameDisplay() {
    if (!gameState) return;

    // Update ball position
    if (ballMarker) {
        ballMarker.setLatLng([gameState.ball.lat, gameState.ball.lng]);
    }

    // Update player markers
    gameState.players.forEach(player => {
        if (player.id === playerId) return; // Skip self

        if (playerMarkers.has(player.id)) {
            playerMarkers.get(player.id).setLatLng([player.lat, player.lng]);
        } else {
            const marker = L.circleMarker([player.lat, player.lng], {
                radius: 10,
                fillColor: player.team === 1 ? '#ff6b6b' : '#4dabf7',
                color: '#fff',
                weight: 2,
                fillOpacity: 0.8
            }).addTo(map).bindTooltip(player.name);

            playerMarkers.set(player.id, marker);
        }
    });

    // Update score
    score1Display.textContent = gameState.score.team1;
    score2Display.textContent = gameState.score.team2;

    // Update timer
    if (gameState.isRunning && gameState.timeRemaining !== undefined) {
        const minutes = Math.floor(gameState.timeRemaining / 60);
        const seconds = Math.floor(gameState.timeRemaining % 60);
        timerDisplay.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
}

function updatePlayersList(players) {
    playersList.innerHTML = players.map(p =>
        `<div class="player-item">
            <span class="player-dot ${p.team === 1 ? 'team1-dot' : 'team2-dot'}"></span>
            ${p.name} ${p.id === playerId ? '(you)' : ''}
        </div>`
    ).join('');
}

// Kick button
kickBtn.addEventListener('click', () => {
    socket.emit('kick');
});

// Keyboard shortcut for kick
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !joinModal.classList.contains('hidden') === false) {
        e.preventDefault();
        socket.emit('kick');
    }
});

// Start game button
startBtn.addEventListener('click', () => {
    socket.emit('startGame');
});

// Share button
shareBtn.addEventListener('click', () => {
    const url = window.location.href;
    if (navigator.share) {
        navigator.share({
            title: 'Join my Soccer Geo Game!',
            url: url
        });
    } else {
        navigator.clipboard.writeText(url).then(() => {
            shareBtn.textContent = 'Copied!';
            setTimeout(() => {
                shareBtn.textContent = 'Share Link';
            }, 2000);
        });
    }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (watchId) {
        navigator.geolocation.clearWatch(watchId);
    }
});

// Initialize
init();
