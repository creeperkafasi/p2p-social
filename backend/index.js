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
const MAX_POST = 280

const stdin = new Pipe(0)
const stdout = new Pipe(1)

const store = new Corestore(storage)
const swarm = new Hyperswarm({ bootstrap })

const feeds = new Map() // hex key -> feed index
const channels = new Set()
let me = null

function log(...args) {
  console.error('[backend]', ...args)
}

function send(msg) {
  stdout.write(JSON.stringify(msg) + '\n')
}

// --- feeds -------------------------------------------------------------

function emptyIndex(core) {
  return {
    core,
    indexed: 0,
    indexing: null,
    profile: null,
    posts: [], // { seq, text, ts, replyTo }
    follows: new Set(),
    likes: new Set() // "author:seq"
  }
}

async function openFeed(key) {
  const hex = b4a.toString(key, 'hex')
  if (feeds.has(hex)) return feeds.get(hex)

  const core = store.get({ key, valueEncoding: 'json' })
  const feed = emptyIndex(core)
  feeds.set(hex, feed)
  await core.ready()

  core.on('append', () => index(hex))
  core.download({ start: 0, end: -1 }) // keep the whole feed, live
  index(hex)
  broadcastKeys([key])
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
      feed.profile = { name: String(e.name || '').slice(0, 50), bio: String(e.bio || '').slice(0, 160) }
      break
    case 'post':
      feed.posts.push({
        seq,
        text: String(e.text || '').slice(0, MAX_POST),
        ts: Number(e.ts) || 0,
        replyTo: typeof e.replyTo === 'string' ? e.replyTo : null
      })
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
  }
}

// --- state snapshot ----------------------------------------------------

let stateTimer = null
function scheduleState() {
  if (stateTimer) return
  stateTimer = setTimeout(() => {
    stateTimer = null
    send(snapshot())
  }, 100)
}

function snapshot() {
  const myHex = b4a.toString(me.key, 'hex')
  const profiles = {}
  const posts = []
  const likes = {}
  const followers = {}

  for (const [hex, feed] of feeds) {
    profiles[hex] = { ...(feed.profile || { name: '', bio: '' }), length: feed.core.length, following: [...feed.follows] }
    for (const p of feed.posts) posts.push({ id: hex + ':' + p.seq, author: hex, ...p })
    for (const id of feed.likes) likes[id] = (likes[id] || 0) + 1
    for (const k of feed.follows) followers[k] = (followers[k] || 0) + 1
  }

  posts.sort((a, b) => b.ts - a.ts)

  return {
    type: 'state',
    me: myHex,
    peers: swarm.connections.size,
    profiles,
    posts: posts.slice(0, 1000),
    likes,
    followers,
    likedByMe: [...feeds.get(myHex).likes]
  }
}

// --- discovery ---------------------------------------------------------

function knownKeys() {
  return [...feeds.values()].map((f) => f.core.key)
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
  conn.on('close', scheduleState)
  log('peer connected', b4a.toString(info.publicKey, 'hex').slice(0, 8))
  scheduleState()
})

// --- commands from the UI ----------------------------------------------

async function handle(msg) {
  const ts = Date.now()
  switch (msg.cmd) {
    case 'post': {
      const text = String(msg.text || '').trim().slice(0, MAX_POST)
      if (!text) return
      await me.append({ type: 'post', text, ts, replyTo: msg.replyTo || undefined })
      break
    }
    case 'profile':
      await me.append({ type: 'profile', name: msg.name, bio: msg.bio, ts })
      break
    case 'follow':
    case 'unfollow':
      if (!isKey(msg.key)) throw new Error('invalid key')
      await me.append({ type: msg.cmd, key: msg.key, ts })
      break
    case 'like':
    case 'unlike':
      await me.append({ type: msg.cmd, post: msg.id, ts })
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

function isKey(k) {
  return typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)
}

function noop() {}

async function main() {
  me = store.get({ name: 'feed', valueEncoding: 'json' })
  await me.ready()
  const feed = emptyIndex(me)
  feeds.set(b4a.toString(me.key, 'hex'), feed)
  me.on('append', () => index(b4a.toString(me.key, 'hex')))
  await index(b4a.toString(me.key, 'hex'))

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
