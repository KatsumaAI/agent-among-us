const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// Game State
const players = new Map(); // agentId -> { id, name, role, isAlive, ws }
const gameState = {
    phase: 'lobby', // lobby, playing, voting, ended
    imposters: [],
    crewmates: [],
    tasks: [],
    votes: {},
    emergencyMeetings: 0
};

// Routes

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'running', phase: gameState.phase });
});

// List players
app.get('/api/players', (req, res) => {
    const playerList = Array.from(players.values()).map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        isAlive: p.isAlive
    }));
    res.json(playerList);
});

// Join game
app.post('/api/join', (req, res) => {
    const { agentId, name } = req.body;
    if (players.has(agentId)) {
        return res.json({ success: false, message: 'Already joined' });
    }
    const player = {
        id: agentId,
        name: name || agentId,
        role: 'crewmate',
        isAlive: true,
        ws: null
    };
    players.set(agentId, player);
    broadcast({ type: 'player_joined', player });
    res.json({ success: true, player });
});

// Start game (assign roles)
app.post('/api/start', (req, res) => {
    if (players.size < 4) {
        return res.json({ success: false, message: 'Need 4+ players' });
    }

    const playerArray = Array.from(players.values());
    const imposterCount = Math.floor(playerArray.length / 3);
    
    // Shuffle and assign
    const shuffled = playerArray.sort(() => Math.random() - 0.5);
    gameState.imposters = shuffled.slice(0, imposterCount).map(p => p.id);
    gameState.crewmates = shuffled.slice(imposterCount).map(p => p.id);
    gameState.phase = 'playing';
    gameState.emergencyMeetings = playerArray.length;

    // Assign roles
    gameState.imposters.forEach(id => players.get(id).role = 'imposter');
    gameState.crewmates.forEach(id => players.get(id).role = 'crewmate');

    broadcast({ type: 'game_started', imposters: gameState.imposters, crewmates: gameState.crewmates });
    res.json({ success: true, role: players.get(Array.from(players.keys())[0]).role });
});

// Vote
app.post('/api/vote', (req, res) => {
    const { agentId, targetId } = req.body;
    if (gameState.phase !== 'voting') {
        return res.json({ success: false, message: 'Not voting phase' });
    }
    gameState.votes[agentId] = targetId;
    broadcast({ type: 'vote_received', voter: agentId, target: targetId });

    if (Object.keys(gameState.votes).length === players.size) {
        // Count votes
        const counts = {};
        Object.values(gameState.votes).forEach(target => {
            counts[target] = (counts[target] || 0) + 1;
        });
        const maxVotes = Math.max(...Object.values(counts));
        const ejected = Object.keys(counts).find(k => counts[k] === maxVotes);

        if (ejected) {
            const ejectedPlayer = players.get(ejected);
            if (ejectedPlayer) {
                ejectedPlayer.isAlive = false;
                broadcast({ type: 'player_ejected', player: ejected });
            }
        }
        gameState.votes = {};
        gameState.phase = 'playing';
    }
    res.json({ success: true });
});

// WebSocket handling
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register') {
                const player = players.get(data.agentId);
                if (player) {
                    player.ws = ws;
                    ws.send(JSON.stringify({ type: 'registered', player }));
                }
            }
        } catch (e) {
            console.error('WS error:', e);
        }
    });
});

function broadcast(data) {
    const msg = JSON.stringify(data);
    players.forEach(p => {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(msg);
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Agent Among Us running on port ${PORT}`);
});
