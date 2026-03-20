const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const { Pool }   = require('pg');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');

// ── Env assertions ─────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET)    throw new Error('Missing env var: JWT_SECRET');
if (!process.env.DATABASE_URL)  throw new Error('Missing env var: DATABASE_URL');

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Schema migration ───────────────────────────────────────────────────────
async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      VARCHAR(50) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id            SERIAL PRIMARY KEY,
      player1_id    INTEGER NOT NULL REFERENCES users(id),
      player2_id    INTEGER NOT NULL REFERENCES users(id),
      winner_id     INTEGER REFERENCES users(id),
      player1_score INTEGER NOT NULL,
      player2_score INTEGER NOT NULL,
      played_at     TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT winner_is_participant CHECK (
        winner_id IS NULL OR winner_id = player1_id OR winner_id = player2_id
      )
    )
  `);
  console.log('✅  DB migration complete');
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout:  20000,   // disconnect if no pong within 20s
  pingInterval: 10000,   // ping every 10s — keeps Railway proxy alive
});

// Serve all static files from this directory
app.use(express.static(path.join(__dirname)));

app.use(express.json());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// ── Auth REST endpoints ────────────────────────────────────────────────────
app.post('/api/register', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });
  if (typeof username !== 'string' || username.trim().length === 0)
    return res.status(400).json({ error: 'invalid username' });
  if (typeof password !== 'string' || password.length < 6 || password.length > 72)
    return res.status(400).json({ error: 'password must be 6–72 characters' });

  const name = username.trim().slice(0, 50);
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [name, hash]
    );
    const user  = result.rows[0];
    const token = jwt.sign({ userId: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    console.error('register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });
  if (typeof password !== 'string' || password.length > 72)
    return res.status(400).json({ error: 'Invalid username or password' });

  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    const user   = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid username or password' });

    const token = jwt.sign({ userId: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Head-to-head stats endpoint ────────────────────────────────────────────
app.get('/api/h2h', apiLimiter, requireAuth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const result = await db.query(`
      WITH h2h AS (
        SELECT
          opponent_id,
          SUM(CASE WHEN is_win  THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN is_loss THEN 1 ELSE 0 END) AS losses,
          SUM(CASE WHEN is_draw THEN 1 ELSE 0 END) AS draws,
          MAX(played_at) AS last_played
        FROM (
          SELECT
            player2_id AS opponent_id,
            (winner_id IS NOT NULL AND winner_id = $1) AS is_win,
            (winner_id IS NOT NULL AND winner_id != $1) AS is_loss,
            (winner_id IS NULL) AS is_draw,
            played_at
          FROM matches WHERE player1_id = $1
          UNION ALL
          SELECT
            player1_id AS opponent_id,
            (winner_id IS NOT NULL AND winner_id = $1) AS is_win,
            (winner_id IS NOT NULL AND winner_id != $1) AS is_loss,
            (winner_id IS NULL) AS is_draw,
            played_at
          FROM matches WHERE player2_id = $1
        ) sub
        GROUP BY opponent_id
      )
      SELECT
        h2h.wins::int,
        h2h.losses::int,
        h2h.draws::int,
        h2h.last_played AS "lastPlayed",
        COALESCE(u.username, '[deleted]') AS "opponentName"
      FROM h2h
      LEFT JOIN users u ON u.id = h2h.opponent_id
      ORDER BY h2h.last_played DESC
    `, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error('h2h error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── In-memory room store ───────────────────────────────────────────────────
const rooms = {};

function makeCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function cleanRoom(code) {
  const room = rooms[code];
  if (!room) return;
  clearInterval(room.interval);
  room.interval = null;
  delete rooms[code];
}

// ── Start the countdown for a room ────────────────────────────────────────
// Captures `code` as a local string — safe even if the triggering socket
// later disconnects or changes rooms.
function startTimer(code) {
  const room = rooms[code];
  if (!room) return;

  // Safety: never run two intervals on the same room
  if (room.interval) {
    clearInterval(room.interval);
    room.interval = null;
  }

  room.interval = setInterval(() => {
    const r = rooms[code];
    if (!r) { clearInterval(room.interval); return; } // room was deleted

    r.timeLeft = Math.max(0, r.timeLeft - 1);
    io.to(code).emit('timer_tick', { timeLeft: r.timeLeft });

    if (r.timeLeft === 0) {
      clearInterval(r.interval);
      r.interval = null;
      io.to(code).emit('game_over', { scores: r.scores });
    }
  }, 1000);
}

// ── Socket events ──────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  // ── Create a new room ────────────────────────────────────────────────────
  socket.on('create_room', ({ name }) => {
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

    socket.emit('room_created', { code, seed: rooms[code].seed, playerIdx: 0 });
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
    io.to(key).emit('players_joined', { names: room.names, ready: room.ready });
  });

  // ── Player signals ready ───────────────────────────────────────────────────
  socket.on('player_ready', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.started) return;

    room.ready[socket.playerIdx] = true;
    io.to(code).emit('ready_update', { ready: [...room.ready] });

    if (room.ready[0] && room.ready[1]) {
      room.started = true;
      io.to(code).emit('game_start', { seed: room.seed, names: room.names });
      startTimer(code);
    }
  });

  // ── Rematch request ───────────────────────────────────────────────────────
  socket.on('rematch_request', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;

    if (!room.rematch) room.rematch = [false, false];
    room.rematch[socket.playerIdx] = true;
    io.to(code).emit('rematch_update', { rematch: [...room.rematch] });

    if (room.rematch[0] && room.rematch[1]) {
      room.seed     = Math.floor(Math.random() * 0xFFFFFFFF);
      room.scores   = [0, 0];
      room.timeLeft = 300;
      room.rematch  = [false, false];

      io.to(code).emit('game_start', { seed: room.seed, names: room.names });
      startTimer(code);
    }
  });

  // ── Score update from a player ────────────────────────────────────────────
  socket.on('score_update', ({ score }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;

    room.scores[socket.playerIdx] = score;
    io.to(code).emit('scores_update', { scores: [...room.scores] });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    const code = socket.roomCode;
    if (!rooms[code]) return;

    io.to(code).emit('opponent_left');
    cleanRoom(code);
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
migrate().then(() => {
  server.listen(PORT, () => {
    console.log(`\n✅  Server running → http://localhost:${PORT}`);
    console.log(`   Open online.html via http://localhost:${PORT}/online.html\n`);
  });
}).catch(err => { console.error('Migration failed:', err); process.exit(1); });
