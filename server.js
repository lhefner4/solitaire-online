const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// Serve all static files (online.html, etc.) from this directory
app.use(express.static(path.join(__dirname)));

// ── In-memory room store ───────────────────────────────────────────────────
const rooms = {};

function makeCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function cleanRoom(code) {
  const room = rooms[code];
  if (!room) return;
  clearInterval(room.interval);
  delete rooms[code];
}

// ── Socket events ──────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  // ── Create a new room ────────────────────────────────────────────────────
  socket.on('create_room', ({ name }) => {
    // Leave any previous room
    if (socket.roomCode) cleanRoom(socket.roomCode);

    let code;
    do { code = makeCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      players:  [socket.id],
      names:    [name || 'Player 1', ''],
      seed:     Math.floor(Math.random() * 0xFFFFFFFF),
      scores:   [0, 0],
      timeLeft: 300,
      started:  false,
      interval: null,
    };

    socket.join(code);
    socket.roomCode  = code;
    socket.playerIdx = 0;

    socket.emit('room_created', {
      code,
      seed:      rooms[code].seed,
      playerIdx: 0,
    });
  });

  // ── Join an existing room ─────────────────────────────────────────────────
  socket.on('join_room', ({ code, name }) => {
    const key  = (code || '').toUpperCase().trim();
    const room = rooms[key];

    if (!room)                    return socket.emit('room_error', { msg: 'Room not found. Check the code and try again.' });
    if (room.players.length >= 2) return socket.emit('room_error', { msg: 'Room is full.' });
    if (room.started)             return socket.emit('room_error', { msg: 'Game already in progress.' });

    room.players.push(socket.id);
    room.names[1] = name || 'Player 2';
    room.ready    = [false, false];
    socket.join(key);
    socket.roomCode  = key;
    socket.playerIdx = 1;

    socket.emit('room_joined', { code: room.code, seed: room.seed, playerIdx: 1 });

    // Both players present — move to ready check (do NOT start timer yet)
    io.to(key).emit('players_joined', { names: room.names, ready: room.ready });
  });

  // ── Player signals ready ───────────────────────────────────────────────────
  socket.on('player_ready', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.started) return;

    room.ready[socket.playerIdx] = true;
    io.to(socket.roomCode).emit('ready_update', { ready: [...room.ready] });

    // Both ready — start the game
    if (room.ready[0] && room.ready[1]) {
      room.started = true;
      io.to(socket.roomCode).emit('game_start', { seed: room.seed, names: room.names });

      // Server-authoritative countdown
      room.interval = setInterval(() => {
        room.timeLeft = Math.max(0, room.timeLeft - 1);
        io.to(socket.roomCode).emit('timer_tick', { timeLeft: room.timeLeft });

        if (room.timeLeft === 0) {
          clearInterval(room.interval);
          room.interval = null;
          io.to(socket.roomCode).emit('game_over', { scores: room.scores });
        }
      }, 1000);
    }
  });

  // ── Rematch request ───────────────────────────────────────────────────────
  socket.on('rematch_request', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;

    if (!room.rematch) room.rematch = [false, false];
    room.rematch[socket.playerIdx] = true;
    io.to(socket.roomCode).emit('rematch_update', { rematch: [...room.rematch] });

    // Both want rematch — reset room and start a new game
    if (room.rematch[0] && room.rematch[1]) {
      clearInterval(room.interval);
      room.seed     = Math.floor(Math.random() * 0xFFFFFFFF);
      room.scores   = [0, 0];
      room.timeLeft = 300;
      room.rematch  = [false, false];

      io.to(socket.roomCode).emit('game_start', { seed: room.seed, names: room.names });

      room.interval = setInterval(() => {
        room.timeLeft = Math.max(0, room.timeLeft - 1);
        io.to(socket.roomCode).emit('timer_tick', { timeLeft: room.timeLeft });

        if (room.timeLeft === 0) {
          clearInterval(room.interval);
          room.interval = null;
          io.to(socket.roomCode).emit('game_over', { scores: room.scores });
        }
      }, 1000);
    }
  });

  // ── Score update from a player ────────────────────────────────────────────
  socket.on('score_update', ({ score }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;

    room.scores[socket.playerIdx] = score;
    io.to(socket.roomCode).emit('scores_update', { scores: [...room.scores] });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    const room = rooms[socket.roomCode];
    if (!room) return;

    io.to(socket.roomCode).emit('opponent_left');
    cleanRoom(socket.roomCode);
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅  Server running → http://localhost:${PORT}`);
  console.log(`   Open online.html via http://localhost:${PORT}/online.html\n`);
});
