# DAGsocial

Decentralized social network. Phase 1: local HTTP node with identity, two-phase PoW, DAG post storage in SQLite. TypeScript monorepo, pnpm workspaces, Node.js ≥ 22.

## Quick commands

```bash
pnpm build                # Build both packages
pnpm test                 # Run all tests (60: 26 types, 34 node)
pnpm typecheck            # Type-check both packages
node packages/node/dist/index.js   # Start node on :3000
```

## Architecture

Two packages:
- `@dagsocial/types` — data structures, base58, CBOR, protocol constants. Pure functions only.
- `@dagsocial/node` — Express server, PoW, verifier, SQLite store, block creator, demo UI.

Future: `@dagsocial/net` (libp2p), `@dagsocial/web` (React client).

## Design by Contract

This project uses Design by Contract for multi-session workflow. The `contracts/` directory is the source of truth for interfaces. Contracts lead; code follows.

- `contracts/ARCHITECTURE.md` — system overview, invariants, protocol versioning
- `contracts/TYPES_INTERFACE.md` — types package contract
- `contracts/NODE_INTERFACE.md` — node package contract (API, verifier, store interface)
- `contracts/NET_INTERFACE.md` — networking contract (Phase 2)
- `contracts/WEB_INTERFACE.md` — web client contract (Phase 2)

### Workflow

1. Update the contract first in `contracts/`
2. Write a dispatch prompt in `prompts/<component>-<task>.md` with required boilerplate (see below)
3. Dispatch via kitty:

```bash
# Capture main window id
MAIN_WINDOW=$KITTY_WINDOW_ID

# Spawn new window in project root
NEW_WIN=$(kitty @ launch --type=window --cwd=/home/mwaddip/projects/dagsocial)

# Launch dclaude
kitty @ send-text --match=id:$NEW_WIN 'dclaude'
kitty @ send-text --match=id:$NEW_WIN $'\r'

# Wait ~10s for Claude to come up, then inject prompt instruction
kitty @ send-text --match=id:$NEW_WIN 'use the receiving-prompts skill to execute the work in /home/mwaddip/projects/dagsocial/prompts/<name>.md'

# HALT — confirm with user before submitting
kitty @ send-text --match=id:$NEW_WIN $'\r'
```

4. Dispatch gate is `gate` mode — confirm with user before the final `$'\r'`
5. Component session reads contracts, implements, tests, commits, reports back via kitty `send-text` to main window

### Prompt boilerplate

Every dispatch prompt must start with:

```
/clear
Read ~/projects/OVERRIDES.md.
Read ~/.claude/RTK.md.
Read CLAUDE.md.
Read contracts/ARCHITECTURE.md.
Read the relevant interface contract(s) for this task.

## <task title>
...

## Coordination
When done, send a brief completion summary back to the main session window:
    kitty @ send-text --match=id:<MAIN_WINDOW_ID> 'one-line summary of what was done'
    kitty @ send-text --match=id:<MAIN_WINDOW_ID> $'\r'
```

### Main session vs component sessions

The main session owns contracts and prompts. It never edits component source code. Component sessions own one component each, read contracts, implement against them, and push their own work.

## Key invariants

- Post content: 1–300 UTF-8 bytes (`MAX_CONTENT_BYTES`)
- Parent refs: 0–8 per post
- Slot validity: measured in block height, not wall clock
- Signatures: raw Ed25519 (64 bytes), base64 on wire. Verified with `crypto.verify(null, ...)` using a KeyObject.
- Hashing: `blake2b512` with `.subarray(0, 32)` for all 32-byte outputs (Node.js v22 lacks blake2b256)
- Wire format: CBOR (`cbor-x`). HTTP API: JSON.
- Secret keys never in API responses or DTOs crossing component boundaries.
- Protocol version on every post and block (`PROTOCOL_VERSION = 1`).

## Protocol versioning

All posts and blocks carry a `protocolVersion` field. Validation rules are keyed to this version. Old posts are validated against their declared version forever. A node rejects posts with an unsupported version.

## Platform constraint

Node.js v22 does not support `createHash('blake2b256')`. All hashing uses `createHash('blake2b512')` with `.subarray(0, 32)`. The demo UI uses `blakejs` from CDN (`blake2b(data, null, 64).slice(0, 32)`). These must produce identical output — both are standard BLAKE2b-512.
