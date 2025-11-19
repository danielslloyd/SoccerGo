// Initialize map
const map = L.map('map').setView([40.7128, -74.0060], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// State
let corners = [];
let markers = [];
let fieldPolygon = null;
let goalLines = [];

// DOM elements
const instructionText = document.getElementById('instruction-text');
const cornersList = document.getElementById('cornersList');
const clearBtn = document.getElementById('clearBtn');
const createBtn = document.getElementById('createBtn');
const ballSpeedSlider = document.getElementById('ballSpeed');
const ballSpeedValue = document.getElementById('ballSpeedValue');
const modal = document.getElementById('modal');
const inviteUrlInput = document.getElementById('inviteUrl');
const copyBtn = document.getElementById('copyBtn');
const goToGameBtn = document.getElementById('goToGameBtn');

// Ball speed slider
ballSpeedSlider.addEventListener('input', () => {
    ballSpeedValue.textContent = parseFloat(ballSpeedSlider.value).toFixed(1) + 'x';
});

// Map click handler
map.on('click', (e) => {
    if (corners.length >= 4) return;

    const { lat, lng } = e.latlng;
    corners.push({ lat, lng });

    // Add marker
    const marker = L.circleMarker([lat, lng], {
        radius: 8,
        fillColor: '#4ecca3',
        color: '#fff',
        weight: 2,
        fillOpacity: 1
    }).addTo(map);

    markers.push(marker);

    updateUI();

    if (corners.length === 4) {
        drawField();
    }
});

function updateUI() {
    // Update instructions
    const instructions = [
        'Click on the map to place the first corner of your field',
        'Click to place the second corner',
        'Click to place the third corner',
        'Click to place the fourth corner',
        'Field drawn! Adjust configuration and create the game'
    ];
    instructionText.textContent = instructions[Math.min(corners.length, 4)];

    // Update corners list
    if (corners.length === 0) {
        cornersList.innerHTML = '<p class="empty-state">No corners placed yet</p>';
    } else {
        cornersList.innerHTML = corners.map((c, i) =>
            `<div class="corner-item">Corner ${i + 1}: ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}</div>`
        ).join('');
    }

    // Update buttons
    clearBtn.disabled = corners.length === 0;
    createBtn.disabled = corners.length !== 4;
}

function drawField() {
    // Remove old polygon
    if (fieldPolygon) {
        map.removeLayer(fieldPolygon);
    }
    goalLines.forEach(line => map.removeLayer(line));
    goalLines = [];

    // Create polygon
    const points = corners.map(c => [c.lat, c.lng]);
    fieldPolygon = L.polygon(points, {
        color: '#4ecca3',
        fillColor: '#4ecca3',
        fillOpacity: 0.2,
        weight: 3
    }).addTo(map);

    // Calculate and draw goals
    drawGoals();

    // Check aspect ratio
    const aspectRatio = checkAspectRatio();
    if (!aspectRatio.valid) {
        instructionText.textContent = `Aspect ratio (${aspectRatio.ratio.toFixed(2)}) must be between 1:2 and 2:3`;
        createBtn.disabled = true;
    }
}

function drawGoals() {
    // Calculate field dimensions
    const edge01 = distance(corners[0], corners[1]);
    const edge12 = distance(corners[1], corners[2]);

    let goalEdges;
    if (edge01 >= edge12) {
        // p0-p1 and p2-p3 are the long edges, so goals are on p1-p2 and p3-p0
        goalEdges = [
            [corners[1], corners[2]],
            [corners[3], corners[0]]
        ];
    } else {
        // p1-p2 and p3-p0 are the long edges, so goals are on p0-p1 and p2-p3
        goalEdges = [
            [corners[0], corners[1]],
            [corners[2], corners[3]]
        ];
    }

    // Draw goal areas (center 1/4 of each goal edge)
    goalEdges.forEach(([p1, p2]) => {
        const center = {
            lat: (p1.lat + p2.lat) / 2,
            lng: (p1.lng + p2.lng) / 2
        };

        const dir = {
            lat: p2.lat - p1.lat,
            lng: p2.lng - p1.lng
        };

        // Goal is 1/4 of the edge length
        const goalStart = {
            lat: center.lat - dir.lat / 8,
            lng: center.lng - dir.lng / 8
        };
        const goalEnd = {
            lat: center.lat + dir.lat / 8,
            lng: center.lng + dir.lng / 8
        };

        const goalLine = L.polyline([
            [goalStart.lat, goalStart.lng],
            [goalEnd.lat, goalEnd.lng]
        ], {
            color: '#fff',
            weight: 5,
            opacity: 0.8
        }).addTo(map);

        goalLines.push(goalLine);
    });
}

function distance(p1, p2) {
    return Math.sqrt(Math.pow(p2.lat - p1.lat, 2) + Math.pow(p2.lng - p1.lng, 2));
}

function checkAspectRatio() {
    const edge01 = distance(corners[0], corners[1]);
    const edge12 = distance(corners[1], corners[2]);

    const longer = Math.max(edge01, edge12);
    const shorter = Math.min(edge01, edge12);
    const ratio = shorter / longer;

    // Valid ratio is between 1:2 (0.5) and 2:3 (0.667)
    return {
        valid: ratio >= 0.5 && ratio <= 0.667,
        ratio: ratio
    };
}

// Clear button
clearBtn.addEventListener('click', () => {
    corners = [];
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    if (fieldPolygon) {
        map.removeLayer(fieldPolygon);
        fieldPolygon = null;
    }
    goalLines.forEach(line => map.removeLayer(line));
    goalLines = [];
    updateUI();
});

// Create game button
createBtn.addEventListener('click', async () => {
    const timeLimit = parseInt(document.getElementById('timeLimit').value) || 10;
    const ballSpeed = parseFloat(ballSpeedSlider.value) || 1;

    try {
        const response = await fetch('/api/games', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                field: corners,
                timeLimit,
                ballSpeed
            })
        });

        const data = await response.json();

        if (data.gameId) {
            const fullUrl = window.location.origin + data.inviteUrl;
            inviteUrlInput.value = fullUrl;
            modal.classList.remove('hidden');

            goToGameBtn.onclick = () => {
                window.location.href = data.inviteUrl;
            };
        }
    } catch (error) {
        console.error('Error creating game:', error);
        alert('Failed to create game. Please try again.');
    }
});

// Copy button
copyBtn.addEventListener('click', () => {
    inviteUrlInput.select();
    document.execCommand('copy');
    copyBtn.textContent = 'Copied!';
    setTimeout(() => {
        copyBtn.textContent = 'Copy';
    }, 2000);
});

// Try to get user's location for initial map view
if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
        (position) => {
            map.setView([position.coords.latitude, position.coords.longitude], 15);
        },
        () => {
            // Keep default view if location access denied
        }
    );
}
