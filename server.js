const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Almacén de torneos activos (cada clave de acceso es un torneo distinto)
let tournaments = {}; 

// Bucle de emparejamiento cada 3 segundos para TODOS los torneos activos
setInterval(() => {
  const now = Date.now();

  for (const code in tournaments) {
    const t = tournaments[code];
    
    // Comprobar si el tiempo global del torneo ya terminó
    if (t.active && t.endTime && now >= t.endTime) {
      t.active = false;
      io.to(`lobby_${code}`).emit('tournament-ended');
      continue;
    }

    if (!t.active) continue;

    // Filtrar jugadores que están esperando rival en este torneo
    let waitingPlayers = Object.values(t.players).filter(p => p.status === 'waiting');
    if (waitingPlayers.length < 2) continue;

    // Mezclar aleatoriamente para variar emparejamientos
    waitingPlayers.sort(() => Math.random() - 0.5);

    for (let i = 0; i < waitingPlayers.length; i++) {
      for (let j = i + 1; j < waitingPlayers.length; j++) {
        let p1 = waitingPlayers[i];
        let p2 = waitingPlayers[j];

        if (p1.status !== 'waiting' || p2.status !== 'waiting') continue;

        let maxWaitTime = Math.max(now - p1.joinedQueueAt, now - p2.joinedQueueAt);
        let isConsecutive = (p1.lastOpponent === p2.id) || (p2.lastOpponent === p1.id);

        // Regla anti-repetición: evitar mismo rival salvo 5 min de espera o si son los únicos 2
        if (isConsecutive) {
          let waited5Min = maxWaitTime >= 300000;
          let onlyTwoLeft = (waitingPlayers.length === 2 && maxWaitTime >= 15000); // 15s si no hay nadie más
          if (!waited5Min && !onlyTwoLeft) continue;
        }

        // ¡Emparejar!
        const roomId = `match_${code}_${p1.id}_${p2.id}_${now}`;
        p1.status = 'playing';
        p2.status = 'playing';
        p1.lastOpponent = p2.id;
        p2.lastOpponent = p1.id;

        t.activeMatches[roomId] = { w: p1.name, b: p2.name, wId: p1.id, bId: p2.id };

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
}, 3000);

function broadcastTournamentState(code) {
  const t = tournaments[code];
  if (!t) return;
  io.to(`lobby_${code}`).emit('tournament-update', {
    players: Object.values(t.players).map(p => ({ id: p.id, name: p.name, status: p.status, isHost: p.id === t.hostId })),
    activeMatches: Object.values(t.activeMatches),
    active: t.active,
    endTime: t.endTime,
    matchTime: t.matchTime
  });
}

io.on('connection', (socket) => {
  
  // 1. CREAR TORNEO ARENA
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
      endTime: null,
      players: {},
      activeMatches: {}
    };

    // Unir al creador al torneo
    tournaments[cleanCode].players[socket.id] = {
      id: socket.id,
      name: hostName || 'Organizador',
      status: 'lobby',
      lastOpponent: null,
      joinedQueueAt: 0
    };

    socket.tournamentCode = cleanCode;
    socket.join(`lobby_${cleanCode}`);
    socket.emit('tournament-joined', { code: cleanCode, isHost: true });
    broadcastTournamentState(cleanCode);
  });

  // 2. UNIRSE A TORNEO CON CLAVE
  socket.on('join-tournament', ({ code, playerName }) => {
    const cleanCode = code.trim().toUpperCase();
    const t = tournaments[cleanCode];
    if (!t) {
      return socket.emit('error-msg', 'No existe ningún torneo con esa clave.');
    }

    t.players[socket.id] = {
      id: socket.id,
      name: playerName || 'Jugador',
      status: t.active ? 'waiting' : 'lobby',
      lastOpponent: null,
      joinedQueueAt: Date.now()
    };

    socket.tournamentCode = cleanCode;
    socket.join(`lobby_${cleanCode}`);
    socket.emit('tournament-joined', { code: cleanCode, isHost: false });
    broadcastTournamentState(cleanCode);
  });

  // 3. ARRANCAR EL TORNEO (SOLO ORGANIZADOR)
  socket.on('start-tournament', (code) => {
    const t = tournaments[code];
    if (!t || t.hostId !== socket.id) return;

    t.active = true;
    t.endTime = Date.now() + (t.duration * 60000);
    
    // Poner a todos en cola de búsqueda
    for (const id in t.players) {
      t.players[id].status = 'waiting';
      t.players[id].joinedQueueAt = Date.now();
    }

    broadcastTournamentState(code);
  });

  // 4. VOLVER A LA COLA TRAS ACABAR PARTIDA
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

  // 5. RETRANSMISIÓN DE JUGADAS
  socket.on('make-move', (data) => socket.to(data.room).emit('move-received', data));
  socket.on('resign', (room) => socket.to(room).emit('resign'));
  socket.on('timeout', (data) => socket.to(data.room).emit('timeout', data));
  socket.on('draw-offer', (room) => socket.to(room).emit('draw-offer'));
  socket.on('draw-agreed', (room) => socket.to(room).emit('draw-agreed'));

  // DESCONEXIÓN
  socket.on('disconnecting', () => {
    const code = socket.tournamentCode;
    if (code && tournaments[code]) {
      const t = tournaments[code];
      delete t.players[socket.id];
      
      // Limpiar partidas donde estuviera este jugador
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
server.listen(PORT, () => console.log(`Servidor Arena corriendo en puerto ${PORT}`));
