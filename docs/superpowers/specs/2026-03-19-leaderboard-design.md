# Leaderboard & Accounts Design

**Date:** 2026-03-19
**Project:** Solitaire Online (SOL 2)
**Status:** Approved

## Overview

Add username/password accounts and head-to-head match history to the existing multiplayer solitaire game. **Accounts are required to play — there is no guest mode.** Players will see their win/loss/draw record against every opponent they've faced, both on the results screen and on a dedicated leaderboard page in the lobby.

## Stack Additions

- **Railway PostgreSQL** — added as a plugin inside the existing Railway project; connected via `DATABASE_URL` env var
- **`pg`** — Postgres client for Node.js (connection pool size: 10, the `pg` default)
- **`bcrypt`** — password hashing (cost factor 10)
- **`jsonwebtoken`** — JWT session tokens (TTL: 7 days) stored in browser `localStorage`
- **`express-rate-limit`** — rate limiting on auth endpoints

Everything continues to run as one Node.js process on Railway. No new deployments or external services.

## Startup Assertions

On startup, `server.js` must throw immediately if `process.env.JWT_SECRET` or `process.env.DATABASE_URL` is absent — preventing silent failures from misconfigured environments.

## Database Schema

```sql
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE matches (
  id            SERIAL PRIMARY KEY,
  player1_id    INTEGER NOT NULL REFERENCES users(id),
  player2_id    INTEGER NOT NULL REFERENCES users(id),
  winner_id     INTEGER REFERENCES users(id),  -- NULL = draw
  player1_score INTEGER NOT NULL,
  player2_score INTEGER NOT NULL,
  played_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT winner_is_participant CHECK (
    winner_id IS NULL OR winner_id = player1_id OR winner_id = player2_id
  )
);
```

**player1/player2 assignment:** `player1_id` is always the player who created the room (`playerIdx = 0`); `player2_id` is the player who joined (`playerIdx = 1`). Deterministic — matches the existing `playerIdx` in `create_room` / `join_room`.

**Draw definition:** A draw occurs when the timer expires (`timeLeft === 0`) and `scores[0] === scores[1]`. This is the only draw condition. The schema cannot enforce this invariant — the `winner_is_participant` constraint only ensures referential integrity. The application layer is solely responsible for writing `winner_id = NULL` only on genuine draws.

**`winner_id = NULL`** means draw. Otherwise it is set to the `userId` of the player with the higher score when the game ends.

**Disconnection / abandonment:** If a player disconnects mid-game, the existing `opponent_left` event fires and the room is cleaned up. **No match record is saved** for abandoned games. Only games that reach a natural end (timer expiry) produce a `matches` row.

H2H records are derived via query — no separate aggregation table needed.

### H2H Query Logic

Since a user can appear as either `player1_id` or `player2_id`, wins/losses/draws are computed with conditional aggregation:

```sql
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
ORDER BY last_played DESC;
```

The server resolves `opponent_id` → `username` by joining against `users` in the same query using a LEFT JOIN. If a user account has been deleted, the username falls back to `"[deleted]"`:

```sql
-- wrap the above as a CTE named `h2h`, then:
SELECT h2h.*, COALESCE(u.username, '[deleted]') AS opponent_name
FROM h2h
LEFT JOIN users u ON u.id = h2h.opponent_id;
```

## Migration Strategy

On server startup, `server.js` runs `CREATE TABLE IF NOT EXISTS` for both tables before accepting connections. This assumes a **fresh Railway PostgreSQL plugin**. If a prior incompatible schema exists, manual `DROP TABLE` is required before deploying. `CREATE TABLE IF NOT EXISTS` will silently no-op on existing tables, leaving a broken schema in place.

## REST API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/register` | None | `{ username, password }` → creates account, returns JWT |
| POST | `/api/login` | None | `{ username, password }` → verifies credentials, returns JWT |
| GET | `/api/h2h` | JWT required | Returns all H2H records for the authenticated user |

JWT is passed as `Authorization: Bearer <token>` header for the `/api/h2h` endpoint.

**Rate limiting:** `/api/register` and `/api/login` are limited to 10 requests per IP per 15 minutes via `express-rate-limit`.

**Password rules:** minimum 6 characters, maximum 72 characters (bcrypt's effective input limit). Enforced at `/api/register`; returns 400 with a descriptive message if violated.

### JWT Payload

```json
{ "userId": 42, "username": "Lucas" }
```

`exp` is set to `now + 7 days` by `jsonwebtoken` via `{ expiresIn: '7d' }`. The server reads `socket.handshake.auth.token`, verifies it, and attaches `decoded.userId` and `decoded.username` to the socket object.

### `/api/h2h` Response Shape

```json
[
  {
    "opponentName": "Lucas",
    "wins": 3,
    "losses": 1,
    "draws": 0,
    "lastPlayed": "2026-03-19T14:22:00Z"
  }
]
```

Array sorted by `lastPlayed` descending. Empty array `[]` if no matches played yet.

## Socket.io Changes

- **Socket creation:** the client creates the socket with `{ reconnection: false }` — auto-reconnect is disabled globally. All reconnection is managed manually by the application (only attempted after a successful re-login). This eliminates any reconnect storm risk on auth failure regardless of Socket.io version.

- **On connect:** client passes JWT in Socket.io auth handshake (`{ auth: { token } }`). Server verifies it and attaches `userId` and `username` to the socket. If the JWT is missing, invalid, or expired, the server emits `auth_error` with `{ msg: 'Please log in again' }`, then calls `socket.disconnect(true)`. The client handles `auth_error` by clearing `localStorage` and showing the auth screen.

- **Mid-session expiry:** on page load, the client decodes the JWT locally (base64-decodes the payload, no signature verification) to check `exp`. If expired or absent, it clears `localStorage` and shows the auth screen without attempting a socket connection.

- **`game_over` DB write ownership:** the existing server already manages the timer entirely server-side via a single `setInterval` in `startTimer()`. When `timeLeft === 0`, the server emits `game_over` and saves the match row in the same code path. No client event triggers the DB write. Duplicate writes are impossible by construction — one interval, one emit, one DB insert.

- **On `game_over` (timer expiry):** server saves match result to Postgres, then emits `h2h_update` to both players.
  - `game_over` is **always emitted first** (preserving existing behavior).
  - DB save happens after. If the DB write fails: log the error server-side, do not emit `h2h_update`. The game-over screen still renders for both players; they just won't see an H2H update for that match.

### New event: `h2h_update`
Emitted to both players after a match is saved. Scoped to the opponent in the just-completed match.
```json
{ "wins": 3, "losses": 1, "draws": 0, "opponentName": "Lucas" }
```

All existing Socket.io events (`timer_tick`, `score_update`, `game_start`, `opponent_left`, etc.) are unchanged.

## Frontend Changes (`online.html`)

### 1. Auth Screen (new — shown before lobby)
- Two tabs: "Log In" / "Sign Up"
- Username + password fields
- On success: JWT saved to `localStorage`, user proceeds to lobby
- On load: decode JWT from `localStorage` locally, check `exp` — if valid and not expired, skip auth screen; otherwise clear and show auth screen
- **Logout:** a "Log Out" button in the lobby clears `localStorage` and returns to the auth screen. No server-side token revocation (stateless JWT).

### 2. Leaderboard Page (new — accessible from lobby)
- "My Record" button on the lobby screen
- Fetches `/api/h2h` and renders a table: Opponent | W | L | D
- Sorted by `lastPlayed` descending (most recently faced opponent at top)
- Shows "No games played yet" if the array is empty

### 3. Results Screen (existing — small addition)
- After current win/loss display, show one line using the `h2h_update` event data
- Example: **"You're now 3–1–0 vs. Lucas"**
- If `h2h_update` was not received (DB error), this line is simply omitted

## Error Handling

- `/api/register`: 409 if username taken, 400 if fields missing or password violates length rules
- `/api/login`: 401 for invalid credentials
- Socket auth: emit `auth_error`, disable reconnect, disconnect; client clears localStorage and shows auth screen
- DB errors: log server-side; if during match save, emit no `h2h_update` (game still ends normally); other DB errors emit generic `server_error` event to client

## Security Notes

- Passwords hashed with `bcrypt` (cost factor 10); max input length 72 chars enforced before hashing
- JWT payload: `{ userId, username }` + `exp` (7 days); secret in `JWT_SECRET` env var; server throws on startup if absent
- Parameterized queries throughout (no raw string interpolation)
- Auth endpoints rate-limited to 10 requests / IP / 15 min via `express-rate-limit`
- **XSS prevention:** all user-controlled strings (usernames) are inserted into the DOM via `textContent` — never `innerHTML`. This prevents stored XSS from stealing JWTs stored in `localStorage`.
