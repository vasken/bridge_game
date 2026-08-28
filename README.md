# Bridge Core — Phase 0

A standalone TypeScript rules engine for contract bridge. It has no React, browser, network, storage, robot, or bidding-convention dependencies.

## Included

- 52-card deck creation, seeded or random Fisher–Yates shuffle, and clockwise dealing
- Standard duplicate dealer and vulnerability cycles
- Legal pass, bid, double, and redouble progression
- Passed-out boards, final contract, doubling status, declarer, dummy, and opening leader
- Legal card play with follow-suit enforcement
- Trump/no-trump trick resolution and all 13 tricks
- Dummy state and viewer-specific hand visibility
- Duplicate scoring, including games, slams, doubles/redoubles, overtricks, and undertricks
- Chicago four-deal vulnerability and duplicate-style per-deal scoring
- Pure state transitions plus immutable snapshot history and undo
- Automated tests covering the rules above

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer

## Install and run

```text
npm install
npm test
npm run build
npm run dev:multi
```

The compiled package is written to `dist`. Import public functions and types from `src/index.ts` during development or from the built package in an application.

`npm run dev:multi` starts the private local multiplayer table at `http://127.0.0.1:5173/`.
Create a room as NS or EW, then copy the private room link into a second browser and claim the other side.
The server owns the board state and sends each browser only its partnership's hands, plus dummy when bridge rules reveal it.

The table also includes an Analysis panel. Use Refresh to inspect contract result,
duplicate score, HCP by seat/side, trick winners, DDS makeable tricks, and par
contracts for the current room. DDS analysis is provided by the `bridge-dds`
WebAssembly wrapper around the C++ double-dummy solver.
During play, Refresh also asks DDS to rank the current seat's legal cards and
highlights cards tied for the best double-dummy result.

## Minimal example

```ts
import { BoardHistory, createBoard } from './src/index.js'

let game = new BoardHistory(createBoard(1, 12345))

game = game.apply({
	type: 'call',
	call: { type: 'bid', level: 1, strain: 'C' }
})

game = game.apply({ type: 'call', call: { type: 'pass' } })
game = game.undo()
```

The numeric seed makes the deal reproducible. In production, the server should create and retain a cryptographically strong random seed and keep opponents' hands private. The core engine itself is deliberately unaware of networking and authorization.

## Important boundary

This package validates what bids and plays are legal. It does not decide what a bid means, suggest a bid, play as a robot, or contain Blue Club agreements.

## Still needed from you

Nothing is required to use or test Phase 0. For later phases, decisions will be needed on:

- Your exact Blue Club partnership agreements and alert/explanation wording
- Preferred Chicago session details, if you use house rules beyond the standard four-deal vulnerability cycle
- Undo/claim approval policy for two-browser play
- Whether saved boards may reveal all four hands immediately or only after completion

Those choices intentionally remain outside this rules package.
