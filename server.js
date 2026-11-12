const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Configuramos CORS para que el navegador permita la conexión
const io = new Server(server, { cors: { origin: "*" } });

let matchmakingQueue = []; // Cola de jugadores buscando partida

// Bucle de emparejamiento cada 3 segundos
setInterval(() => {
  if (matchmakingQueue.length < 2) return;
  const now = Date.now();

  for (let i = 0; i < matchmakingQueue.length; i++) {
    for (let j = i + 1; j < matchmakingQueue.length; j++) {
      let p1 = matchmakingQueue[i];
      let p2 = matchmakingQueue[j];
      
      let maxWaitTime = Math.max(now - p1.joinedAt, now - p2.joinedAt);
      let isConsecutiveOpponent = (p1.lastOpponent === p2.id) || (p2.lastOpponent === p1.id);

      // --- REGLA DE EMPAREJAMIENTO ---
      if (isConsecutiveOpponent) {
        let hasWaited5Minutes = maxWaitTime >= 300000; // 5 minutos
        let isOnlyOption = (matchmakingQueue.length === 2 && maxWaitTime >= 30000); // 30 segundos si son los únicos

        if (!hasWaited5Minutes && !isOnlyOption) {
          continue; // No cumplen la excepción, saltar a la siguiente posible pareja
        }
      }

      // Crear sala
      const roomId = `room_${p1.id}_${p2.id}`;
      
      // Actualizar el último rival para futuras búsquedas
      p1.lastOpponent = p2.id;
      p2.lastOpponent = p1.id;

      // Unir sockets a la sala
      p1.socket.join(roomId);
      p2.socket.join(roomId);

      // Asignar colores y notificar
      p1.socket.emit('match-found', { color: 'w', room: roomId, opponentId: p2.id });
      p2.socket.emit('match-found', { color: 'b', room: roomId, opponentId: p1.id });

      // Sacar a ambos de la cola
      matchmakingQueue.splice(j, 1);
      matchmakingQueue.splice(i, 1);
      
      return; // Romper el bucle actual
    }
  }
}, 3000);

io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId || socket.id;

  // El jugador busca partida
  socket.on('search-match', (data) => {
    if (!matchmakingQueue.find(p => p.id === userId)) {
      matchmakingQueue.push({
        id: userId,
        socket: socket,
        joinedAt: Date.now(),
        lastOpponent: data.lastOpponent || null
      });
    }
  });

  // Retransmisión de eventos del juego al rival en la misma sala
  socket.on('make-move', (data) => socket.to(data.room).emit('move-received', data));
  socket.on('resign', (room) => socket.to(room).emit('resign'));
  socket.on('timeout', (data) => socket.to(data.room).emit('timeout', data));
  socket.on('draw-offer', (room) => socket.to(room).emit('draw-offer'));
  socket.on('draw-agreed', (room) => socket.to(room).emit('draw-agreed'));

  // Cancelar búsqueda o gestionar desconexión
  socket.on('disconnecting', () => {
    matchmakingQueue = matchmakingQueue.filter(p => p.id !== userId);
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        socket.to(room).emit('opponent-disconnected');
      }
    }
  });
});

server.listen(3000, () => console.log('Servidor de Ajedrez corriendo en puerto 3000'));
