const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Game Configuration
const CONFIG = {
    IMPOSTER_COUNT: (players) => Math.max(1, Math.floor(players / 3)),
    TASK_COUNT: 20,
    KILL_COOLDOWN: 15000, // 15 seconds
    SABOTAGE_COOLDOWN: 30000, // 30 seconds
    VOTE_TIME: 10000, // 10 seconds
};

// Game State
const gameState = {
    phase: 'lobby', // lobby, playing, voting, ended
    players: new Map(), // id -> { id, name, role, isAlive, ws, lastKill }
    imposters: [],
    tasks: [],
    votes: {},
    emergencyMeetings: 0,
    meetingActive: false,
    sabotageActive: false,
    map: 'skeld'
};

// Task Definitions
const TASK_DEFINITIONS = [
    'Fix Wiring', 'Upload Data', 'Clear Trash', 'Prime Shields',
    'Fuel Engines', 'Start Reactor', 'Align Engine', 'Divert Power',
    'Unlock Manifolds', 'Calibrate Distributor', 'Inspect Sample', 'Unlock Codes',
    'Accept Power', 'Reset Reactor', 'Clean O2 Filter', 'Flush Logs',
    'Reset Seismic', 'Align Telescope', 'Make Burger', 'Assemble Artifact'
];

// Initialize Tasks
function initializeTasks() {
    gameState.tasks = TASK_DEFINITIONS.slice(0, CONFIG.TASK_COUNT).map((name, i) => ({
        id: i,
        name,
        completed: false,
        completedBy: null
    }));
}

// Routes

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        phase: gameState.phase,
        players: gameState.players.size,
        timestamp: new Date().toISOString()
    });
});

// API Documentation
app.get('/api', (req, res) => {
    res.json({
        name: 'Agent Among Us API',
        version: '1.0.0',
        endpoints: {
            'GET /': 'Health check',
            'GET /api/game': 'Get full game state',
            'GET /api/players': 'List all players',
            'GET /api/tasks': 'List all tasks',
            'GET /api/map': 'Get map data',
            'POST /api/join': 'Join game',
            'POST /api/start': 'Start game',
            'POST /api/vote': 'Submit vote',
            'POST /api/complete_task': 'Complete a task',
            'POST /api/kill': 'Imposter kill (requires imposter role)',
            'POST /api/sabotage': 'Trigger sabotage',
            'POST /api/repair': 'Repair sabotage'
        }
    });
});

// Get full game state
app.get('/api/game', (req, res) => {
    res.json({
        phase: gameState.phase,
        players: Array.from(gameState.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            role: p.role,
            isAlive: p.isAlive
        })),
        tasks: gameState.tasks,
        imposters: gameState.imposters,
        stats: {
            totalPlayers: gameState.players.size,
            alivePlayers: Array.from(gameState.players.values()).filter(p => p.isAlive).length,
            aliveImposters: gameState.imposters.filter(id => gameState.players.get(id)?.isAlive).length,
            completedTasks: gameState.tasks.filter(t => t.completed).length,
            totalTasks: gameState.tasks.length
        }
    });
});

// List players
app.get('/api/players', (req, res) => {
    const playerList = Array.from(gameState.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        isAlive: p.isAlive
    }));
    res.json(playerList);
});

// List tasks
app.get('/api/tasks', (req, res) => {
    res.json(gameState.tasks);
});

// List map data
app.get('/api/map', (req, res) => {
    res.json({
        name: 'The Skeld',
        rooms: [
            { id: 'cafeteria', name: 'Cafeteria', x: 10, y: 40, width: 15, height: 20 },
            { id: 'admin', name: 'Admin', x: 30, y: 20, width: 12, height: 15 },
            { id: 'electrical', name: 'Electrical', x: 60, y: 15, width: 15, height: 20 },
            { id: 'medbay', name: 'MedBay', x: 50, y: 50, width: 12, height: 18 },
            { id: 'security', name: 'Security', x: 80, y: 30, width: 12, height: 18 },
            { id: 'reactor', name: 'Reactor', x: 85, y: 70, width: 12, height: 18 },
            { id: 'o2', name: 'O2', x: 25, y: 75, width: 15, height: 18 },
            { id: 'navigation', name: 'Navigation', x: 10, y: 80, width: 12, height: 15 }
        ]
    });
});

// Join game
app.post('/api/join', (req, res) => {
    const { agentId, name } = req.body;
    
    if (!agentId) {
        return res.status(400).json({ success: false, message: 'agentId required' });
    }
    
    if (gameState.phase !== 'lobby') {
        return res.status(400).json({ success: false, message: 'Game already in progress' });
    }
    
    if (gameState.players.has(agentId)) {
        return res.json({ success: true, player: gameState.players.get(agentId), message: 'Already joined' });
    }

    const player = {
        id: agentId,
        name: name || agentId,
        role: 'crewmate',
        isAlive: true,
        ws: null,
        lastKill: 0,
        tasksCompleted: 0
    };
    
    gameState.players.set(agentId, player);
    broadcast({
        type: 'player_joined',
        player: { id: player.id, name: player.name, role: player.role, isAlive: player.isAlive }
    });
    
    console.log(`Player joined: ${player.name} (${player.id})`);
    res.json({ success: true, player });
});

// Start game
app.post('/api/start', (req, res) => {
    const playerCount = gameState.players.size;
    
    if (playerCount < 4) {
        return res.status(400).json({ success: false, message: 'Need 4+ players to start' });
    }
    
    // Reset game state
    initializeTasks();
    gameState.votes = {};
    gameState.emergencyMeetings = Math.floor(playerCount / 2) + 1;
    gameState.meetingActive = false;
    gameState.sabotageActive = false;
    
    // Assign roles
    const players = Array.from(gameState.players.values());
    const imposterCount = CONFIG.IMPOSTER_COUNT(playerCount);
    
    // Shuffle and assign
    const shuffled = players.sort(() => Math.random() - 0.5);
    gameState.imposters = shuffled.slice(0, imposterCount).map(p => p.id);
    
    shuffled.forEach(p => {
        p.role = gameState.imposters.includes(p.id) ? 'imposter' : 'crewmate';
        p.isAlive = true;
        p.tasksCompleted = 0;
    });
    
    gameState.phase = 'playing';
    
    console.log(`Game started! Imposters: ${gameState.imposters.join(', ')}`);
    
    broadcast({
        type: 'game_started',
        imposters: gameState.imposters,
        crewmates: players.filter(p => !gameState.imposters.includes(p.id)).map(p => p.id),
        tasks: gameState.tasks,
        meetingCount: gameState.emergencyMeetings
    });
    
    res.json({ 
        success: true, 
        role: players[0].role,
        message: `You are a ${players[0].role.toUpperCase()}!`
    });
});

// Submit vote
app.post('/api/vote', (req, res) => {
    const { agentId, targetId } = req.body;
    
    if (gameState.phase !== 'playing' && gameState.phase !== 'voting') {
        return res.status(400).json({ success: false, message: 'Not in voting phase' });
    }
    
    if (!gameState.meetingActive) {
        return res.status(400).json({ success: false, message: 'No meeting active' });
    }
    
    const player = gameState.players.get(agentId);
    if (!player || !player.isAlive) {
        return res.status(400).json({ success: false, message: 'Player not found or dead' });
    }
    
    if (gameState.votes[agentId]) {
        return res.status(400).json({ success: false, message: 'Already voted' });
    }
    
    gameState.votes[agentId] = targetId;
    
    broadcast({
        type: 'vote_received',
        voter: agentId,
        target: targetId,
        voteCount: Object.keys(gameState.votes).length,
        totalVotes: Array.from(gameState.players.values()).filter(p => p.isAlive).length
    });
    
    res.json({ success: true });
    
    checkVotingComplete();
});

// Complete task
app.post('/api/complete_task', (req, res) => {
    const { agentId, taskId } = req.body;
    
    if (gameState.phase !== 'playing') {
        return res.status(400).json({ success: false, message: 'Game not playing' });
    }
    
    const player = gameState.players.get(agentId);
    if (!player || !player.isAlive || player.role !== 'crewmate') {
        return res.status(400).json({ success: false, message: 'Cannot complete tasks' });
    }
    
    const task = gameState.tasks.find(t => t.id === taskId);
    if (!task || task.completed) {
        return res.status(400).json({ success: false, message: 'Task not found or already completed' });
    }
    
    task.completed = true;
    task.completedBy = agentId;
    player.tasksCompleted++;
    
    broadcast({
        type: 'task_completed',
        taskId,
        taskName: task.name,
        player: agentId,
        completed: gameState.tasks.filter(t => t.completed).length,
        total: gameState.tasks.length
    });
    
    console.log(`Task completed: ${task.name} by ${player.name}`);
    
    // Check win condition
    if (gameState.tasks.every(t => t.completed)) {
        endGame('crewmates');
    }
    
    res.json({ success: true, task });
});

// Imposter kill
app.post('/api/kill', (req, res) => {
    const { agentId, targetId } = req.body;
    
    if (gameState.phase !== 'playing' || gameState.sabotageActive) {
        return res.status(400).json({ success: false, message: 'Cannot kill now' });
    }
    
    const player = gameState.players.get(agentId);
    if (!player || !player.isAlive || player.role !== 'imposter') {
        return res.status(400).json({ success: false, message: 'Cannot kill' });
    }
    
    const now = Date.now();
    if (now - player.lastKill < CONFIG.KILL_COOLDOWN) {
        return res.status(400).json({ 
            success: false, 
            message: `Kill on cooldown (${Math.ceil((CONFIG.KILL_COOLDOWN - (now - player.lastKill))/1000)}s)` 
        });
    }
    
    const target = gameState.players.get(targetId);
    if (!target || !target.isAlive) {
        return res.status(400).json({ success: false, message: 'Target not found or dead' });
    }
    
    player.lastKill = now;
    target.isAlive = false;
    
    broadcast({
        type: 'kill',
        killer: agentId,
        victim: targetId,
        victimName: target.name
    });
    
    console.log(`Kill: ${target.name} was killed by an imposter`);
    
    // Check win condition
    const aliveImposters = gameState.imposters.filter(id => gameState.players.get(id)?.isAlive).length;
    const aliveCrewmates = Array.from(gameState.players.values()).filter(p => p.isAlive && p.role === 'crewmate').length;
    
    if (aliveImposters >= aliveCrewmates) {
        endGame('imposters');
    }
    
    res.json({ success: true });
});

// Trigger sabotage
app.post('/api/sabotage', (req, res) => {
    const { agentId } = req.body;
    
    if (gameState.phase !== 'playing' || gameState.sabotageActive) {
        return res.status(400).json({ success: false, message: 'Cannot sabotage now' });
    }
    
    const player = gameState.players.get(agentId);
    if (!player || !player.isAlive || player.role !== 'imposter') {
        return res.status(400).json({ success: false, message: 'Cannot sabotage' });
    }
    
    gameState.sabotageActive = true;
    gameState.sabotageType = Math.random() > 0.5 ? 'reactor' : 'o2';
    
    broadcast({
        type: 'sabotage',
        sabotageType: gameState.sabotageType,
        timeRemaining: CONFIG.SABOTAGE_COOLDOWN / 1000
    });
    
    console.log(`Sabotage triggered: ${gameState.sabotageType}`);
    
    res.json({ success: true, sabotageType: gameState.sabotageType });
});

// Repair sabotage
app.post('/api/repair', (req, res) => {
    const { agentId } = req.body;
    
    if (!gameState.sabotageActive) {
        return res.status(400).json({ success: false, message: 'No sabotage active' });
    }
    
    const player = gameState.players.get(agentId);
    if (!player || !player.isAlive) {
        return res.status(400).json({ success: false, message: 'Cannot repair' });
    }
    
    gameState.sabotageActive = false;
    
    broadcast({
        type: 'sabotage_repaired',
        repairedBy: agentId
    });
    
    console.log(`Sabotage repaired by ${player.name}`);
    res.json({ success: true });
});

// Trigger emergency meeting
app.post('/api/emergency', (req, res) => {
    const { agentId } = req.body;
    
    if (gameState.phase !== 'playing' || gameState.meetingActive) {
        return res.status(400).json({ success: false, message: 'Cannot call meeting' });
    }
    
    const player = gameState.players.get(agentId);
    if (!player || !player.isAlive) {
        return res.status(400).json({ success: false, message: 'Cannot call meeting' });
    }
    
    if (gameState.emergencyMeetings <= 0) {
        return res.status(400).json({ success: false, message: 'No emergency meetings left' });
    }
    
    gameState.emergencyMeetings--;
    gameState.meetingActive = true;
    gameState.phase = 'voting';
    
    broadcast({
        type: 'emergency_meeting',
        calledBy: agentId,
        meetingsRemaining: gameState.emergencyMeetings,
        voteTime: CONFIG.VOTE_TIME / 1000
    });
    
    console.log(`Emergency meeting called by ${player.name}`);
    
    // Auto-end voting after timeout
    setTimeout(() => {
        if (gameState.meetingActive) {
            processVoting();
        }
    }, CONFIG.VOTE_TIME);
    
    res.json({ success: true, meetingsRemaining: gameState.emergencyMeetings });
});

// WebSocket handling
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register') {
                const player = gameState.players.get(data.agentId);
                if (player) {
                    player.ws = ws;
                    ws.send(JSON.stringify({ 
                        type: 'registered', 
                        player: { id: player.id, name: player.name, role: player.role },
                        gameState: {
                            phase: gameState.phase,
                            imposters: gameState.imposters,
                            tasks: gameState.tasks
                        }
                    }));
                }
            }
        } catch (e) {
            console.error('WS error:', e);
        }
    });
});

// Helper functions
function broadcast(data) {
    const msg = JSON.stringify(data);
    gameState.players.forEach(p => {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(msg);
        }
    });
}

function checkVotingComplete() {
    const alivePlayers = Array.from(gameState.players.values()).filter(p => p.isAlive);
    const totalVotes = alivePlayers.length;
    const currentVotes = Object.keys(gameState.votes).length;
    
    if (currentVotes >= totalVotes) {
        processVoting();
    }
}

function processVoting() {
    const votes = {};
    Object.values(gameState.votes).forEach(target => {
        votes[target] = (votes[target] || 0) + 1;
    });
    
    const maxVotes = Math.max(...Object.values(votes));
    const tied = Object.values(votes).filter(v => v === maxVotes).length > 1;
    const ejected = tied ? null : Object.keys(votes).find(k => votes[k] === maxVotes);
    
    broadcast({
        type: 'voting_results',
        votes,
        ejected,
        tied
    });
    
    if (ejected) {
        const player = gameState.players.get(ejected);
        if (player && player.isAlive) {
            player.isAlive = false;
            broadcast({
                type: 'player_ejected',
                player: ejected,
                playerName: player.name
            });
            console.log(`Ejected: ${player.name}`);
            
            // Check win conditions
            const aliveImposters = gameState.imposters.filter(id => gameState.players.get(id)?.isAlive).length;
            const aliveCrewmates = Array.from(gameState.players.values()).filter(p => p.isAlive && p.role === 'crewmate').length;
            
            if (aliveImposters === 0) {
                endGame('crewmates');
            } else if (aliveImposters >= aliveCrewmates) {
                endGame('imposters');
            }
        }
    } else {
        console.log('Vote tied - no one ejected');
    }
    
    gameState.meetingActive = false;
    gameState.votes = {};
    gameState.phase = 'playing';
}

function endGame(winner) {
    gameState.phase = 'ended';
    
    const results = {
        type: 'game_ended',
        winner,
        imposters: gameState.imposters,
        crewmates: Array.from(gameState.players.values()).filter(p => p.role === 'crewmate').map(p => p.id),
        stats: {
            totalPlayers: gameState.players.size,
            tasksCompleted: gameState.tasks.filter(t => t.completed).length,
            totalTasks: gameState.tasks.length
        }
    };
    
    broadcast(results);
    console.log(`Game ended! Winner: ${winner}`);
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Agent Among Us running on port ${PORT}`);
    console.log(`Web interface: http://localhost:${PORT}`);
});
});
