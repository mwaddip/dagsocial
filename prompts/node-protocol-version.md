/clear
Read ~/projects/OVERRIDES.md.
Read ~/.claude/RTK.md.
Read CLAUDE.md.
Read contracts/ARCHITECTURE.md.
Read contracts/TYPES_INTERFACE.md.
Read contracts/NODE_INTERFACE.md.

# node: protocol version enforcement, content limit, use shared constants

## Observable problem
The node does not validate `protocolVersion` on incoming posts, does not enforce the 300-byte content limit, and defines its own PoW/block config values instead of importing the shared protocol constants from `@dagsocial/types`. The demo UI does not send `protocolVersion` with posts. The blocks table has no `protocol_version` column, and the node does not set `protocolVersion` on blocks it creates.

Without these, a future node with different rules has no way to distinguish old posts from new ones, and the 300-byte content limit specified in the contract is not enforced anywhere.

## Target state

### 1. Content limit and protocol version enforcement in verifier

`packages/node/src/services/verifier.ts` — add two checks to `verifyPost()`:

After existing field presence checks, before signature verification:
- If `post.protocolVersion !== PROTOCOL_VERSION`, return `{ valid: false, error: 'Unsupported protocol version' }`
- If `post.content.length > MAX_CONTENT_BYTES`, return `{ valid: false, error: 'Content exceeds max length' }`

Import `PROTOCOL_VERSION` and `MAX_CONTENT_BYTES` from `@dagsocial/types`.

### 2. Use shared constants in config

`packages/node/src/config.ts` — import defaults from `@dagsocial/types` instead of hardcoding:

```typescript
import { DEFAULT_SLOT_TARGET_BITS, DEFAULT_SUBMIT_TARGET_BITS, DEFAULT_SLOT_WINDOW_BLOCKS } from '@dagsocial/types';
```

Replace hardcoded values with the imported constants as defaults.

### 3. protocolVersion on blocks

`packages/node/src/store/blocks.ts` — `createBlock()` adds `protocolVersion: PROTOCOL_VERSION` to the returned Block.

Blocks table needs a `protocol_version INTEGER NOT NULL DEFAULT 1` column. Add an `ALTER TABLE` migration (wrapped in try/catch for idempotency) and update the `CREATE TABLE IF NOT EXISTS` in db.ts.

### 4. Update test fixtures

All test files that construct Post objects must include `protocolVersion: 1`:
- `packages/node/test/integration/store.test.ts` — `testPost()` helper
- `packages/node/test/unit/verifier.test.ts` — test posts
- `packages/node/test/integration/api.test.ts` — any post construction

### 5. Update demo UI

`packages/node/public/index.html` — the post submission fetch body includes `protocolVersion: 1`.

### 6. Content length enforcement in routes

`packages/node/src/routes/posts.ts` — validate `content.length` is 1–300 before processing.

## Verification
- `pnpm test` — all tests pass
- `pnpm build` — both packages build clean
- New verifier tests: reject post with unsupported `protocolVersion`, reject post with >300 byte content
- Demo UI still posts successfully with `protocolVersion: 1`

## Deliverables
1. Modified: `packages/node/src/services/verifier.ts` — protocol version + content limit checks
2. Modified: `packages/node/src/config.ts` — use shared constants
3. Modified: `packages/node/src/store/db.ts` — protocol_version column on blocks
4. Modified: `packages/node/src/store/blocks.ts` — protocolVersion on created blocks
5. Modified: `packages/node/src/routes/posts.ts` — content length validation
6. Modified: `packages/node/public/index.html` — send protocolVersion
7. Modified: all test files with Post/Block fixtures — include protocolVersion
8. New tests where appropriate
9. Commit with conventional commit message
10. Report commit hash

## Coordination
When done, send a brief completion summary back to the main session window:
    kitty @ send-text --match=id:1 'one-line summary of what was done'
    kitty @ send-text --match=id:1 $'\r'
