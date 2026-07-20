Read ~/projects/OVERRIDES.md.
Read ~/.claude/RTK.md.
Read CLAUDE.md.
Read contracts/ARCHITECTURE.md.
Read contracts/TYPES_INTERFACE.md.

# types: add protocolVersion, content limit, and protocol constants

## Observable problem
Current `Post` and `Block` types have no `protocolVersion` field. `signingHash()` and `computePostId()` do not include a protocol version. No content limit constant exists. No shared protocol constants exist — PoW defaults and slot window are defined in the node's `config.ts` instead of in the types package where all components can import them.

Without a protocol version on posts, future rule changes (different PoW algorithm, different signature format, different content limits) will silently break validation of old posts. Without a shared `MAX_CONTENT_BYTES` constant, the node and web client could enforce different limits.

## Target state

### New constants in `packages/types/src/constants.ts`

```typescript
export const PROTOCOL_VERSION = 1;
export const MAX_CONTENT_BYTES = 300;
export const MAX_PARENT_REFS = 8;
export const DEFAULT_SLOT_WINDOW_BLOCKS = 100;
export const DEFAULT_SLOT_TARGET_BITS = 20;
export const DEFAULT_SUBMIT_TARGET_BITS = 8;
```

### `protocolVersion` added to types

- `UnsignedPost` gains `protocolVersion: number`
- `Block` gains `protocolVersion: number`
- `signingHash()` includes `protocolVersion` in the hash (after slotHash, before timestamp)
- `computePostId()` includes `protocolVersion` in the hash (same position)

### Updated `packages/types/src/index.ts`

Exports all new constants and the `protocolVersion` field is present on Post and Block types.

## Verification
- `pnpm test` in types package — all existing post tests updated to include `protocolVersion: 1`
- New test: `signingHash` and `computePostId` change when `protocolVersion` changes
- New test: constants have expected values
- `pnpm build` succeeds
- `dist/index.d.ts` includes `PROTOCOL_VERSION`, `MAX_CONTENT_BYTES`, etc.

## Deliverables
1. New file: `packages/types/src/constants.ts` with protocol constants
2. Modified: `packages/types/src/post.ts` — `protocolVersion` field on `UnsignedPost` and `Block`, updated `signingHash()` and `computePostId()`
3. Modified: `packages/types/src/index.ts` — export new constants
4. Modified: `packages/types/test/post.test.ts` — tests use `protocolVersion: 1`, new test for version sensitivity
5. Commit with conventional commit message
6. Report commit hash

## Coordination
When done, send a brief completion summary back to the main session window:
    kitty @ send-text --match=id:1 'one-line summary of what was done'
    kitty @ send-text --match=id:1 $'\r'
