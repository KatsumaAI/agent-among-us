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
    KILL_COOLDOWN: 15000,
    SABOTAGE_COOLDOWN: 30000,
    VOTE_TIME: 15000,
    CHAT_ENABLED: true,
    ROOMS: [
        { id: 'cafeteria', name: 'CAFETERIA', x: 10, y: 40, width: 15, height: 20 },
        { id: 'admin', name: 'ADMIN', x: 28, y: 20, width: 14, height: 16 },
        { id: 'electrical', name: 'ELECTRICAL', x: 58, y: 12, width: 16, height: 18 },
        { id: 'medbay', name: 'MEDBAY', x: 48, y: 48, width: 14, height: 18 },
        { id: 'security', name: 'SECURITY', x: 78, y: 28, width: 14, height: 18 },
        { id: 'reactor', name: 'REACTOR', x: 82, y: 68, width: 14, height: 18 },
        { id: 'o2', name: 'O2', x: 22, y: 72, width: 16, height: 18 },
        { id: 'navigation', name: 'NAVIGATION', x: 8, y: 78, width: 12, height: 16 }
    ]
};

const ROOM_COORDS = {
    'cafeteria': { x: 15, y: 48 },
    'admin': { x: 35, y: 28 },
    'electrical': { x: 66, y: 21 },
    'medbay': { x: 55, y: 57 },
    'security': { x: 85, y: 37 },
    'reactor': { x: 89, y: 77 },
    'o2': { x: 30, y: 81 },
    'navigation': { x: 14, y: 86 }
};

// Game State
const gameState = {
    phase: 'lobby',
    players: new Map(),
    imposters: [],
    tasks: [],
    votes: {},
    emergencyMeetings: 0,
    meetingActive: false,
    sabotageActive: false,
    sabotageType: null,
    chat: [],
    chatEnabled: true
};

const TASK_DEFINITIONS = [
    'Fix Wiring', 'Upload Data', 'Clear Trash', 'Prime Shields',
    'Fuel Engines', 'Start Reactor', 'Align Engine', 'Divert Power',
    'Unlock Manifolds', 'Calibrate Distributor', 'Inspect Sample', 'Unlock Codes',
    'Accept Power', 'Reset Reactor', 'Clean O2 Filter', 'Flush Logs',
    'Reset Seismic', 'Align Telescope', 'Make Burger', 'Assemble Artifact'
];

function initializeTasks() {
    gameState.tasks = TASK_DEFINITIONS.slice(0, CONFIG.TASK_COUNT).map((name, i) => ({
        id: i,
        name,
        completed: false,
        completedBy: null
    }));
}

function initializePlayerLocation(playerId) {
    const rooms = Object.keys(ROOM_COORDS);
    const room = rooms[Math.floor(Math.random() * rooms.length)];
    return {
        room: room,
        x: ROOM_COORDS[room].x + Math.random() * 10 - 5,
        y: ROOM_COORDS[room].y + Math.random() * 10 - 5,
        targetRoom: null,
        targetX: null,
        targetY: null,
        moving: false,
        action: null,
        actionProgress: 0,
        lastUpdate: Date.now()
    };
}

app.get('/', (req, res) => {
    res.json({
        status: 'running',
        phase: gameState.phase,
        players: gameState.players.size,
        chatEnabled: gameState.chatEnabled,
        timestamp: new Date().toISOString()
    });
});

app.get('/api', (req, res) => {
    res.json({
        name: 'Agent Among Us API',
        version: '2.0.0',
        endpoints: {
            'GET /': 'Health check',
            'GET /api/game': 'Full game state',
            'GET /api/players': 'List players',
            'GET /api/tasks': 'List tasks',
            'GET /api/map': 'Map data',
            'GET /api/chat': 'Get chat messages',
            'POST /api/join': 'Join game',
            'POST /api/move': 'Move player',
            'POST /api/do_task': 'Do a task',
            'POST /api/start': 'Start game',
            'POST /api/chat': 'Send chat message',
            'POST /api/vote': 'Submit vote',
            'POST /api/kill': 'Imposter kill',
            'POST /api/sabotage': 'Trigger sabotage',
            'POST /api/repair': 'Repair sabotage',
            'POST /api/emergency': 'Call meeting'
        }
    });
});

app.get('/api/game', (req, res) => {
    const players = Array.from(gameState.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        isAlive: p.isAlive,
        location: p.location || initializePlayerLocation(p.id)
    }));
    
    res.json({
        phase: gameState.phase,
        players: players,
        tasks: gameState.tasks,
        imposters: gameState.imposters,
        chatEnabled: gameState.chatEnabled,
        sabotageActive: gameState.sabotageActive,
        sabotageType: gameState.sabotageType,
        stats: {
            totalPlayers: gameState.players.size,
            alivePlayers: players.filter(p => p.isAlive).length,
            aliveImposters: gameState.imposters.filter(id => gameState.players.get(id)?.isAlive).length,
            completedTasks: gameState.tasks.filter(t => t.completed).length,
            totalTasks: gameState.tasks.length,
            chatMessages: gameState.chat.length,
            emergencyMeetings: gameState.emergencyMeetings
        }
    });
});

app.get('/api/players', (req, res) => {
    const playerList = Array.from(gameState.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        isAlive: p.isAlive,
        location: p.location || initializePlayerLocation(p.id)
    }));
    res.json(playerList);
});

app.get('/api/tasks', (req, res) => {
    res.json(gameState.tasks);
});

app.get('/api/map', (req, res) => {
    res.json({
        name: 'The Skeld',
        rooms: CONFIG.ROOMS
    });
});

app.get('/api/chat', (req, res) => {
    const { limit } = req.query;
    const messages = limit ? gameState.chat.slice(-parseInt(limit)) : gameState.chat;
    res.json(messages);
});

app.post('/api/join', (req, res) => {
    const { agentId, name } = req.body;
    
    if (!agentId) {
        return res.status(400).json({ success: false, message: 'agentId required' });
    }
    
    if (gameState.phase !== 'lobby') {
        return res.status(400).json({ success: false, message: 'Game in progress' });
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
        tasksCompleted: 0,
        location: initializePlayerLocation(agentId)
    };
    
    gameState.players.set(agentId, player);
    broadcast({
        type: 'player_joined',
        player: { id: player.id, name: player.name }
    }, player.id);
    
    console.log(`[JOIN] ${player.name} (${player.id})`);
    res.json({ success: true, player });
});

app.post('/api/move', (req, res) => {
    const { agentId, targetRoom } = req.body;
    
    const player = gameState.players.get(agentId);
    if (!player || !player.isAlive) {
        return res.status(400).json({ success: false, message: 'Player not found or dead' });
    }
    
    if (!ROOM_COORDS[targetRoom]) {
        return res.status(400).json({ success: false, message: 'Invalid room' });
    }
    
    const target = ROOM_COORDS[targetRoom];
    player.location.targetRoom = targetRoom;
    player.location.targetX = target.x + Math.random() * 10 - 5;
    player.location.targetY = target.y + Math.random() * 10 - 5;
    player.location.moving = true;
    player.location.lastUpdate = Date.now();
    
    broadcast({
        type: 'player_moving',
        playerId: agentId,
        playerName: player.name,
        targetRoom: targetRoom,
        targetX: player.location.targetX,
        targetY: player.location.targetY
    }, null, true);
    
    res.json({ success: true, location: player.location });
});

app.post('/api/do_task', (req, res) => {
    const { agentId, taskId } = req.body;
    
    if (gameState.phase !== 'playing') {
        return res.status(400).json({ success: false, message: 'Game not playing' });
    }
    
    const player = gameState.players.get(agentId);
    if (!player || !player.isAlive || player.role !== 'crewmate') {
        return res.status(400).json({ success: false, message: 'Cannot do tasks' });
    }
    
    const task = gameState.tasks.find(t => t.id === taskId);
    if (!task || task.completed) {
        return res.status(400).json({ success: false, message: 'Task not found or completed' });
    }
    
    player.location.action = 'doing_task';
    player.location.actionTask = task.name;
    player.location.actionProgress = 0;
    
    res.json({ success: true, task: task.name });
});

app.post('/api/chat', (req, res) => {
    const { agentId, message } = req.body;
    
    if (!gameState.chatEnabled) {
        return res.status(400).json({ success: false, message: 'Chat disabled' });
    }
    
    if (!message || message.trim().length === 0) {
        return res.status(400).json({ success: false, message: 'Message required' });
    }
    
    if (message.length > 500) {
        return res.status(400).json({ success: false, message: 'Message too long' });
    }
    
    const player = gameState.players.get(agentId);
    if (!player || !player.isAlive) {
        return res.status(400).json({ success: false, message: 'Player not found or dead' });
    }
    
    const chatMessage = {
        id: uuidv4(),
        playerId: agentId,
        playerName: player.name,
        role: player.role,
        message: message.trim().substring(0, 500),
        timestamp: new Date().toISOString(),
        phase: gameState.phase
    };
    
    gameState.chat.push(chatMessage);
    
    if (gameState.chat.length > 100) {
        gameState.chat = gameState.chat.slice(-100);
    }
    
    broadcast({
        type: 'chat_message',
        message: chatMessage
    });
    
    console.log(`[CHAT] ${player.name}: ${message.substring(0, 100)}`);
    res.json({ success: true, message: chatMessage });
});

app.post('/api/start', (req, res) => {
    const playerCount = gameState.players.size;
    
    if (playerCount < 4 && !process.env.DEMO_MODE) {
        return res.status(400).json({ success: false, message: 'Need 4+ players' });
    }
    
    initializeTasks();
    gameState.votes = {};
    gameState.chat = [];
    gameState.emergencyMeetings = Math.floor(playerCount / 2) + 1;
    gameState.meetingActive = false;
    gameState.sabotageActive = false;
    
    const players = Array.from(gameState.players.values());
    const imposterCount = CONFIG.IMPOSTER_COUNT(playerCount);
    
    const shuffled = players.sort(() => Math.random() - 0.5);
    gameState.imposters = shuffled.slice(0, imposterCount).map(p => p.id);
    
    shuffled.forEach(p => {
        p.role = gameState.imposters.includes(p.id) ? 'imposter' : 'crewmate';
        p.isAlive = true;
        p.tasksCompleted = 0;
        p.location = initializePlayerLocation(p.id);
    });
    
    gameState.phase = 'playing';
    
    broadcast({
        type: 'game_started',
        imposters: gameState.imposters,
        crewmates: players.filter(p => !gameState.imposters.includes(p.id)).map(p => p.id),
        tasks: gameState.tasks,
        meetingCount: gameState.emergencyMeetings
    }, null, true);
    
    console.log(`[GAME] Started with ${imposterCount} imposter(s)`);
    
    res.json({ 
        success: true, 
        role: players[0].role,
        message: `You are a ${players[0].role.toUpperCase()}`
    });
});

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
        voterName: player.name,
        target: targetId
    }, null, true);
    
    res.json({ success: true });
    
    checkVotingComplete();
});

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
        return res.status(400).json({ success: false, message: 'Task not found or completed' });
    }
    
    task.completed = true;
    task.completedBy = agentId;
    player.tasksCompleted++;
    player.location.action = null;
    player.location.actionTask = null;
    player.location.actionProgress = 0;
    
    broadcast({
        type: 'task_completed',
        taskId,
        taskName: task.name,
        player: agentId,
        playerName: player.name,
        completed: gameState.tasks.filter(t => t.completed).length,
        total: gameState.tasks.length
    }, null, true);
    
    console.log(`[TASK] ${task.name} completed by ${player.name}`);
    
    if (gameState.tasks.every(t => t.completed)) {
        endGame('crewmates');
    }
    
    res.json({ success: true, task });
});

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
    player.location.action = 'killing';
    player.location.actionTarget = target.name;
    target.isAlive = false;
    
    setTimeout(() => {
        player.location.action = null;
        player.location.actionTarget = null;
    }, 1000);
    
    broadcast({
        type: 'kill',
        killer: agentId,
        killerName: player.name,
        victim: targetId,
        victimName: target.name
    }, null, true);
    
    console.log(`[KILL] ${player.name} eliminated ${target.name}`);
    
    const aliveImposters = gameState.imposters.filter(id => gameState.players.get(id)?.isAlive).length;
    const aliveCrewmates = Array.from(gameState.players.values()).filter(p => p.isAlive && p.role === 'crewmate').length;
    
    if (aliveImposters >= aliveCrewmates) {
        endGame('imposters');
    }
    
    res.json({ success: true });
});

app.post('/api/sabotage', (req, res) => {
    const { agentId } = req.body;
    
    if (gameState.phase !== 'playing' || gameState.sabotageActive) {
        return res.status(400).json({ success: false, message: 'Cannot sabotage' });
    }
    
    const player = gameState.players.get(agentId);
    if (!player || !player.isAlive || player.role !== 'imposter') {
        return res.status(400).json({ success: false, message: 'Cannot sabotage' });
    }
    
    gameState.sabotageActive = true;
    gameState.sabotageType = Math.random() > 0.5 ? 'reactor' : 'o2';
    player.location.action = 'sabotaging';
    
    broadcast({
        type: 'sabotage',
        sabotageType: gameState.sabotageType,
        sabotagePlayer: player.name,
        timeRemaining: CONFIG.SABOTAGE_COOLDOWN / 1000
    }, null, true);
    
    console.log(`[SABOTAGE] ${player.name} triggered ${gameState.sabotageType}`);
    
    res.json({ success: true, sabotageType: gameState.sabotageType });
});

app.post('/api/repair', (req, res) => {
    const { agentId } = req.body;
    
    if (!gameState.sabotageActive) {
        return res.status(400).json({ success: false, message: 'No sabotage' });
    }
    
    const player = gameState.players.get(agentId);
    if (!player || !player.isAlive) {
        return res.status(400).json({ success: false, message: 'Cannot repair' });
    }
    
    gameState.sabotageActive = false;
    gameState.sabotageType = null;
    
    broadcast({
        type: 'sabotage_repaired',
        repairedBy: agentId,
        repairedByName: player.name
    }, null, true);
    
    console.log(`[SABOTAGE] ${player.name} repaired`);
    res.json({ success: true });
});

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
        return res.status(400).json({ success: false, message: 'No meetings left' });
    }
    
    gameState.emergencyMeetings--;
    gameState.meetingActive = true;
    gameState.phase = 'voting';
    
    broadcast({
        type: 'emergency_meeting',
        calledBy: agentId,
        calledByName: player.name,
        meetingsRemaining: gameState.emergencyMeetings,
        voteTime: CONFIG.VOTE_TIME / 1000
    }, null, true);
    
    console.log(`[VOTE] Emergency meeting called by ${player.name}`);
    
    setTimeout(() => {
        if (gameState.meetingActive) {
            processVoting();
        }
    }, CONFIG.VOTE_TIME);
    
    res.json({ success: true, meetingsRemaining: gameState.emergencyMeetings });
});

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
                            tasks: gameState.tasks,
                            chatEnabled: gameState.chatEnabled
                        }
                    }));
                }
            }
        } catch (e) {
            console.error('WS error:', e);
        }
    });
});

function broadcast(data, excludeId = null, includeChat = false) {
    const msg = JSON.stringify(data);
    gameState.players.forEach((p, id) => {
        if (id !== excludeId && p.ws && p.ws.readyState === WebSocket.OPEN) {
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
        tied,
        ejectedName: ejected ? gameState.players.get(ejected)?.name : null
    }, null, true);
    
    if (ejected) {
        const player = gameState.players.get(ejected);
        if (player && player.isAlive) {
            player.isAlive = false;
            broadcast({
                type: 'player_ejected',
                player: ejected,
                playerName: player.name
            }, null, true);
            console.log(`[VOTE] ${player.name} was ejected`);
            
            const aliveImposters = gameState.imposters.filter(id => gameState.players.get(id)?.isAlive).length;
            const aliveCrewmates = Array.from(gameState.players.values()).filter(p => p.isAlive && p.role === 'crewmate').length;
            
            if (aliveImposters === 0) {
                endGame('crewmates');
            } else if (aliveImposters >= aliveCrewmates) {
                endGame('imposters');
            }
        }
    } else {
        console.log('[VOTE] Tie - no ejection');
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
        winnerName: winner === 'imposters' ? 'IMPOSTERS' : 'CREWMATES',
        imposters: gameState.imposters,
        crewmates: Array.from(gameState.players.values()).filter(p => p.role === 'crewmate').map(p => p.id),
        stats: {
            totalPlayers: gameState.players.size,
            tasksCompleted: gameState.tasks.filter(t => t.completed).length,
            totalTasks: gameState.tasks.length,
            chatMessages: gameState.chat.length
        }
    };
    
    broadcast(results, null, true);
    console.log(`[GAME] Over - ${winner.toUpperCase()} win`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[SERVER] Agent Among Us running on port ${PORT}`);
    console.log(`[WEB] Interface: http://localhost:${PORT}`);
});
