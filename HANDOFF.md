# Handoff: p2p-social MVP

_Last updated: 2026-11-01_

## What this is

A Twitter-like desktop MVP with no servers. The user asked for something built
"using Pear" (holepunchto/pear) but **without Electron**, and picked **Tauri + Bare**
over a pure-terminal Pear app or a full-Rust/libp2p rewrite.

- **Shell:** Rust/Tauri 2 (OS webview: webkit2gtk on Linux). It only spawns the
  backend and relays JSON lines.
- **Backend:** a Bare process (Holepunch's JS runtime) running Corestore, Hypercore
  and Hyperswarm, the same stack Pear is built on.
- **Pear itself (CLI, `pear-runtime`, OTA updates) is not used yet.** Pear 3's
  official desktop template (`hello-pear-electron`) is Electron-only. Its updater
  lives in the Bare worker, so it could be ported, but that hasn't been done.

## Status

| Area | State |
| --- | --- |
| Backend (feeds, discovery, gossip, indexing) | Works. `npm test` passes (2 peers on a local testnet) |
| UI (Home / Explore / Thread / Profile / setup dialog) | Works against real backend data in headless Chromium with a mocked Tauri bridge |
| Tauri shell | Builds. Two windows launched, connected and shut down cleanly. **Not clicked through by hand.** The user is testing it now |
| Persistence across restarts | Verified: an offline restart reloads all known feeds from `known-feeds.json` |
| Packaging (`tauri build`) | **Not done.** Doesn't bundle `backend/`, `node_modules` or the Bare binary |
| Pear distribution / OTA | Not started |
| Git | The project is not a git repo yet |

## Layout

```
backend/index.js     Bare backend: storage, swarm, gossip, indexing, stdio protocol
src-tauri/src/main.rs  Spawns backend, `send` command -> stdin, stdout -> "backend" event
src-tauri/tauri.conf.json  Static frontend from ../ui, withGlobalTauri, CSP
ui/                  index.html, app.js (plain JS, hash routing, full re-render), style.css
test/e2e.js          Headless 2-peer test on hyperdht/testnet
README.md            User-facing run instructions + roadmap
```

## Data model

One Hypercore per user (`store.get({ name: 'feed' })`, JSON entries). Entry types:
`profile {name,bio}`, `post {text,ts,replyTo?}`, `follow|unfollow {key}`,
`like|unlike {post}`. Post id = `<authorHex>:<seq>`. Field lengths are clamped
on read (name 50, bio 160, post 280).

Discovery: everyone joins `hash('p2p-social/town-square/v1')`. On each
connection a Protomux channel `p2p-social/peers/v1` sends `c.array(c.fixed32)` of
every known feed key. The receiver opens those cores. Corestore attaches newly
opened cores to existing streams, so replication just follows. Feeds are
downloaded in full, live (`download({start:0,end:-1})`).

The backend keeps all indexes in memory and pushes a **full snapshot**
(`type:'state'`, capped at 1000 posts) to the UI, debounced 100 ms.

## stdio protocol

stdin commands: `post {text, replyTo?}`, `profile {name,bio}`,
`follow|unfollow {key}`, `like|unlike {id}`, `add {key}`, `refresh`.
stdout events: `ready {me}`, `state {...}`, `error {message}`.
Closing stdin means a graceful shutdown. The shell does this on exit and kills the
backend after 3 s.

## Run / test

```sh
npm install                      # if ~/.npm is root-owned: npm_config_cache=/tmp/npm-cache npm install
npm test                         # backend e2e
cd src-tauri && cargo run        # app (same as `npm run dev`)
P2P_SOCIAL_STORAGE=/tmp/bob ./src-tauri/target/debug/p2p-social   # second user
```

Env vars: `P2P_SOCIAL_STORAGE`, `P2P_SOCIAL_BOOTSTRAP` (`host:port,...`),
`BARE_BIN`, `P2P_SOCIAL_ROOT`. `DEBUG=1 npm test` shows backend logs.

## Gotchas I hit (don't re-learn these)

- **Async lock race:** an async IIFE with no `await` finishes synchronously, so
  `feed.indexing = (async () => { ...; feed.indexing = null })()` stays non-null
  forever on an empty feed. That's why `index()` starts with `await null`.
- **Simultaneous joins don't meet:** two peers that join the topic at the same
  moment both look up before either announces, and Hyperswarm only re-looks every
  few minutes. Fixed with `discovery.refresh()` every 15 s.
- **Spawn the real Bare binary,** not `node_modules/.bin/bare`, which is a Node
  wrapper. `bundled_bare()` in main.rs resolves
  `node_modules/bare-runtime-<os>-<arch>/bin/bare`.
- **Stale UI in the binary:** Tauri embeds `ui/` at compile time, and cargo
  doesn't always notice UI-only edits. Use `cargo clean -p p2p-social` if UI
  changes don't show up.
- Two instances share the webview cache dir, which logs a harmless libsoup
  "database is locked" warning.
- Never `pkill -f <pattern>` from a shell whose own command line contains that
  pattern. It kills itself.

## Known weaknesses

- No moderation, blocking or spam limits. Any peer can gossip up to 1000 keys per
  message, and we open all of them.
- Full snapshots and re-rendering the whole DOM won't scale. Next step: a Hyperbee
  index, paginated queries and incremental UI updates.
- Timestamps are self-reported (`ts`) and can be forged. Ordering trusts them.
- No feed key verification UX (anyone can name themselves "Alice").
- The `like` count dedupes per liker feed (Set), but `unlike` without a prior like
  is a no-op. That's fine.

## Suggested next steps

1. Get the user's feedback from hand-testing the Tauri window and fix what they hit.
2. `git init` and make a first commit (ask first).
3. Packaging: add `backend/`, the production `node_modules` and the Bare binary as
   Tauri `resources`, and resolve `P2P_SOCIAL_ROOT`/`BARE_BIN` from the resource
   dir in release builds.
4. Pear integration: `pear touch` for a link, then port the `pear-runtime`
   updater from `hello-pear-electron`'s worker into `backend/index.js`, and
   `pear stage`/`pear seed` the AppImage.
5. Block/mute lists (as feed entries) plus a cap on how many unknown keys you
   accept per peer.
