const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let tournaments = {}; 

// Bucle de emparejamiento y control de tiempo global cada 2 segundos
setInterval(() => {
  const now = Date.now();

  for (const code in tournaments) {
    const t = tournaments[code];
    
    // --- COMPROBAR FIN DEL TORNEO ---
    if (t.active && t.endTime && now >= t.endTime) {
      t.active = false;
      t.finished = true;
      t.activeMatches = {}; // Las partidas en juego se cancelan y no suman puntos

      // Calcular clasificación definitiva
      const standings = getSortedStandings(t);
      io.to(`lobby_${code}`).emit('tournament-ended', { standings });
      continue;
    }

    if (!t.active) continue;

    // Filtrar jugadores esperando rival
    let waitingPlayers = Object.values(t.players).filter(p => p.status === 'waiting');
    if (waitingPlayers.length < 2) continue;

    waitingPlayers.sort(() => Math.random() - 0.5);

    for (let i = 0; i < waitingPlayers.length; i++) {
      for (let j = i + 1; j < waitingPlayers.length; j++) {
        let p1 = waitingPlayers[i];
        let p2 = waitingPlayers[j];

        if (p1.status !== 'waiting' || p2.status !== 'waiting') continue;

        let maxWaitTime = Math.max(now - p1.joinedQueueAt, now - p2.joinedQueueAt);
        let isConsecutive = (p1.lastOpponent === p2.id) || (p2.lastOpponent === p1.id);

        if (isConsecutive) {
          let waited5Min = maxWaitTime >= 300000;
          let onlyTwoLeft = (waitingPlayers.length === 2 && maxWaitTime >= 15000);
          if (!waited5Min && !onlyTwoLeft) continue;
        }

        const roomId = `match_${code}_${p1.id}_${p2.id}_${now}`;
        p1.status = 'playing';
        p2.status = 'playing';
        p1.lastOpponent = p2.id;
        p2.lastOpponent = p1.id;

        t.activeMatches[roomId] = { w: p1.name, b: p2.name, wId: p1.id, bId: p2.id, scored: false };

        const s1 = io.sockets.sockets.get(p1.id);
        const s2 = io.sockets.sockets.get(p2.id);

        if (s1 && s2) {
          s1.join(roomId);
          s2.join(roomId);

          s1.emit('match-found', { color: 'w', room: roomId, opponentName: p2.name, timeControl: t.matchTime });
          s2.emit('match-found', { color: 'b', room: roomId, opponentName: p1.name, timeControl: t.matchTime });
        }

        broadcastTournamentState(code);
        break;
      }
    }
  }
}, 2000);

function getSortedStandings(t) {
  return Object.values(t.players)
    .map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      wins: p.wins,
      draws: p.draws,
      losses: p.losses,
      status: p.status,
      isHost: p.id === t.hostId
    }))
    .sort((a, b) => b.score - a.score || b.wins - a.wins);
}

function broadcastTournamentState(code) {
  const t = tournaments[code];
  if (!t) return;
  io.to(`lobby_${code}`).emit('tournament-update', {
    standings: getSortedStandings(t),
    activeMatches: Object.values(t.activeMatches),
    active: t.active,
    finished: t.finished,
    endTime: t.endTime,
    matchTime: t.matchTime
  });
}

io.on('connection', (socket) => {
  
  socket.on('create-tournament', ({ code, hostName, durationMinutes, matchTimeMinutes }) => {
    const cleanCode = code.trim().toUpperCase();
    if (tournaments[cleanCode]) {
      return socket.emit('error-msg', 'Esa clave ya está en uso. Elige otra.');
    }

    tournaments[cleanCode] = {
      code: cleanCode,
      hostId: socket.id,
      duration: parseInt(durationMinutes),
      matchTime: parseInt(matchTimeMinutes),
      active: false,
      finished: false,
      endTime: null,
      players: {},
      activeMatches: {}
    };

    tournaments[cleanCode].players[socket.id] = {
      id: socket.id,
      name: hostName || 'Organizador',
      status: 'lobby',
      lastOpponent: null,
      joinedQueueAt: 0,
      score: 0, wins: 0, draws: 0, losses: 0
    };

    socket.tournamentCode = cleanCode;
    socket.join(`lobby_${cleanCode}`);
    socket.emit('tournament-joined', { code: cleanCode, isHost: true });
    broadcastTournamentState(cleanCode);
  });

  socket.on('join-tournament', ({ code, playerName }) => {
    const cleanCode = code.trim().toUpperCase();
    const t = tournaments[cleanCode];
    if (!t) return socket.emit('error-msg', 'No existe ningún torneo con esa clave.');
    if (t.finished) return socket.emit('error-msg', 'Este torneo ya ha terminado.');

    t.players[socket.id] = {
      id: socket.id,
      name: playerName || 'Jugador',
      status: t.active ? 'waiting' : 'lobby',
      lastOpponent: null,
      joinedQueueAt: Date.now(),
      score: 0, wins: 0, draws: 0, losses: 0
    };

    socket.tournamentCode = cleanCode;
    socket.join(`lobby_${cleanCode}`);
    socket.emit('tournament-joined', { code: cleanCode, isHost: false });
    broadcastTournamentState(cleanCode);
  });

  socket.on('start-tournament', (code) => {
    const t = tournaments[code];
    if (!t || t.hostId !== socket.id) return;

    t.active = true;
    t.endTime = Date.now() + (t.duration * 60000);
    
    for (const id in t.players) {
      t.players[id].status = 'waiting';
      t.players[id].joinedQueueAt = Date.now();
    }

    broadcastTournamentState(code);
  });

  // --- REGISTRO OFICIAL DE PUNTOS ---
  socket.on('report-result', ({ code, room, result }) => {
    const t = tournaments[code];
    // Si el torneo ya terminó, las partidas en curso NO puntúan
    if (!t || !t.active || t.finished) return;

    const match = t.activeMatches[room];
    if (!match || match.scored) return; // Evita duplicar puntos si ambos clientes reportan

    match.scored = true;
    const pW = t.players[match.wId];
    const pB = t.players[match.bId];

    if (result === 'w') {
      if (pW) { pW.score += 2; pW.wins += 1; }
      if (pB) { pB.losses += 1; }
    } else if (result === 'b') {
      if (pB) { pB.score += 2; pB.wins += 1; }
      if (pW) { pW.losses += 1; }
    } else if (result === 'draw') {
      if (pW) { pW.score += 1; pW.draws += 1; }
      if (pB) { pB.score += 1; pB.draws += 1; }
    }

    broadcastTournamentState(code);
  });

  socket.on('return-to-arena', ({ code, room }) => {
    const t = tournaments[code];
    if (!t) return;

    if (room && t.activeMatches[room]) {
      delete t.activeMatches[room];
    }

    if (t.players[socket.id]) {
      t.players[socket.id].status = t.active ? 'waiting' : 'lobby';
      t.players[socket.id].joinedQueueAt = Date.now();
    }
    broadcastTournamentState(code);
  });

  socket.on('make-move', (data) => socket.to(data.room).emit('move-received', data));
  socket.on('resign', (room) => socket.to(room).emit('resign'));
  socket.on('timeout', (data) => socket.to(data.room).emit('timeout', data));
  socket.on('draw-offer', (room) => socket.to(room).emit('draw-offer'));
  socket.on('draw-agreed', (room) => socket.to(room).emit('draw-agreed'));

  socket.on('disconnecting', () => {
    const code = socket.tournamentCode;
    if (code && tournaments[code]) {
      const t = tournaments[code];
      delete t.players[socket.id];
      
      for (const room in t.activeMatches) {
        if (t.activeMatches[room].wId === socket.id || t.activeMatches[room].bId === socket.id) {
          delete t.activeMatches[room];
          socket.to(room).emit('opponent-disconnected');
        }
      }
      broadcastTournamentState(code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor Arena con Clasificación corriendo en puerto ${PORT}`));
