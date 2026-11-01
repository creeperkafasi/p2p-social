# Handoff: p2p-social (Feature-Rich SNS)

_Last updated: 2026-11-01_

## What this is

A feature-rich, serverless P2P desktop social network (Twitter/X alternative) built with:
- **Shell:** Rust/Tauri 2 (hosts OS webview, relays JSON protocol lines over stdio).
- **Backend:** Bare process (Holepunch runtime) running Corestore, Hypercore, and Hyperswarm.
- **Frontend:** Modern 3-column responsive UI in `ui/` with Light/Dark mode, zero build step, instant reactivity.

## Status

| Area | State |
| --- | --- |
| Backend (feeds, discovery, gossip, indexing) | Works. `npm test` passes 10/10 checks (2 peers on local DHT testnet) |
| Core features | Posts, reposts, quote posts, replies, likes, bookmarks, polls & voting, DMs, rich profiles |
| Media support | Compressed image attachments (canvas JPEG/WebP), clipboard paste, drag & drop, lightbox |
| Discovery & Social | Hyperswarm DHT town square, Protomux key exchange, trending hashtags, peer discovery, QR codes |
| Moderation | Client-side blocking & muting persisted to user Hypercore |
| UI & Design | 3-column desktop layout (Sidebar, Main Feed, Widgets), Dark/Light theme, notification badges |
| Shell build | `cargo build` in `src-tauri` builds cleanly with embedded UI |

## Data Model

One append-only Hypercore per user (`store.get({ name: 'feed' })`, JSON entries):
- `profile`: `{ name, bio, avatar, banner, location, website }`
- `post`: `{ text, ts, replyTo?, quoteOf?, media?, poll?, tags? }`
- `delete_post`: `{ targetSeq, ts }`
- `repost` / `unrepost`: `{ post: "author:seq", ts }`
- `like` / `unlike`: `{ post: "author:seq", ts }`
- `vote`: `{ post: "author:seq", option: number, ts }`
- `bookmark` / `unbookmark`: `{ post: "author:seq", ts }`
- `follow` / `unfollow`: `{ key: hex, ts }`
- `block` / `unblock`: `{ key: hex, ts }`
- `mute` / `unmute`: `{ key: hex, ts }`
- `dm`: `{ to: recipientHex, text, media?, ts }`

## Commands (UI -> Backend stdio)

`post`, `delete_post`, `profile`, `repost`, `unrepost`, `like`, `unlike`, `vote`, `bookmark`, `unbookmark`, `follow`, `unfollow`, `block`, `unblock`, `mute`, `unmute`, `dm`, `add`, `refresh`.

## Testing

```sh
npm test
```
Runs `test/e2e.js` against 3 DHT testnet nodes: verifies peer connection, post replication, likes, reposts, followers, replies, polls, poll voting, and direct messaging.
