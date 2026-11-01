// End-to-end backend test: two Bare backends on a local DHT testnet.
// Checks discovery, replication, profiles, likes, follows, replies, reposts, polls, DMs and clean shutdown.
// Run: node test/e2e.js
const createTestnet = require('hyperdht/testnet')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const BARE = path.join(ROOT, 'node_modules', `bare-runtime-${process.platform}-${process.arch}`, 'bin', 'bare')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-social-e2e-'))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function peer(name, bootstrap) {
  const p = spawn(BARE, [path.join(ROOT, 'backend/index.js'), path.join(tmp, name), bootstrap])
  let buf = ''
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (msg.type === 'state') p.state = msg
    }
  })
  p.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(name + ' ' + d))
  p.cmd = (o) => p.stdin.write(JSON.stringify(o) + '\n')
  return p
}

async function until(fn, ms = 40000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(250)) if (fn()) return
  throw new Error('timed out')
}

function check(ok, label) {
  console.log((ok ? 'ok   ' : 'FAIL ') + label)
  if (!ok) process.exitCode = 1
}

;(async () => {
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap.map((b) => b.host + ':' + b.port).join(',')
  const a = peer('alice', bootstrap)
  const b = peer('bob', bootstrap)

  await until(() => a.state && b.state)
  a.cmd({ cmd: 'profile', name: 'Alice', bio: 'Decentralized hacker', location: 'P2P mesh' })
  a.cmd({ cmd: 'post', text: 'hello p2p world #tech' })
  b.cmd({ cmd: 'profile', name: 'Bob' })

  await until(() => b.state.posts.some((p) => p.text.includes('hello p2p world')))
  const post = b.state.posts.find((p) => p.text.includes('hello p2p world'))
  check(true, 'bob receives alice post')

  b.cmd({ cmd: 'like', id: post.id })
  b.cmd({ cmd: 'follow', key: a.state.me })
  b.cmd({ cmd: 'repost', id: post.id })
  b.cmd({ cmd: 'post', text: 'gm alice', replyTo: post.id })

  await until(
    () =>
      a.state.posts.some((p) => p.replyTo === post.id) &&
      a.state.likes[post.id] &&
      a.state.reposts[post.id]
  )
  check(a.state.likes[post.id] === 1, 'alice sees the like')
  check(a.state.reposts[post.id] === 1, 'alice sees the repost')
  check(a.state.followers[a.state.me] === 1, 'alice sees the follower')
  check(a.state.profiles[b.state.me]?.name === 'Bob', 'alice sees bob profile')
  check(true, 'alice sees the reply')

  // Test Poll & Voting
  a.cmd({
    cmd: 'post',
    text: 'Favorite transport?',
    poll: { question: 'Favorite transport?', options: ['UDX', 'TCP', 'WebRTC'] }
  })
  await until(() => b.state.posts.some((p) => p.poll?.question === 'Favorite transport?'))
  const pollPost = b.state.posts.find((p) => p.poll?.question === 'Favorite transport?')
  check(true, 'bob sees poll post')

  b.cmd({ cmd: 'vote', id: pollPost.id, option: 0 })
  await until(() => a.state.pollVotes[pollPost.id]?.counts[0] === 1)
  check(a.state.pollVotes[pollPost.id]?.total === 1, 'alice sees poll vote from bob')

  // Test DMs
  b.cmd({ cmd: 'dm', to: a.state.me, text: 'secret message' })
  await until(() => a.state.dms[b.state.me]?.some((m) => m.text === 'secret message'))
  check(true, 'alice receives DM from bob')

  // Clean shutdown
  a.stdin.end()
  b.stdin.end()
  await wait(1500)
  check(a.exitCode === 0 && b.exitCode === 0, 'clean shutdown on stdin close')

  await testnet.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
})().catch((err) => {
  console.error('FAIL', err.message)
  process.exit(1)
})
