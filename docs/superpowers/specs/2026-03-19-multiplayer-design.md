# Multiplayer Solitaire — Same-Device Pass-and-Play Design Spec

**Date:** 2026-03-19
**Status:** Approved

---

## Overview

Add a 2-player same-device competitive mode to the existing single-file React Klondike Solitaire. Both players play simultaneously on the same device, switching between tabs freely. After a fixed 5-minute timer expires, the player with the highest score wins. No networking, no backend — pure React state.

---

## Architecture

The implementation lives entirely within the existing single file. Two new constructs are added:

### `MultiplayerShell` (new default export)

Owns all shared multiplayer state:

| State | Type | Description |
|---|---|---|
| `timeLeft` | `number` | Shared countdown from 300 → 0 (seconds) |
| `activePlayer` | `0 \| 1` | Which player's board is currently visible |
| `scores` | `[number, number]` | Current score for each player |
| `seed` | `number` | Shared random seed for identical deals; changing it resets both games |

`timeLeft === 0` is used directly as the `gameOver` condition — no separate `gameOver` state is needed.

Renders: tab bar, shared countdown, and both `Solitaire` instances (see Rendering below).

### `Solitaire` (renamed from default export to named internal component)

Receives 4 new optional props:

| Prop | Type | Description |
|---|---|---|
| `playerName` | `string` | Displayed in header instead of "♠ Solitaire" |
| `timeLeft` | `number` | When 0, all click handlers are disabled (game frozen) |
| `seed` | `number` | Used to initialize `newGame(seed)` on mount and on reset |
| `onScoreChange` | `(score: number) => void` | Wrapped in `useCallback` by the shell; called via `useEffect([g.score])` when score changes |

---

## Rendering: Both Instances Always Mounted

Both `Solitaire` instances are **always mounted**. The inactive player's board is hidden with `display:'none'` (not conditional rendering), so each player's `useState` game state is preserved across tab switches.

```jsx
<div style={{ display: activePlayer === 0 ? 'block' : 'none' }}>
  <Solitaire playerName="Player 1" ... />
</div>
<div style={{ display: activePlayer === 1 ? 'block' : 'none' }}>
  <Solitaire playerName="Player 2" ... />
</div>
```

---

## UI & UX

### Tab Bar
- Two tabs at the top: "Player 1" and "Player 2"
- Active tab: highlighted in green (`#16a34a`)
- Inactive tab: dimmed (`rgba(255,255,255,.3)`)
- Each tab displays the player's current score as a badge (e.g. `Player 1 — 45`)
- Shared countdown timer centered between tabs, always visible

### In-Game Header Changes
- `playerName` prop replaces the "♠ Solitaire" title
- The existing per-game timer (`sec`, `setSec`, and its `useEffect`/`setInterval`) is **removed** from `Solitaire`; `timeLeft` from the shell is displayed instead
- The existing score display (`★ {g.score}`) is **removed** from `Solitaire`'s header to avoid duplication with the tab bar badges; moves counter remains

### Early Win (All 52 Cards to Foundation Before Timer)
- The per-game `won` state and its `useEffect` win-check are **removed** from `Solitaire` in multiplayer mode
- If a player completes their board before time runs out, the game simply freezes naturally (no more valid moves); the timer continues
- The winner is always declared at `timeLeft === 0` via the game-over modal

### Game Over Modal (owned by `MultiplayerShell`)
Triggered when `timeLeft === 0`. Overlays the screen with:
- Player 1 score vs Player 2 score
- Winner announcement: "Player 1 Wins!", "Player 2 Wins!", or "It's a Tie!"
- "Play Again" button — generates a new seed (`Math.random()`), updates shell `seed` state; both `Solitaire` instances reset via their `key={seed}` prop; timer resets to 300

### Frozen State
When `timeLeft === 0`, each `Solitaire` instance ignores all click handlers (guard at the top of every handler: `if (timeLeft === 0) return`).

---

## Data Flow

### Seeded Shuffle for Fair Deals

`shuffle` is replaced with a seeded variant using a minimal inline PRNG (mulberry32):

```js
const mulberry32 = seed => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

const shuffle = (a, rand) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};
```

`newGame(seed)` accepts a seed number, creates a `rand` function via `mulberry32(seed)`, and passes it to `shuffle`. Both players receive the same `seed` from the shell and therefore get identical starting layouts.

### Timer
- `MultiplayerShell` owns a single `setInterval` that decrements `timeLeft` each second
- Interval is cleared when `timeLeft === 0` or on unmount
- `timeLeft` is passed as a prop to each `Solitaire`

### Score Tracking
- `onScoreChange` is defined in the shell using `useCallback` (stable reference, no dep churn):
  ```js
  const onP1ScoreChange = useCallback(s => setScores(prev => [s, prev[1]]), []);
  const onP2ScoreChange = useCallback(s => setScores(prev => [prev[0], s]), []);
  ```
- Each `Solitaire` has a `useEffect([g.score])` that calls `onScoreChange(g.score)`
- `scores` drives the tab badges and the end-of-game modal

### Reset Mechanism
Each `Solitaire` receives a unique key incorporating the seed (e.g. `` `p0-${seed}` `` and `` `p1-${seed}` ``). When "Play Again" is clicked, the shell handler does:
```js
setSeed(Math.random());
setTimeLeft(300);
setActivePlayer(0);
setScores([0, 0]);
```
Changing `seed` causes React to unmount and remount both instances with fresh state initialized from the new seed. `setScores([0, 0])` is called explicitly rather than relying on the remounted instances' mount-time `onScoreChange(0)` effects, to ensure the tab badges reset synchronously with the modal closing.

---

## State Tree

```
MultiplayerShell
  ├── timeLeft        number (300 → 0)
  ├── activePlayer    0 | 1
  ├── scores          [number, number]
  ├── seed            number (changing this resets both games via key prop)
  ├── <Solitaire key={`p0-${seed}`} playerName="Player 1" timeLeft={timeLeft} seed={seed} onScoreChange={onP1ScoreChange} />
  └── <Solitaire key={`p1-${seed}`} playerName="Player 2" timeLeft={timeLeft} seed={seed} onScoreChange={onP2ScoreChange} />
```

---

## What Changes in `Solitaire`

| Item | Change |
|---|---|
| `shuffle` | Replaced with seeded variant (takes `rand` function) |
| `newGame` | Accepts `seed: number`; creates `rand` via `mulberry32(seed)` |
| `fmt` | Lifted to module scope (shared with `MultiplayerShell`) |
| `sec`, `setSec` | Removed |
| Timer `useEffect` / `setInterval` | Removed |
| `won`, `setWon` | Removed |
| Win-check `useEffect` | Removed |
| Win modal JSX | Removed |
| `startNew` function / "New" button | Removed from `Solitaire`; reset is owned by the shell |
| Header title | Uses `playerName` prop instead of hardcoded "♠ Solitaire" |
| Header timer display | Uses `timeLeft` prop (formatted via module-scope `fmt`) instead of `sec` |
| Header score display | Removed (shown in tab bar badges instead) |
| All click handlers | Guard: `if (timeLeft === 0) return` added at top |
| New `useEffect` | Watches `g.score`, calls `onScoreChange(g.score)`; also fires on mount with `g.score === 0` — this is intentional and harmless |
| `useState` init | `useState(() => newGame(seed))` using the `seed` prop |
| `tryAutoFound` | Must use functional `setG(prev => ...)` updater to avoid stale-closure bug on `g.found` (more likely to surface with both instances always mounted) |

---

## What Does NOT Change

- Card layout, dimensions (`CW`, `CH`, `FDU`, `FDD`)
- Game logic: `canStack`, `canFound`, `removeSel`, `tryAutoFound`, `mkDeck`
- Interaction patterns: click-to-select, double-click auto-send, stock cycling
- Scoring rules: +10 foundation, +5 waste→tableau
- Visual style: green felt, inline styles, amber selection highlight
- Sub-components: `Back`, `Face`, `Slot`
- Move counter display

---

## Design Notes

- **Timer never pauses on tab switch** — this is intentional. Both players share one clock and play simultaneously. Pausing on switch would break competitive fairness.
- **`onScoreChange(0)` fires on mount** — expected and harmless. Shell initialises `scores` to `[0, 0]` and calls `setScores([0, 0])` explicitly on reset, so the mount-time effect is always redundant by design.
- **Import update required** — add `useCallback` to the existing `import { useState, useEffect }` line.

---

## Out of Scope

- Networking / WebSocket sync
- More than 2 players
- Configurable time limits
- Pausing the timer on tab switch
- Drag-and-drop
- Animations
