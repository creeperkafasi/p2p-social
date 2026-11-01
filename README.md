# p2p-social

A feature-rich, serverless P2P social network (Twitter/X alternative) built with **Tauri** (Rust + webview) and **Bare** (Holepunch JS runtime: Corestore, Hypercore, Hyperswarm).

```
ui/ (HTML5 / Modern JS in OS webview)
   │  invoke('send') / 'backend' event
src-tauri/ (Rust: spawns backend, pipes JSON lines over stdio)
   │  stdin/stdout
backend/index.js (Bare: Corestore + Hyperswarm + gossip & indexing)
   │
P2P network (Hyperswarm DHT / Protomux gossip)
```

## Features

- **Sovereign Identity:** Each user has an append-only Hypercore signed with their local Ed25519 keypair. No accounts, no email, no cloud servers.
- **Rich Media & Attachments:** Attach up to 4 compressed images per post with client-side canvas optimization, clipboard paste (`Ctrl+V`), and full-screen lightbox zoom.
- **Interactive P2P Polls:** Create decentralized polls with custom options. Peers cast signed votes; live percentage bars and vote totals update dynamically across the swarm.
- **Reposts & Quote Posts:** Re-share posts into your timeline or quote them with your commentary.
- **Direct Messages (DMs):** Private 1-on-1 P2P chat history synced between peers with inline image support.
- **Hashtags & Full Search:** Autolinked `#hashtags` and `@mentions`, trending tags discovery widget, and live search across posts, tags, and peers.
- **Notifications:** Real-time aggregated notifications with unread badge counters for likes, reposts, replies, quotes, mentions, and new followers.
- **Bookmarks:** Save posts with 1 click to a dedicated Bookmarks tab.
- **Threaded Conversations:** Full ancestor reply chain visualization with vertical connector lines and nested discussion trees.
- **Moderation Tools:** Client-side Mute and Block features to filter out spam or unwanted peers.
- **QR Code Peer Exchange:** Instant QR code generator for your 64-hex feed key to scan and pair devices or mobile peers.
- **Light & Dark Theme:** System auto-detection or manual 1-click theme switch.

## Architecture

- **Identity = feed:** Every action is an append-only entry in the user's Hypercore: `profile`, `post`, `repost`, `like`, `vote`, `bookmark`, `dm`, `follow`, `block`, `mute`.
- **Town Square Discovery:** Peers connect via Hyperswarm DHT to `hash('p2p-social/town-square/v1')`. When two peers meet, they gossip known keys via Protomux (`p2p-social/peers/v1`) and Corestore replicates feeds in real-time.
- **High Availability:** Every connected peer keeps and re-serves replicated feeds, so your posts remain discoverable even when you are offline.

## Run

Requirements: Node/npm, Rust, and Tauri Linux dependencies (`webkit2gtk-4.1`, `gtk3`, `libsoup3`).

```sh
npm install
cd src-tauri && cargo run
```

`npm run dev` also launches the Tauri desktop application.

### Two users on one machine

```sh
npm run dev                                                  # user 1
P2P_SOCIAL_STORAGE=/tmp/bob ./src-tauri/target/debug/p2p-social  # user 2
```

Peers automatically discover each other via Hyperswarm DHT. You can also paste someone's key into Explore → Connect, or scan their QR code.

### Automated Tests

```sh
npm test
```

Runs a 2-peer end-to-end test on a local DHT testnet (`hyperdht/testnet`), verifying post replication, likes, reposts, threaded replies, profiles, polls, voting, DMs, and clean shutdown.

### Commands reference (stdio protocol)

- `post { text, media?, poll?, quoteOf?, replyTo? }`
- `delete_post { id }`
- `repost { id }` / `unrepost { id }`
- `like { id }` / `unlike { id }`
- `vote { id, option }`
- `bookmark { id }` / `unbookmark { id }`
- `dm { to, text, media? }`
- `profile { name, bio, avatar?, banner?, location?, website? }`
- `follow { key }` / `unfollow { key }`
- `block { key }` / `unblock { key }`
- `mute { key }` / `unmute { key }`
- `add { key }`
- `refresh`
