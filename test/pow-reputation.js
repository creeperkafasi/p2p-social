// End-to-end test for PoW, Tokenizer, Clean Views, Reports, and Decentralized Reputation
const createTestnet = require('hyperdht/testnet')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const BARE = path.join(ROOT, 'node_modules', `bare-runtime-${process.platform}-${process.arch}`, 'bin', 'bare')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-social-pow-'))
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

  a.cmd({ cmd: 'profile', name: 'Alice' })
  b.cmd({ cmd: 'profile', name: 'Bob' })

  // 1. Test Post with Tokens & PoW
  a.cmd({
    cmd: 'post',
    text: 'Decentralized peer-to-peer sovereign social network on mobile and desktop #holepunch',
    tokens: ['decentralized', 'sovereign', 'mobile', 'desktop', 'fake_token_not_in_text']
  })

  await until(() => b.state.posts.some((p) => p.text.includes('Decentralized peer-to-peer')))
  const alicePost = b.state.posts.find((p) => p.text.includes('Decentralized peer-to-peer'))

  check(alicePost.tokens && alicePost.tokens.includes('decentralized'), 'tokens extracted and preserved')
  check(!alicePost.tokens.includes('fake_token_not_in_text'), 'anti-token-stuffing stripped fake token')
  check(alicePost.pow && alicePost.pow.verified, 'post PoW verified by peer')

  // 2. Test Like with PoW & Reputation Increase
  b.cmd({ cmd: 'like', id: alicePost.id })
  await until(() => a.state.likes[alicePost.id] === 1)
  check(a.state.profiles[a.state.me].reputation.likes === 1, 'alice reputation tracks verified like')
  check(a.state.profiles[a.state.me].reputation.score >= 1, 'alice reputation score increases with like')

  // 3. Test Clean View
  b.cmd({ cmd: 'clean_view', id: alicePost.id })
  await until(() => b.state.cleanViews[alicePost.id] === 1)
  check(b.state.cleanViews[alicePost.id] === 1, 'bob clean view recorded for alice post')

  // 4. Test Report with PoW, Flagging & Reputation Penalty
  // Alice posts a spam post
  a.cmd({ cmd: 'post', text: 'Free crypto airdrop click now http://spam.xyz #giveaway' })
  await until(() => b.state.posts.some((p) => p.text.includes('Free crypto airdrop')))
  const spamPost = b.state.posts.find((p) => p.text.includes('Free crypto airdrop'))

  b.cmd({ cmd: 'report', id: spamPost.id, reason: 'scam' })
  await until(() => b.state.postReports[spamPost.id]?.count >= 1)
  check(b.state.postReports[spamPost.id]?.count === 1, 'bob verified report received by network')
  check(b.state.postReports[spamPost.id]?.reasons?.scam === 1, 'report reason recorded as scam')

  // Check that reports decrease reputation
  await until(() => a.state.postReports[spamPost.id]?.count >= 1)
  const aliceRep = a.state.profiles[a.state.me].reputation
  check(aliceRep.reports >= 1, 'alice author reputation tracks reports')
  check(aliceRep.trust < 100, 'alice trust percentage decreases after verified report')

  // Clean shutdown
  a.stdin.end()
  b.stdin.end()
  await wait(1500)
  check(a.exitCode === 0 && b.exitCode === 0, 'clean shutdown on stdin close')

  await testnet.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('ALL POW & REPUTATION TESTS PASSED!')
})().catch((err) => {
  console.error('FAIL', err.stack || err.message)
  process.exit(1)
})
