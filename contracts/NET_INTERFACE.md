# NET Interface Contract

**Component:** `@dagsocial/net`
**Status:** Phase 2 (not implemented)
**Protocol version:** ≥ 1

## Scope

libp2p networking layer. Owns: peer discovery, post gossip, validator peering, DAG synchronization. Depends on `@dagsocial/node`'s store and verifier for inbound post processing.

## API

### Node Lifecycle

| Function | Signature | Description |
|----------|-----------|-------------|
| `start(config)` | `(NetConfig) => Promise<void>` | Create libp2p node, connect to bootstrap peers, begin gossip |
| `stop()` | `() => Promise<void>` | Graceful shutdown |
| `peerId()` | `() => string` | This node's libp2p peer ID |
| `peers()` | `() => Peer[]` | Connected peers with metadata |

### Gossip

| Function | Signature | Description |
|----------|-----------|-------------|
| `broadcastPost(post)` | `(Post) => void` | Gossip a newly created post to connected peers |
| `broadcastBlock(block)` | `(Block) => void` | Gossip a newly created block |

### Inbound Processing

| Function | Signature | Description |
|----------|-----------|-------------|
| `onPost(callback)` | `((Post) => void) => void` | Register handler for inbound posts. Node re-verifies and inserts. |
| `onBlock(callback)` | `((Block) => void) => void` | Register handler for inbound blocks |

### Sync

| Function | Signature | Description |
|----------|-----------|-------------|
| `sync(fromHeight)` | `(number) => Promise<number>` | Request blocks from peers starting at height. Returns new tip height. |

## Wire Format

- Posts and blocks serialized as CBOR (via `@dagsocial/types`)
- Gossip topic: `/dagsocial/1.0/posts` (versioned)
- Direct messages for sync requests/responses

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LIBP2P_LISTEN` | `/ip4/0.0.0.0/tcp/0` | Listen multiaddr |
| `BOOTSTRAP_PEERS` | `[]` | Bootstrap multiaddrs (comma-separated) |
| `GOSSIP_TOPIC` | `/dagsocial/1.0/posts` | Pubsub topic |

## Preconditions
- Node.js ≥ 22
- `@dagsocial/node` store and verifier available
- Bootstrap peers reachable or DHT bootstrapping enabled
- libp2p transport available (TCP minimum, QUIC preferred)

## Postconditions
- libp2p node started with configured peer ID
- Connected to at least one bootstrap peer (or listening for inbound)
- Posts gossiped to all connected peers on the gossip topic
- Inbound posts verified and inserted into local DAG via node store

## Invariants
- All inbound posts are re-verified before insertion (never trust a peer)
- Gossip messages are protocol-versioned (topic includes version)
- Peer connections are transport-agnostic (libp2p handles multiaddr negotiation)
- Sync requests carry a block height range; peers respond with blocks they have
