# Leaderboard & Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add username/password accounts and head-to-head match history to the multiplayer solitaire game, with accounts required to play.

**Architecture:** New npm packages (`pg`, `bcrypt`, `jsonwebtoken`, `express-rate-limit`) are added to the existing single-process Express+Socket.io server. Two new DB tables (`users`, `matches`) are created on startup via idempotent DDL. Three REST endpoints handle auth and H2H queries; Socket.io connection auth is enforced via a middleware. The `online.html` single-file React app gets a new auth screen, leaderboard screen, and small additions to existing screens.

**Tech Stack:** Node.js, Express, Socket.io v4, PostgreSQL via `pg`, `bcrypt` (cost 10), `jsonwebtoken` (7d TTL), `express-rate-limit`, React 18 (CDN/Babel, no build step)

---

## File Map

| File | Action | What changes |
|------|--------|--------------|
| `server.js` | Modify | Add DB pool, startup assertions, schema migration, auth REST endpoints, Socket.io auth middleware, match save on game_over |
| `online.html` | Modify | Add JWT decode helper, auth screen, leaderboard screen, update socket init, remove name field from lobby, add logout + My Record, update game over with H2H line |
| `package.json` | Modify | Add 4 new dependencies |

No new files. All server logic stays in `server.js`; all frontend logic stays in `online.html`.

---

## Task 1: Install New Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install packages**

```bash
cd "/home/lucasmhefner/SOL 2"
npm install pg bcrypt jsonwebtoken express-rate-limit
```

- [ ] **Step 2: Verify package.json has all four**

```bash
node -e "require('pg'); require('bcrypt'); require('jsonwebtoken'); require('express-rate-limit'); console.log('all ok')"
```

Expected output: `all ok`

- [ ] **Step 3: Commit**

```bash
cd "/home/lucasmhefner/SOL 2"
git add package.json package-lock.json
git commit -m "feat: install pg, bcrypt, jsonwebtoken, express-rate-limit"
```

---

## Task 2: DB Connection, Startup Assertions & Schema Migration

**Files:**
- Modify: `server.js` (top of file, before `io.on('connection', ...)`)

- [ ] **Step 1: Add env assertions, DB pool, and migration function**

At the very top of `server.js`, after the existing `require` statements and before `const app = express()`, insert:

```js
const { Pool } = require('pg');

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
```

- [ ] **Step 2: Call migrate before server.listen**

Find the existing `server.listen(PORT, ...)` call at the bottom of `server.js`. Wrap it so migration runs first:

```js
// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
migrate().then(() => {
  server.listen(PORT, () => {
    console.log(`\n✅  Server running → http://localhost:${PORT}`);
    console.log(`   Open online.html via http://localhost:${PORT}/online.html\n`);
  });
}).catch(err => { console.error('Migration failed:', err); process.exit(1); });
```

- [ ] **Step 3: Verify server starts (requires DATABASE_URL + JWT_SECRET set locally or via Railway)**

For local testing, set stub env vars and confirm assertions fire correctly when missing:

```bash
cd "/home/lucasmhefner/SOL 2"
node -e "process.env.DATABASE_URL='x'; require('./server.js')" 2>&1 | head -3
```

Expected: `Error: Missing env var: JWT_SECRET`

```bash
node -e "process.env.JWT_SECRET='x'; require('./server.js')" 2>&1 | head -3
```

Expected: `Error: Missing env var: DATABASE_URL`

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add DB pool, startup assertions, schema migration"
```

---

## Task 3: REST Auth Endpoints (register + login)

**Files:**
- Modify: `server.js` (add after `app.use(express.static(...))`)

- [ ] **Step 1: Add required requires and rate limiter at top of server.js**

Add these requires at the top with the other requires:

```js
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
```

Add the rate limiter and JSON body parser after `app.use(express.static(...))`:

```js
app.use(express.json());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
```

- [ ] **Step 2: Add /api/register**

```js
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
```

- [ ] **Step 3: Add /api/login**

```js
app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

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
```

- [ ] **Step 4: Test register with curl (requires server running with real DB)**

```bash
curl -s -X POST http://localhost:3000/api/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"testuser","password":"secret123"}' | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)))"
```

Expected: `{ token: '...', username: 'testuser' }`

- [ ] **Step 5: Test login**

```bash
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"testuser","password":"secret123"}' | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)))"
```

Expected: `{ token: '...', username: 'testuser' }`

- [ ] **Step 6: Test validation errors**

```bash
# Short password → 400
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/register \
  -H 'Content-Type: application/json' -d '{"username":"x","password":"abc"}'
# → 400

# Duplicate username → 409
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/register \
  -H 'Content-Type: application/json' -d '{"username":"testuser","password":"secret123"}'
# → 409

# Wrong password → 401
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' -d '{"username":"testuser","password":"wrongpass"}'
# → 401
```

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat: add /api/register and /api/login endpoints"
```

---

## Task 4: Add /api/h2h Endpoint

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add auth middleware helper**

Add this function before the h2h route:

```js
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
```

- [ ] **Step 2: Add /api/h2h**

```js
app.get('/api/h2h', requireAuth, async (req, res) => {
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
```

- [ ] **Step 3: Test h2h endpoint**

```bash
# Get token first
TOKEN=$(curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"testuser","password":"secret123"}' | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")

# Fetch h2h (empty array expected for new user)
curl -s http://localhost:3000/api/h2h -H "Authorization: Bearer $TOKEN"
```

Expected: `[]`

- [ ] **Step 4: Test missing auth → 401**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/h2h
```

Expected: `401`

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add /api/h2h endpoint with H2H query"
```

---

## Task 5: Socket.io Auth Middleware

**Files:**
- Modify: `server.js` (add before `io.on('connection', ...)`)

- [ ] **Step 1: Add Socket.io auth middleware**

Add this immediately before `io.on('connection', socket => {`:

```js
// ── Socket auth middleware ─────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('auth_required'));
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId   = decoded.userId;
    socket.username = decoded.username;
    next();
  } catch {
    next(new Error('auth_invalid'));
  }
});
```

- [ ] **Step 2: Understand how auth errors surface on the client**

When the Socket.io middleware calls `next(new Error(...))`, Socket.io fires a `connect_error` event on the client — **not** an `auth_error` event. The error message is available as `err.message`. We handle this in Task 9 via `socket.on('connect_error', ...)`. No server-side change needed beyond the middleware. Do not add a server-side `socket.emit('auth_error', ...)` call — the middleware rejection happens before the socket is accepted, so there is no socket to emit to.

- [ ] **Step 3: Update create_room to use socket.username instead of the name param**

Find the `socket.on('create_room', ...)` handler. Change the names assignment to use `socket.username`:

```js
socket.on('create_room', () => {
  if (socket.roomCode) cleanRoom(socket.roomCode);

  let code;
  do { code = makeCode(); } while (rooms[code]);

  rooms[code] = {
    code,
    players:  [socket.id],
    names:    [socket.username, ''],
    userIds:  [socket.userId, null],   // track DB user IDs for match saving
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
```

- [ ] **Step 4: Update join_room to use socket.username and store userId**

```js
socket.on('join_room', ({ code }) => {
  const key  = (code || '').toUpperCase().trim();
  const room = rooms[key];

  if (!room)                    return socket.emit('room_error', { msg: 'Room not found. Check the code and try again.' });
  if (room.players.length >= 2) return socket.emit('room_error', { msg: 'Room is full.' });
  if (room.started)             return socket.emit('room_error', { msg: 'Game already in progress.' });

  room.players.push(socket.id);
  room.names[1]   = socket.username;
  room.userIds[1] = socket.userId;
  room.ready      = [false, false];
  socket.join(key);
  socket.roomCode  = key;
  socket.playerIdx = 1;

  socket.emit('room_joined', { code: room.code, seed: room.seed, playerIdx: 1 });
  io.to(key).emit('players_joined', { names: room.names, ready: room.ready });
});
```

Note: `join_room` no longer accepts a `name` param — name comes from the JWT.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add Socket.io JWT auth middleware, use username from token"
```

---

## Task 6: Save Match Result on game_over

**Files:**
- Modify: `server.js` (inside `startTimer`)

- [ ] **Step 1: Add saveMatch helper function**

Add this function before `startTimer`:

```js
// saveMatch checks out a dedicated client from the pool and returns it alongside
// the saved IDs so that getH2H can reuse the same connection (read-after-write safety).
async function saveMatch(room) {
  const [p1Id, p2Id] = room.userIds;
  if (!p1Id || !p2Id) return null;  // safety: both players must be authenticated

  const [s0, s1] = room.scores;
  let winnerId = null;
  if (s0 > s1) winnerId = p1Id;
  else if (s1 > s0) winnerId = p2Id;
  // NULL = draw (scores equal)

  const client = await db.connect();
  try {
    const result = await client.query(
      `INSERT INTO matches (player1_id, player2_id, winner_id, player1_score, player2_score)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [p1Id, p2Id, winnerId, s0, s1]
    );
    console.log('Match saved, id:', result.rows[0].id);
    return { p1Id, p2Id, winnerId, client };  // caller must release client
  } catch (err) {
    client.release();
    console.error('Failed to save match:', err);
    return null;
  }
}
```

- [ ] **Step 2: Add getH2H helper function**

`getH2H` must use the **same pool client** that `saveMatch` used, so the SELECT is guaranteed to see the just-inserted row (read-after-write on the same connection). Pass the client in from `saveMatch`.

```js
async function getH2H(client, userId, opponentId) {
  try {
    const result = await client.query(`
      SELECT
        SUM(CASE WHEN (winner_id IS NOT NULL AND winner_id = $1) THEN 1 ELSE 0 END)::int AS wins,
        SUM(CASE WHEN (winner_id IS NOT NULL AND winner_id != $1) THEN 1 ELSE 0 END)::int AS losses,
        SUM(CASE WHEN winner_id IS NULL THEN 1 ELSE 0 END)::int AS draws
      FROM matches
      WHERE (player1_id = $1 AND player2_id = $2)
         OR (player1_id = $2 AND player2_id = $1)
    `, [userId, opponentId]);
    return result.rows[0];
  } catch (err) {
    console.error('getH2H error:', err);
    return null;
  }
}
```

- [ ] **Step 3: Update startTimer to save match and emit h2h_update**

Find the block inside `startTimer` that runs when `r.timeLeft === 0`:

```js
if (r.timeLeft === 0) {
  clearInterval(r.interval);
  r.interval = null;
  io.to(code).emit('game_over', { scores: r.scores });

  // Save match and emit H2H update (same DB client for read-after-write safety)
  saveMatch(r).then(async saved => {
    if (!saved) return;
    const { p1Id, p2Id, client } = saved;
    const room = rooms[code];  // room may be gone if both disconnected; that's ok

    try {
      // Emit h2h_update to each player individually
      const sockets = await io.in(code).fetchSockets();
      for (const s of sockets) {
        const opponentId = s.userId === p1Id ? p2Id : p1Id;
        const opponentName = s.userId === p1Id
          ? (room?.names[1] ?? 'Opponent')
          : (room?.names[0] ?? 'Opponent');
        const h2h = await getH2H(client, s.userId, opponentId);
        if (h2h) {
          s.emit('h2h_update', { ...h2h, opponentName });
        }
      }
    } finally {
      client.release();  // always return the client to the pool
    }
  });
}
```

- [ ] **Step 4: Verify by playing a game to completion (manual test)**

Start server, open two browser tabs, play until timer expires, confirm in server logs:
```
Match saved, id: 1
```

- [ ] **Step 5: Verify h2h data appears after game**

After a game completes, check the h2h endpoint:
```bash
curl -s http://localhost:3000/api/h2h -H "Authorization: Bearer $TOKEN"
```

Expected: array with one entry showing the opponent, wins/losses/draws.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: save match to DB on game_over, emit h2h_update"
```

---

## Task 7: Frontend — JWT Decode Helper & App Auth State

**Files:**
- Modify: `online.html` (inside the `<script type="text/babel">` block, near the top)

- [ ] **Step 1: Add JWT decode helper at top of script block (after the constants)**

Add immediately after the `const fmt = ...` line:

```js
// ── JWT helpers ───────────────────────────────────────────────────────────
function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

function getStoredAuth() {
  const token = localStorage.getItem('sol_token');
  if (!token) return null;
  const decoded = decodeJwt(token);
  if (!decoded || decoded.exp * 1000 < Date.now()) {
    localStorage.removeItem('sol_token');
    return null;
  }
  return { token, userId: decoded.userId, username: decoded.username };
}
```

- [ ] **Step 2: Update App() initial state to check stored auth**

In the `App()` function, update the `useState` initializations:

```js
const [auth,        setAuth]        = useState(() => getStoredAuth());
```

Add `auth` to the list (e.g. after `const [error, setError] = useState('')`).

- [ ] **Step 3: Add logout function to App()**

```js
const logout = () => {
  localStorage.removeItem('sol_token');
  setAuth(null);  // auth guard renders AuthScreen when auth is null — no setScreen needed
  if (socketRef.current) {
    socketRef.current.disconnect();
    socketRef.current = null;
  }
  setError('');
};
```

Note: do **not** call `setScreen('lobby')` here. The `if (!auth) return <AuthScreen />` guard at the top of the render function shows the auth screen whenever `auth` is null, regardless of the `screen` value. Adding `setScreen('lobby')` would be a no-op (the lobby never renders while unauthenticated) and leaves a confusing stale screen value.

- [ ] **Step 4: Commit**

```bash
git add online.html
git commit -m "feat: add JWT decode helper and auth state to App"
```

---

## Task 8: Frontend — Auth Screen Component

**Files:**
- Modify: `online.html`

- [ ] **Step 1: Add AuthScreen component**

Add this component before `LobbyScreen`:

```jsx
// ── Auth screen ───────────────────────────────────────────────────────────
function AuthScreen({ onAuth }) {
  const [tab,      setTab]      = React.useState('login');
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error,    setError]    = React.useState('');
  const [loading,  setLoading]  = React.useState(false);

  const inputStyle = {
    width:'100%', padding:'12px 16px', borderRadius:10,
    border:'2px solid rgba(255,255,255,.2)',
    background:'rgba(255,255,255,.1)', color:'#fff', fontSize:16,
    outline:'none', marginBottom:16,
  };

  const submit = async () => {
    if (!username.trim() || !password) return;
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/${tab}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Something went wrong'); setLoading(false); return; }
      localStorage.setItem('sol_token', data.token);
      onAuth({ token: data.token, username: data.username });
    } catch {
      setError('Network error. Please try again.'); setLoading(false);
    }
  };

  const onKey = e => { if (e.key === 'Enter') submit(); };

  return (
    <div style={{
      minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:'radial-gradient(ellipse at 50% 30%,#15803d,#14532d)',
    }}>
      <div style={{textAlign:'center', color:'#fff', padding:32, width:'100%', maxWidth:360}}>
        <div style={{fontSize:56, marginBottom:8}}>♠</div>
        <h1 style={{fontSize:32, fontWeight:800, marginBottom:4, letterSpacing:1}}>Solitaire</h1>
        <p style={{color:'rgba(255,255,255,.5)', marginBottom:32, fontSize:15}}>Online Multiplayer</p>

        {/* Tabs */}
        <div style={{display:'flex', marginBottom:28, background:'rgba(0,0,0,.2)', borderRadius:10, padding:4}}>
          {['login','register'].map(t => (
            <button key={t} onClick={() => { setTab(t); setError(''); }} style={{
              flex:1, padding:'10px 0', border:'none', borderRadius:8, fontSize:14, fontWeight:700, cursor:'pointer',
              background: tab === t ? '#fff' : 'transparent',
              color: tab === t ? '#166534' : 'rgba(255,255,255,.6)',
              transition:'all .15s',
            }}>
              {t === 'login' ? 'Log In' : 'Sign Up'}
            </button>
          ))}
        </div>

        <input
          value={username} onChange={e => setUsername(e.target.value)} onKeyDown={onKey}
          placeholder="Username" maxLength={50} style={inputStyle}
        />
        <input
          type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={onKey}
          placeholder="Password" style={{...inputStyle, marginBottom: error ? 8 : 24}}
        />

        {error && <div style={{color:'#f87171', fontSize:13, marginBottom:16, fontWeight:600}}>{error}</div>}

        <button onClick={submit} disabled={loading || !username.trim() || !password} style={{
          display:'block', width:'100%', padding:'14px 0',
          background: (!loading && username.trim() && password) ? '#16a34a' : 'rgba(255,255,255,.15)',
          color:'#fff', border:'none', borderRadius:12, fontSize:17, fontWeight:700,
          cursor: (!loading && username.trim() && password) ? 'pointer' : 'default',
          boxShadow: (!loading && username.trim() && password) ? '0 4px 16px rgba(0,0,0,.3)' : 'none',
          transition:'all .15s',
        }}>
          {loading ? '…' : tab === 'login' ? 'Log In' : 'Sign Up'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire AuthScreen into App rendering**

In `App()`, add auth guard at the top of the render section (before the `if (screen === 'lobby')` block):

```js
if (!auth) {
  return <AuthScreen onAuth={newAuth => {
    setAuth(newAuth);
    setScreen('lobby');
  }} />;
}
```

- [ ] **Step 3: Verify auth screen appears on fresh load**

Open browser at `http://localhost:3000/online.html` in a private window (no localStorage). Should see the auth screen. Register a new user. Should proceed to lobby.

- [ ] **Step 4: Commit**

```bash
git add online.html
git commit -m "feat: add AuthScreen component with login/signup tabs"
```

---

## Task 9: Frontend — Update Socket Initialization

**Files:**
- Modify: `online.html` (the `useEffect(() => { const socket = io(); ... })` block in App)

- [ ] **Step 1: Update socket creation to pass auth token and disable reconnection**

The socket is currently created inside a `useEffect` that runs once on mount. We need to move socket creation to be triggered by auth, not on mount. Replace the existing `useEffect` socket init:

```js
// Connect socket when auth is available
useEffect(() => {
  if (!auth) return;  // don't connect until logged in

  const socket = io({ reconnection: false, auth: { token: auth.token } });
  socketRef.current = socket;

  socket.on('connect_error', (err) => {
    // Middleware rejection (auth_required / auth_invalid) surfaces here as connect_error.
    // No auth_error event is emitted — the socket was never admitted.
    if (err.message === 'auth_required' || err.message === 'auth_invalid') {
      localStorage.removeItem('sol_token');
      setAuth(null);
    }
  });

  // ... (all existing socket event handlers unchanged) ...

  return () => socket.disconnect();
}, [auth?.token]);   // depend on token string, not auth object reference, to avoid
                     // reconnecting on every re-render that creates a new auth object
```

Keep all existing event handlers (`room_created`, `room_joined`, `players_joined`, etc.) inside this same useEffect — they do not change.

- [ ] **Step 2: Add h2h_update listener**

Add inside the same useEffect, alongside the other socket.on calls:

```js
socket.on('h2h_update', (data) => {
  setH2h(data);
});
```

And add `h2h` state in App:

```js
const [h2h, setH2h] = useState(null);
```

Reset it when a new game starts (in the `game_start` handler):

```js
socket.on('game_start', ({ seed, names }) => {
  setSeed(seed);
  setNames(names);
  setTimeLeft(300);
  setScores([0, 0]);
  setH2h(null);   // reset H2H for new game
  setScreen('playing');
});
```

- [ ] **Step 3: Update create_room and join_room calls — remove the name param**

Since the server now gets the username from the JWT, update these:

```js
const createRoom = () => {
  setError('');
  socketRef.current?.emit('create_room');   // no name param
};

const joinRoom = () => {
  if (!joinCode.trim()) return;
  setError('');
  socketRef.current?.emit('join_room', { code: joinCode.trim() });  // no name param
};
```

- [ ] **Step 4: Commit**

```bash
git add online.html
git commit -m "feat: update socket init with JWT auth, add h2h_update listener"
```

---

## Task 10: Frontend — Update Lobby Screen

**Files:**
- Modify: `online.html` (LobbyScreen component and App rendering)

- [ ] **Step 1: Update LobbyScreen to remove name field, add logout + My Record**

Replace the `LobbyScreen` component signature and body:

```jsx
function LobbyScreen({ username, onCreate, onJoin, joinCode, setJoinCode, error, onLogout, onLeaderboard }) {
  return (
    <div style={{
      minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:'radial-gradient(ellipse at 50% 30%,#15803d,#14532d)',
    }}>
      <div style={{textAlign:'center', color:'#fff', padding:32, width:'100%', maxWidth:360}}>
        {/* Header with username and logout */}
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24}}>
          <span style={{fontSize:14, color:'rgba(255,255,255,.6)'}}>
            Logged in as <strong style={{color:'#fff'}}>{username}</strong>
          </span>
          <button onClick={onLogout} style={{
            padding:'6px 14px', background:'rgba(255,255,255,.1)', color:'rgba(255,255,255,.7)',
            border:'1px solid rgba(255,255,255,.15)', borderRadius:8, fontSize:12, cursor:'pointer',
          }}>
            Log Out
          </button>
        </div>

        <div style={{fontSize:56, marginBottom:8}}>♠</div>
        <h1 style={{fontSize:32, fontWeight:800, marginBottom:4, letterSpacing:1}}>Solitaire</h1>
        <p style={{color:'rgba(255,255,255,.5)', marginBottom:32, fontSize:15}}>Online Multiplayer</p>

        <button onClick={onCreate} style={{
          display:'block', width:'100%', padding:'14px 0',
          background:'#16a34a', color:'#fff', border:'none',
          borderRadius:12, fontSize:17, fontWeight:700,
          cursor:'pointer', marginBottom:20,
          boxShadow:'0 4px 16px rgba(0,0,0,.3)', transition:'all .15s',
        }}>
          Create Game
        </button>

        <div style={{color:'rgba(255,255,255,.3)', marginBottom:16, fontSize:13}}>— or join with a code —</div>

        <div style={{display:'flex', gap:8, marginBottom:20}}>
          <input
            value={joinCode}
            onChange={e => setJoinCode(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && joinCode.trim() && onJoin()}
            placeholder="Code"
            maxLength={4}
            style={{
              flex:1, padding:'12px 16px', borderRadius:10, border:'2px solid rgba(255,255,255,.2)',
              background:'rgba(255,255,255,.1)', color:'#fff', fontSize:20,
              fontWeight:800, textAlign:'center', letterSpacing:4, outline:'none',
            }}
          />
          <button onClick={onJoin} disabled={!joinCode.trim()} style={{
            padding:'12px 20px',
            background: joinCode.trim() ? '#2563eb' : 'rgba(255,255,255,.15)',
            color:'#fff', border:'none', borderRadius:10, fontSize:15, fontWeight:700,
            cursor: joinCode.trim() ? 'pointer' : 'default', transition:'all .15s',
          }}>
            Join
          </button>
        </div>

        <button onClick={onLeaderboard} style={{
          display:'block', width:'100%', padding:'11px 0',
          background:'rgba(255,255,255,.1)', color:'rgba(255,255,255,.8)',
          border:'1px solid rgba(255,255,255,.15)', borderRadius:12,
          fontSize:14, fontWeight:600, cursor:'pointer',
        }}>
          📊 My Record
        </button>

        {error && (
          <div style={{marginTop:16, color:'#f87171', fontSize:14, fontWeight:600}}>{error}</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update LobbyScreen usage in App render**

Find the `if (screen === 'lobby')` return and update it:

```js
if (screen === 'lobby') {
  return <LobbyScreen
    username={auth?.username ?? ''}
    onCreate={createRoom}
    onJoin={joinRoom}
    joinCode={joinCode}
    setJoinCode={setJoinCode}
    error={error}
    onLogout={logout}
    onLeaderboard={() => setScreen('leaderboard')}
  />;
}
```

- [ ] **Step 3: Remove orphaned playerName state from App()**

The existing `App()` has `const [playerName, setPlayerName] = useState('')` which was used to pass a name to `create_room` / `join_room`. With accounts, the name comes from the JWT. Remove these two lines from `App()`:

```js
// DELETE these two lines:
const [playerName,  setPlayerName]  = useState('');
```

Also remove `playerName` and `setPlayerName` from wherever they are passed as props (they were passed to `LobbyScreen` as `playerName` and `setPlayerName` — the new `LobbyScreen` signature does not accept them).

- [ ] **Step 4: Commit**

```bash
git add online.html
git commit -m "feat: update lobby - remove name field, add logout and My Record button"
```

---

## Task 11: Frontend — Leaderboard Screen

**Files:**
- Modify: `online.html`

- [ ] **Step 1: Add LeaderboardScreen component**

Add before `ReadyScreen`:

```jsx
// ── Leaderboard screen ────────────────────────────────────────────────────
function LeaderboardScreen({ token, username, onBack }) {
  const [records, setRecords] = React.useState(null);
  const [error,   setError]   = React.useState('');

  React.useEffect(() => {
    fetch('/api/h2h', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => Array.isArray(data) ? setRecords(data) : setError(data.error || 'Failed to load'))
      .catch(() => setError('Network error'));
  }, [token]);

  return (
    <div style={{
      minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:'radial-gradient(ellipse at 50% 30%,#15803d,#14532d)',
    }}>
      <div style={{color:'#fff', padding:32, width:'100%', maxWidth:420}}>
        <button onClick={onBack} style={{
          background:'none', border:'none', color:'rgba(255,255,255,.6)',
          fontSize:14, cursor:'pointer', marginBottom:20, padding:0,
        }}>
          ← Back to lobby
        </button>

        <div style={{textAlign:'center', marginBottom:28}}>
          <div style={{fontSize:40, marginBottom:8}}>📊</div>
          <h2 style={{fontSize:26, fontWeight:800, marginBottom:4}}>My Record</h2>
          <p style={{color:'rgba(255,255,255,.5)', fontSize:14}}>Head-to-head as {username}</p>
        </div>

        {!records && !error && (
          <div style={{textAlign:'center', color:'rgba(255,255,255,.5)', fontSize:14}}>Loading…</div>
        )}

        {error && (
          <div style={{textAlign:'center', color:'#f87171', fontSize:14}}>{error}</div>
        )}

        {records && records.length === 0 && (
          <div style={{textAlign:'center', color:'rgba(255,255,255,.4)', fontSize:15, marginTop:32}}>
            No games played yet.<br/>
            <span style={{fontSize:13}}>Complete a game to see your record here.</span>
          </div>
        )}

        {records && records.length > 0 && (
          <div style={{background:'rgba(0,0,0,.2)', borderRadius:16, overflow:'hidden'}}>
            {/* Header */}
            <div style={{display:'grid', gridTemplateColumns:'1fr 60px 60px 60px', padding:'12px 20px',
              background:'rgba(0,0,0,.2)', color:'rgba(255,255,255,.5)', fontSize:12, fontWeight:700,
              textTransform:'uppercase', letterSpacing:1}}>
              <span>Opponent</span>
              <span style={{textAlign:'center'}}>W</span>
              <span style={{textAlign:'center'}}>L</span>
              <span style={{textAlign:'center'}}>D</span>
            </div>
            {records.map((r, i) => (
              // React JSX expression slots ({r.opponentName}) use textContent internally —
              // they never call innerHTML, so XSS from usernames is not possible here.
              <div key={i} style={{
                display:'grid', gridTemplateColumns:'1fr 60px 60px 60px',
                padding:'14px 20px', borderTop:'1px solid rgba(255,255,255,.06)',
                alignItems:'center',
              }}>
                  <span style={{fontWeight:700, fontSize:15}}>{r.opponentName}</span>
                  <span style={{textAlign:'center', fontWeight:800, color:'#4ade80', fontSize:16}}>{r.wins}</span>
                  <span style={{textAlign:'center', fontWeight:800, color:'#f87171', fontSize:16}}>{r.losses}</span>
                  <span style={{textAlign:'center', fontWeight:800, color:'#fbbf24', fontSize:16}}>{r.draws}</span>
                </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire LeaderboardScreen into App**

Add the leaderboard screen render case in App, before `if (screen === 'waiting')`:

```js
if (screen === 'leaderboard') {
  return <LeaderboardScreen
    token={auth?.token ?? ''}
    username={auth?.username ?? ''}
    onBack={() => setScreen('lobby')}
  />;
}
```

- [ ] **Step 3: Verify leaderboard shows after completing a game**

1. Play two games with two accounts
2. Click "My Record" in the lobby
3. Confirm opponent row appears with correct W/L/D

- [ ] **Step 4: Commit**

```bash
git add online.html
git commit -m "feat: add LeaderboardScreen with H2H table"
```

---

## Task 12: Frontend — H2H Line on Game Over Screen

**Files:**
- Modify: `online.html` (GameOverScreen component + App passing h2h prop)

- [ ] **Step 1: Update GameOverScreen to accept and display h2h prop**

Add `h2h` to the GameOverScreen function signature and insert the H2H line after the scores display:

```jsx
function GameOverScreen({ myScore, oppScore, myName, oppName, rematch, playerIdx, onRematch, onNewGame, h2h }) {
```

Inside the return, after the scores `<div style={{display:'flex', gap:32...}}>...</div>` block, add:

```jsx
{h2h && (
  <div style={{
    fontSize:13, color:'#6b7280', marginBottom:16, fontWeight:500,
  }}>
    You're now{' '}
    <strong style={{color:'#166534'}}>{h2h.wins}–{h2h.losses}–{h2h.draws}</strong>
    {' '}vs.{' '}
    <strong>{h2h.opponentName}</strong>
  </div>
)}
```

- [ ] **Step 2: Pass h2h to GameOverScreen in App render**

Find the `<GameOverScreen .../>` usage and add the prop:

```jsx
<GameOverScreen
  myScore={myScore} oppScore={oppScore}
  myName={myName} oppName={oppName}
  rematch={rematchFlags}
  playerIdx={playerIdxRef.current}
  onRematch={requestRematch}
  onNewGame={goToLobby}
  h2h={h2h}
/>
```

- [ ] **Step 3: Reset h2h on new game / back to lobby**

In `goToLobby`:

```js
const goToLobby = () => {
  setScreen('lobby');
  setRoomCode('');
  setJoinCode('');
  setScores([0, 0]);
  setReadyFlags([false, false]);
  setH2h(null);   // add this line
  setError('');
};
```

- [ ] **Step 4: Verify H2H line appears on results screen after a full game**

Play a full game. After timer expires, results screen should show e.g. "You're now 1–0–0 vs. Lucas"

- [ ] **Step 5: Commit**

```bash
git add online.html
git commit -m "feat: show H2H record line on game over screen"
```

---

## Task 13: Railway Setup

**This task is performed manually in the Railway dashboard — no code changes.**

- [ ] **Step 1: Add PostgreSQL plugin**

1. Go to your Railway project dashboard
2. Click **+ New** → **Database** → **Add PostgreSQL**
3. Railway automatically sets `DATABASE_URL` on all services in the project

- [ ] **Step 2: Set JWT_SECRET env var**

1. In Railway, go to your web service → **Variables**
2. Add: `JWT_SECRET` = (generate a strong random string, e.g. `openssl rand -hex 32` in terminal)

- [ ] **Step 3: Deploy**

Push all committed changes to the branch Railway is watching:

```bash
cd "/home/lucasmhefner/SOL 2"
git push
```

- [ ] **Step 4: Verify deployed app**

1. Visit `https://solitaire-online-production.up.railway.app/online.html`
2. Should see auth screen (login/signup)
3. Register a new account → should proceed to lobby
4. Create a game, share code, second player joins and plays
5. After timer expires → results screen shows H2H line
6. Click "My Record" in lobby → shows table

---

## Quick Reference: Key Locations

| What | Where |
|------|-------|
| DB pool + migration | `server.js` top, `migrate()` function |
| Auth endpoints | `server.js` after `app.use(express.static(...))` |
| Socket auth middleware | `server.js` before `io.on('connection', ...)` |
| Match save logic | `server.js` `saveMatch()` + `getH2H()` |
| JWT decode helper | `online.html` `decodeJwt()` + `getStoredAuth()` |
| Auth screen | `online.html` `AuthScreen` component |
| Leaderboard screen | `online.html` `LeaderboardScreen` component |
| H2H line on results | `online.html` `GameOverScreen` `h2h` prop |
