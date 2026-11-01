// Bare backend: owns the P2P stack and talks to the Tauri shell over stdio.
// Protocol: one JSON object per line. stdin = commands, stdout = events.
// Logs go to stderr so stdout stays clean for the protocol.
//
// Usage: bare backend/index.js <storage-dir> [bootstrap host:port,...]

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const path = require('bare-path')
const Pipe = require('bare-pipe')
const fs = require('bare-fs')

const storage = Bare.argv[2] || path.join('.', 'storage')
const bootstrap = Bare.argv[3]
  ? Bare.argv[3].split(',').map((s) => {
      const [host, port] = s.split(':')
      return { host, port: Number(port) }
    })
  : undefined

// Every peer joins this topic and gossips the feed keys it knows about.
const TOWN_SQUARE = crypto.hash(b4a.from('p2p-social/town-square/v1'))
const PROTOCOL = 'p2p-social/peers/v1'
const MAX_POST = 1000

const stdin = new Pipe(0)
const stdout = new Pipe(1)

const store = new Corestore(storage)
const swarm = new Hyperswarm({ bootstrap })

const feeds = new Map() // hex key -> feed index
const channels = new Set()
let me = null
let readyResolve
const readyPromise = new Promise((resolve) => {
  readyResolve = resolve
})

function log(...args) {
  console.error('[backend]', ...args)
}

function send(msg) {
  stdout.write(JSON.stringify(msg) + '\n')
}

// --- helpers -----------------------------------------------------------

function isKey(k) {
  return typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)
}

function noop() {}

function extractHashtags(text) {
  if (!text) return []
  const matches = text.match(/#[a-zA-Z0-9_\u00c0-\u017e]+/g)
  if (!matches) return []
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))]
}

// --- feeds -------------------------------------------------------------

function emptyIndex(core) {
  return {
    core,
    indexed: 0,
    indexing: null,
    profile: null,
    posts: [], // { seq, text, ts, replyTo, quoteOf, media, poll, tags, deleted }
    reposts: new Set(), // post ids ("author:seq")
    follows: new Set(),
    likes: new Set(), // "author:seq"
    bookmarks: new Set(),
    blocks: new Set(),
    mutes: new Set(),
    votes: new Map(), // postId -> option index
    dms: [] // { seq, to, text, media, ts }
  }
}

async function openFeed(key) {
  if (!key) return null
  const buf = typeof key === 'string' ? b4a.from(key, 'hex') : key
  const hex = b4a.toString(buf, 'hex')
  if (feeds.has(hex)) return feeds.get(hex)

  const core = store.get({ key: buf, valueEncoding: 'json' })
  const feed = emptyIndex(core)
  feeds.set(hex, feed)
  await core.ready()

  core.on('append', () => index(hex))
  core.download({ start: 0, end: -1 }) // keep the whole feed, live
  index(hex)
  broadcastKeys([buf])
  saveKnown()
  return feed
}

const knownFile = path.join(storage, 'known-feeds.json')

function loadKnown() {
  try {
    return JSON.parse(fs.readFileSync(knownFile, 'utf-8')).filter(isKey)
  } catch {
    return []
  }
}

let saveTimer = null
function saveKnown() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    fs.writeFileSync(knownFile, JSON.stringify([...feeds.keys()]))
  }, 1000)
}

function index(hex) {
  const feed = feeds.get(hex)
  if (!feed) return
  if (feed.indexing) {
    feed.dirty = true
    return feed.indexing
  }
  feed.indexing = (async () => {
    await null // yield first, so feed.indexing is set before the loop can finish
    do {
      feed.dirty = false
      while (feed.indexed < feed.core.length) {
        const seq = feed.indexed
        const entry = await feed.core.get(seq)
        apply(feed, seq, entry)
        feed.indexed++
      }
    } while (feed.dirty)
    feed.indexing = null
    scheduleState()
  })().catch((err) => {
    feed.indexing = null
    log('index error', hex.slice(0, 8), err.message)
  })
  return feed.indexing
}

function apply(feed, seq, e) {
  if (!e || typeof e !== 'object') return
  switch (e.type) {
    case 'profile':
      feed.profile = {
        name: String(e.name || '').slice(0, 50),
        bio: String(e.bio || '').slice(0, 200),
        avatar: typeof e.avatar === 'string' ? e.avatar.slice(0, 300000) : '',
        banner: typeof e.banner === 'string' ? e.banner.slice(0, 300000) : '',
        location: String(e.location || '').slice(0, 50),
        website: String(e.website || '').slice(0, 100),
        pinnedPost: typeof e.pinnedPost === 'string' ? e.pinnedPost : null
      }
      break
    case 'post': {
      const text = String(e.text || '').slice(0, MAX_POST)
      const tags = Array.isArray(e.tags) ? e.tags.map((t) => String(t).slice(0, 40)) : extractHashtags(text)
      const media = Array.isArray(e.media) ? e.media.slice(0, 4).map((m) => String(m).slice(0, 350000)) : []
      let poll = null
      if (e.poll && typeof e.poll === 'object' && Array.isArray(e.poll.options) && e.poll.options.length >= 2) {
        poll = {
          question: String(e.poll.question || '').slice(0, 200),
          options: e.poll.options.slice(0, 4).map((opt) => String(opt).slice(0, 60)),
          expiresAt: Number(e.poll.expiresAt) || (Number(e.ts) || Date.now()) + 86400000
        }
      }
      feed.posts.push({
        seq,
        text,
        ts: Number(e.ts) || 0,
        replyTo: typeof e.replyTo === 'string' ? e.replyTo : null,
        quoteOf: typeof e.quoteOf === 'string' ? e.quoteOf : null,
        media,
        poll,
        tags,
        deleted: false
      })
      break
    }
    case 'delete_post': {
      const targetSeq = Number(e.targetSeq)
      const target = feed.posts.find((p) => p.seq === targetSeq)
      if (target) target.deleted = true
      break
    }
    case 'repost':
      if (typeof e.post === 'string') feed.reposts.add(e.post)
      break
    case 'unrepost':
      if (typeof e.post === 'string') feed.reposts.delete(e.post)
      break
    case 'follow':
      feed.follows.add(e.key)
      if (isKey(e.key)) openFeed(b4a.from(e.key, 'hex')).catch(noop)
      break
    case 'unfollow':
      feed.follows.delete(e.key)
      break
    case 'like':
      feed.likes.add(e.post)
      break
    case 'unlike':
      feed.likes.delete(e.post)
      break
    case 'vote':
      if (typeof e.post === 'string') {
        feed.votes.set(e.post, Number(e.option) || 0)
      }
      break
    case 'bookmark':
      if (typeof e.post === 'string') feed.bookmarks.add(e.post)
      break
    case 'unbookmark':
      if (typeof e.post === 'string') feed.bookmarks.delete(e.post)
      break
    case 'block':
      if (isKey(e.key)) feed.blocks.add(e.key)
      break
    case 'unblock':
      if (isKey(e.key)) feed.blocks.delete(e.key)
      break
    case 'mute':
      if (isKey(e.key)) feed.mutes.add(e.key)
      break
    case 'unmute':
      if (isKey(e.key)) feed.mutes.delete(e.key)
      break
    case 'dm': {
      if (isKey(e.to) && typeof e.text === 'string') {
        feed.dms.push({
          seq,
          to: e.to,
          text: String(e.text).slice(0, 2000),
          media: Array.isArray(e.media) ? e.media.slice(0, 2).map((m) => String(m).slice(0, 350000)) : [],
          ts: Number(e.ts) || 0
        })
      }
      break
    }
  }
}

// --- state snapshot ----------------------------------------------------

let stateTimer = null
function scheduleState() {
  if (!me || !me.key) return
  if (stateTimer) return
  stateTimer = setTimeout(() => {
    stateTimer = null
    const s = snapshot()
    if (s) send(s)
  }, 100)
}

function snapshot() {
  if (!me || !me.key) return null
  const myHex = b4a.toString(me.key, 'hex')
  const myFeed = feeds.get(myHex) || {
    profile: null,
    follows: new Set(),
    likes: new Set(),
    reposts: new Set(),
    bookmarks: new Set(),
    blocks: new Set(),
    mutes: new Set(),
    votes: new Map()
  }

  const profiles = {}
  const rawPosts = []
  const likes = {}
  const reposts = {}
  const followers = {}
  const pollVotes = {}
  const hashtagCounts = {}
  const dmsByPeer = {}
  const postReposts = {}

  for (const [hex, feed] of feeds) {
    profiles[hex] = {
      ...(feed.profile || { name: '', bio: '', avatar: '', banner: '', location: '', website: '', pinnedPost: null }),
      length: feed.core.length,
      following: [...feed.follows]
    }

    for (const k of feed.follows) {
      followers[k] = (followers[k] || 0) + 1
    }

    for (const id of feed.likes) {
      likes[id] = (likes[id] || 0) + 1
    }

    for (const id of feed.reposts) {
      reposts[id] = (reposts[id] || 0) + 1
      if (!postReposts[id]) postReposts[id] = []
      postReposts[id].push(hex)
    }

    for (const [postId, optIdx] of feed.votes) {
      if (!pollVotes[postId]) pollVotes[postId] = { counts: {}, total: 0 }
      pollVotes[postId].counts[optIdx] = (pollVotes[postId].counts[optIdx] || 0) + 1
      pollVotes[postId].total++
    }

    for (const p of feed.posts) {
      if (p.deleted) continue
      const postId = hex + ':' + p.seq
      rawPosts.push({ id: postId, author: hex, ...p })
      if (Array.isArray(p.tags)) {
        for (const tag of p.tags) {
          const t = tag.toLowerCase()
          hashtagCounts[t] = (hashtagCounts[t] || 0) + 1
        }
      }
    }

    // DMs involving me
    for (const dm of feed.dms) {
      if (hex === myHex) {
        const peer = dm.to
        if (!dmsByPeer[peer]) dmsByPeer[peer] = []
        dmsByPeer[peer].push({
          id: hex + ':' + dm.seq,
          from: hex,
          to: peer,
          text: dm.text,
          media: dm.media,
          ts: dm.ts
        })
      } else if (dm.to === myHex) {
        const peer = hex
        if (!dmsByPeer[peer]) dmsByPeer[peer] = []
        dmsByPeer[peer].push({
          id: hex + ':' + dm.seq,
          from: hex,
          to: myHex,
          text: dm.text,
          media: dm.media,
          ts: dm.ts
        })
      }
    }
  }

  for (const peer in dmsByPeer) {
    dmsByPeer[peer].sort((a, b) => a.ts - b.ts)
  }

  for (const postId in pollVotes) {
    if (myFeed.votes && myFeed.votes.has(postId)) {
      pollVotes[postId].myVote = myFeed.votes.get(postId)
    }
  }

  rawPosts.sort((a, b) => b.ts - a.ts)

  const trendingTags = Object.entries(hashtagCounts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  // Notifications
  const notifications = []
  for (const [hex, feed] of feeds) {
    if (hex === myHex) continue
    if (myFeed.blocks?.has(hex) || myFeed.mutes?.has(hex)) continue

    for (const postId of feed.likes) {
      if (postId.startsWith(myHex + ':')) {
        notifications.push({
          type: 'like',
          id: 'like:' + hex + ':' + postId,
          actor: hex,
          targetPostId: postId,
          ts: Date.now()
        })
      }
    }

    for (const postId of feed.reposts) {
      if (postId.startsWith(myHex + ':')) {
        notifications.push({
          type: 'repost',
          id: 'repost:' + hex + ':' + postId,
          actor: hex,
          targetPostId: postId,
          ts: Date.now()
        })
      }
    }

    if (feed.follows.has(myHex)) {
      notifications.push({
        type: 'follow',
        id: 'follow:' + hex,
        actor: hex,
        ts: Date.now()
      })
    }

    for (const p of feed.posts) {
      if (p.deleted) continue
      const pid = hex + ':' + p.seq
      if (p.replyTo && p.replyTo.startsWith(myHex + ':')) {
        notifications.push({
          type: 'reply',
          id: 'reply:' + pid,
          actor: hex,
          targetPostId: p.replyTo,
          replyPostId: pid,
          text: p.text,
          ts: p.ts
        })
      }
      if (p.quoteOf && p.quoteOf.startsWith(myHex + ':')) {
        notifications.push({
          type: 'quote',
          id: 'quote:' + pid,
          actor: hex,
          targetPostId: p.quoteOf,
          quotePostId: pid,
          text: p.text,
          ts: p.ts
        })
      }
      const myName = myFeed.profile?.name
      const myShort = myHex.slice(0, 8)
      if (
        p.text &&
        (p.text.toLowerCase().includes('@' + myShort.toLowerCase()) ||
          (myName && p.text.toLowerCase().includes('@' + myName.toLowerCase())))
      ) {
        notifications.push({
          type: 'mention',
          id: 'mention:' + pid,
          actor: hex,
          post: { id: pid, text: p.text },
          ts: p.ts
        })
      }
    }
  }
  notifications.sort((a, b) => b.ts - a.ts)

  return {
    type: 'state',
    me: myHex,
    peers: swarm.connections.size,
    profiles,
    posts: rawPosts.slice(0, 1000),
    postReposts,
    likes,
    reposts,
    followers,
    likedByMe: myFeed.likes ? [...myFeed.likes] : [],
    repostedByMe: myFeed.reposts ? [...myFeed.reposts] : [],
    bookmarkedByMe: myFeed.bookmarks ? [...myFeed.bookmarks] : [],
    blockedByMe: myFeed.blocks ? [...myFeed.blocks] : [],
    mutedByMe: myFeed.mutes ? [...myFeed.mutes] : [],
    pollVotes,
    trendingTags,
    dms: dmsByPeer,
    notifications: notifications.slice(0, 100)
  }
}

// --- discovery ---------------------------------------------------------

function knownKeys() {
  return [...feeds.values()].map((f) => f.core.key).filter(Boolean)
}

function broadcastKeys(keys) {
  for (const ch of channels) ch.messages[0].send(keys)
}

swarm.on('connection', (conn, info) => {
  const stream = store.replicate(conn)
  const mux = Protomux.from(stream.noiseStream)

  const channel = mux.createChannel({
    protocol: PROTOCOL,
    onopen() {
      channels.add(channel)
      channel.messages[0].send(knownKeys())
    },
    onclose() {
      channels.delete(channel)
    }
  })
  if (!channel) return

  channel.addMessage({
    encoding: c.array(c.fixed32),
    onmessage(keys) {
      for (const key of keys.slice(0, 1000)) openFeed(key).catch(noop)
    }
  })
  channel.open()

  conn.on('error', noop)
  conn.on('close', () => { if (me && me.key) scheduleState() })
  log('peer connected', info.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 8) : 'unknown')
  if (me && me.key) scheduleState()
})

// --- commands from the UI ----------------------------------------------

async function handle(msg) {
  await readyPromise
  const ts = Date.now()
  switch (msg.cmd) {
    case 'post': {
      const text = String(msg.text || '').trim().slice(0, MAX_POST)
      if (!text && (!msg.media || !msg.media.length) && !msg.poll) return
      const entry = {
        type: 'post',
        text,
        ts,
        replyTo: msg.replyTo || undefined,
        quoteOf: msg.quoteOf || undefined,
        media: Array.isArray(msg.media) ? msg.media.slice(0, 4) : undefined,
        poll: msg.poll || undefined,
        tags: Array.isArray(msg.tags) ? msg.tags : undefined
      }
      await me.append(entry)
      break
    }
    case 'delete_post': {
      const [authorHex, seqStr] = String(msg.id || '').split(':')
      const myHex = b4a.toString(me.key, 'hex')
      if (authorHex === myHex) {
        await me.append({ type: 'delete_post', targetSeq: Number(seqStr), ts })
      }
      break
    }
    case 'profile':
      await me.append({
        type: 'profile',
        name: msg.name,
        bio: msg.bio,
        avatar: msg.avatar,
        banner: msg.banner,
        location: msg.location,
        website: msg.website,
        pinnedPost: msg.pinnedPost,
        ts
      })
      break
    case 'repost':
    case 'unrepost':
      if (typeof msg.id !== 'string') throw new Error('invalid post id')
      await me.append({ type: msg.cmd, post: msg.id, ts })
      break
    case 'like':
    case 'unlike':
      await me.append({ type: msg.cmd, post: msg.id, ts })
      break
    case 'vote':
      if (typeof msg.id !== 'string') throw new Error('invalid post id')
      await me.append({ type: 'vote', post: msg.id, option: Number(msg.option) || 0, ts })
      break
    case 'bookmark':
    case 'unbookmark':
      if (typeof msg.id !== 'string') throw new Error('invalid post id')
      await me.append({ type: msg.cmd, post: msg.id, ts })
      break
    case 'block':
    case 'unblock':
      if (!isKey(msg.key)) throw new Error('invalid key')
      await me.append({ type: msg.cmd, key: msg.key, ts })
      break
    case 'mute':
    case 'unmute':
      if (!isKey(msg.key)) throw new Error('invalid key')
      await me.append({ type: msg.cmd, key: msg.key, ts })
      break
    case 'dm': {
      if (!isKey(msg.to)) throw new Error('invalid recipient key')
      const text = String(msg.text || '').trim().slice(0, 2000)
      if (!text && (!msg.media || !msg.media.length)) return
      await openFeed(b4a.from(msg.to, 'hex')).catch(noop)
      await me.append({
        type: 'dm',
        to: msg.to,
        text,
        media: Array.isArray(msg.media) ? msg.media.slice(0, 2) : undefined,
        ts
      })
      break
    }
    case 'follow':
    case 'unfollow':
      if (!isKey(msg.key)) throw new Error('invalid key')
      await me.append({ type: msg.cmd, key: msg.key, ts })
      break
    case 'add':
      if (!isKey(msg.key)) throw new Error('invalid key')
      await openFeed(b4a.from(msg.key, 'hex'))
      break
    case 'refresh':
      scheduleState()
      break
    default:
      throw new Error('unknown command ' + msg.cmd)
  }
}

let buffered = ''
stdin.on('data', (data) => {
  buffered += b4a.toString(data)
  let i
  while ((i = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, i).trim()
    buffered = buffered.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg).catch((err) => send({ type: 'error', message: err.message }))
  }
})

// The shell closes stdin when it quits: shut down cleanly.
stdin.on('end', shutdown)

let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  log('shutting down')
  await swarm.destroy()
  await store.close()
  Bare.exit(0)
}

// --- boot --------------------------------------------------------------

async function main() {
  me = store.get({ name: 'feed', valueEncoding: 'json' })
  await me.ready()
  const feed = emptyIndex(me)
  feeds.set(b4a.toString(me.key, 'hex'), feed)
  me.on('append', () => index(b4a.toString(me.key, 'hex')))
  await index(b4a.toString(me.key, 'hex'))
  readyResolve()

  // Re-open every feed we've seen before so it keeps syncing.
  for (const k of loadKnown()) openFeed(b4a.from(k, 'hex')).catch(noop)

  const discovery = swarm.join(TOWN_SQUARE, { server: true, client: true })
  // Re-query the topic now and then, so peers that joined at the same moment still meet.
  const refresh = setInterval(() => discovery.refresh().catch(noop), 15000)
  refresh.unref?.()
  log('ready, feed', b4a.toString(me.key, 'hex'), 'storage', storage)
  send({ type: 'ready', me: b4a.toString(me.key, 'hex') })
  scheduleState()
}

main().catch((err) => {
  log('fatal', err.stack)
  send({ type: 'error', message: err.message })
})
