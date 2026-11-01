# p2p-social

A Twitter-like MVP with no servers. The desktop shell is **Tauri** (Rust + the OS
webview, no Electron). The P2P backend is a **Bare** process running the Holepunch
stack that Pear is built on (Hypercore, Corestore, Hyperswarm).

```
ui/ (HTML/JS in the webview)
   │  invoke('send') / 'backend' event
src-tauri/ (Rust: spawns the backend, pipes JSON lines over stdio)
   │  stdin/stdout
backend/index.js (Bare: corestore + hyperswarm)
   │
P2P network (Hyperswarm DHT)
```

## How it works

- **Identity = feed.** Each user has one append-only Hypercore, signed by a keypair
  that stays on the device. Every action is an entry in that feed:
  `profile`, `post` (optionally `replyTo`), `follow`/`unfollow`, `like`/`unlike`.
- **Discovery.** Every peer joins one Hyperswarm topic (the "town square"). When
  two peers connect, they gossip the feed keys they know over a small Protomux
  channel (`p2p-social/peers/v1`), then Corestore replicates all of those feeds
  over the same connection.
- **Availability.** Peers keep a full copy of every feed they know about and re-serve
  it, so your posts still spread after you go offline.
- **Indexing.** The backend reads feeds into memory and pushes a full snapshot to
  the UI on every change. That's fine for an MVP but won't scale (see roadmap).

## Run

Requirements: Node/npm, Rust, and the Tauri Linux deps (webkit2gtk-4.1, gtk3, libsoup3).

```sh
npm install              # backend deps + prebuilt Bare binary (JS stack comes from npm)
cd src-tauri && cargo run
```

`npm run dev` is the same thing. Node is only needed for `npm install`, not at runtime.

Your data lives in the app data dir (`~/.local/share/dev.p2psocial.app/storage` on
Linux).

### Two users on one machine

```sh
npm run dev                                                  # user 1
P2P_SOCIAL_STORAGE=/tmp/bob ./src-tauri/target/debug/p2p-social  # user 2
```

They find each other through the public DHT, which can take a few seconds. If
discovery fails (strict NAT), copy one user's key ("Copy my key") and paste it
into the other's Explore → Add box.

### Env vars

| var | meaning |
| --- | --- |
| `P2P_SOCIAL_STORAGE` | storage directory (one per user) |
| `P2P_SOCIAL_BOOTSTRAP` | `host:port,...` DHT bootstrap (e.g. a local `hyperdht/testnet`) |
| `BARE_BIN` | path to the `bare` binary (default: the prebuilt one in `node_modules/bare-runtime-<os>-<arch>`) |
| `P2P_SOCIAL_ROOT` | project root containing `backend/` (defaults to the source checkout) |

### Headless backend

```sh
npm run backend -- ./storage/alice
# then type JSON commands, one per line:
{"cmd":"profile","name":"Alice"}
{"cmd":"post","text":"hello p2p"}
```

Commands: `post {text, replyTo?}`, `profile {name, bio}`, `follow|unfollow {key}`,
`like|unlike {id}`, `add {key}`, `refresh`. Output events: `ready`, `state`, `error`.

## Known MVP limits / roadmap

- `tauri build` bundles the Rust shell but not `backend/` + `node_modules` + `bare`.
  To ship it, add them as Tauri `resources` and set `P2P_SOCIAL_ROOT`/`BARE_BIN`
  from the resource dir.
- Pear distribution and OTA updates (`pear touch` / `pear stage` / `pear seed` +
  `pear-runtime`'s updater in the backend) aren't wired up yet.
- Everyone on the topic sees everyone (no moderation or blocking), and anyone can
  spam the gossip channel with keys.
- Full-snapshot state and in-memory indexes. Next step: a Hyperbee index plus paginated queries.
- Text only: no images, DMs, reposts, or notifications.
