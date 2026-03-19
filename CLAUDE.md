# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A single-file React Solitaire (Klondike) card game implemented as one default-exported component (`Solitaire`). No build config, router, or state library — pure React hooks with inline styles.

## Architecture

Everything lives in one file. Key sections:

**Game logic (pure functions, no React):**
- `mkDeck` / `shuffle` / `newGame` — deck creation and initial deal (7 tableau columns, 4 foundations, stock/waste)
- `canStack(card, onto)` — tableau move validation (alternating color, descending rank)
- `canFound(card, pile)` — foundation move validation (same suit, ascending rank)
- `vi(v)` — converts face value to numeric index via `VALS` array

**Game state shape** (held in `g` via `useState`):
```js
{
  tab:   [[...cards], ...],   // 7 tableau columns
  found: [[],[],[],[]],       // 4 foundation piles
  stock: [...cards],          // face-down draw pile
  waste: [...cards],          // face-up discard pile
  score: 0,
  moves: 0,
}
```
Each card: `{ s: suit, v: value, up: boolean, id: string }`

**Selection model:**
- `sel` state: `{ type: 'waste'|'found'|'tab', col?, idx? }` — tracks what's selected
- `selCards` — derived array of cards currently selected (slice from tab, or top of waste/found)
- `removeSel(game, sel)` — immutably removes selected cards from their source pile; auto-flips newly exposed tableau top card

**Sub-components** (inline, no separate files):
- `Back` — face-down card
- `Face` — face-up card (supports `sel` highlight, `onDbl` for auto-send)
- `Slot` — empty pile placeholder (shows hint highlight when a valid move target)

**Card dimensions:** `CW=66, CH=92` (px). Tableau overlap offsets: `FDU=28` (face-up), `FDD=18` (face-down).

## Interaction Patterns

- Single click: select source → click destination to move
- Double-click: auto-sends top card to any valid foundation (`tryAutoFound`)
- Stock click: deal one card to waste; when stock empty, recycles waste back to stock (no score penalty)
- Scoring: +10 per card moved to foundation, +5 for waste→tableau move

## Style Conventions

- All styling is inline via `style={{}}` — no CSS files, no CSS modules, no Tailwind
- Colors: green felt background (`#15803d`/`#166534`), white cards, `#dc2626` red suits, `#f59e0b` amber selection highlight
- `sp` (stopPropagation) is passed to interactive children to prevent the root `onClick={() => setSel(null)}` from clearing selection
