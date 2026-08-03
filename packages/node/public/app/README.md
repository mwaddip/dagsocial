# Notis — X-style client

A second browser client for Notis, laid out and styled as closely to X as the
protocol allows. It talks to exactly the same node API as the demo UI at
`public/index.html`, does exactly the same client-side work — Ed25519 key
management, proof of work, transaction construction and signing — and adds no
server of its own.

Served statically by the node at **`/app/`** (`express.static` already publishes
`public/`, so there is no route to register). The demo UI is untouched and still
lives at `/`.

```
http://localhost:3000/          demo UI
http://localhost:3000/app/      this client
```

## Why a second client rather than a rewrite of the first

The demo UI is a debugging surface: it shows box ids, transaction ids, PoW
progress and raw invite secrets, and it is the thing you reach for when the node
is misbehaving. That is worth keeping exactly as it is. This client answers the
opposite question — what the same chain feels like as a product — and the two
are more useful side by side than merged.

Both are pinned to the same golden vector by
`test/unit/ui-crypto-mirror.test.ts` and `test/unit/x-ui-crypto-mirror.test.ts`,
so the two copies of the consensus crypto cannot drift apart silently.

## How X's concepts map onto the protocol

Everything in the left column is a real, signed, on-chain operation unless the
notes say otherwise.

| X | Notis | Notes |
|---|---|---|
| Post | `POST /posts` | Mines PoW in the browser, signs, and locks 5 karma (3 for a reply) |
| Reply | a post naming its parent | Same transaction, `parentRefs` set |
| Repost / Quote | a post naming the quoted post | The DAG has no repost edge; the button composes a quote |
| Like | `POST /likes` | Locks 2 karma in a LikeBox; undoing returns it in full |
| Follow | **vouch** (`POST /vouches`) | The closest real primitive: it stakes the voucher's own standing |
| Followers / Following | `GET /vouches?target=` / `?voucher=` | |
| Verified badge | you vouch for that account | Shown with that wording in its tooltip |
| Notifications | derived | Likers on your posts, replies naming them, vouches for you |
| Trends | derived | Hashtags in the timeline page the node returned |
| Who to follow | derived | Active authors you do not vouch for |
| Search | derived | Substring match over the timeline page — the node has no search endpoint |
| Views count | chain status | The slot shows confirmed / pending instead |
| Profile name + avatar | derived from the public key | Deterministic, so every client shows the same ones |
| Premium | Wallet | Karma, credits, faucets, credit transfer, the invite lifecycle |
| Bookmarks | **local** | localStorage; the protocol has no bookmark record |
| Display-name override | **local** | localStorage, and the UI says so wherever it appears |
| Direct messages | **absent** | No encrypted envelope exists in the wire format; the view explains this rather than faking an inbox |

Three things are browser-local, and each is labelled as such in the UI:
bookmarks, the display-name override, and like receipts (the LikeBox ids needed
to undo a like, which the node does not index by liker).

## Layout

```
index.html          shell + pre-paint theme application
styles.css          design tokens, three themes, six accents, X's breakpoints
js/
  app.js            boot and the routing table
  router.js         hash routing
  shell.js          left nav, account switcher, layout frame
  sidebar.js        right column: chain status, trends, suggestions
  settings.js       theme / accent / font size
  chain.js          consensus crypto and transaction builders  ← mirrored in tests
  blake2b.js        the one import the mirror test swaps for a node:crypto shim
  api.js            HTTP client
  actions.js        every chain write, in one place
  store.js          state, caching, and the derived social graph
  identity.js       keys, derived handles, names and avatars
  dom.js            escaping, formatting, toasts, modals, menus
  icons.js          X's icon set as inline SVG
  postcard.js       post rendering in list / focal / quote form
  composer.js       the composer, inline and modal
  views/            one module per route
```

No build step, no bundler, no framework — ES modules loaded directly by the
browser, matching the rest of the repo's approach. The only external dependency
is `blakejs` from a CDN, which the demo UI already uses.

Views render HTML strings. Everything interpolated goes through `esc()` in
`dom.js`: post content is user-controlled and the node does not sanitise it, so
that escaping is the only thing between a post body and script injection.

## Keys

Identities are shared with the demo UI — both read and write
`dagsocial-identities` in localStorage — so an account created in one client
appears in the other, and the demo UI's exported identity files import here
unchanged.

## Requirements

Ed25519 in WebCrypto (`crypto.subtle.generateKey('Ed25519')`). Available in
current Chrome, Firefox and Safari. The app reports this rather than failing
silently if it is missing.
