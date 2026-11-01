// Webview UI. Talks to the Bare backend through the Tauri shell:
//   send(obj)               -> backend stdin
//   'backend' event (line)  <- backend stdout
const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

const MAX_POST = 280
const main = document.getElementById('main')

let state = null
let route = { view: 'home' }
let askedSetup = false

function send(obj) {
  return invoke('send', { msg: JSON.stringify(obj) }).catch((err) => toast(String(err)))
}

listen('backend', (event) => {
  let msg
  try {
    msg = JSON.parse(event.payload)
  } catch {
    return
  }
  if (msg.type === 'state') {
    state = msg
    render()
  } else if (msg.type === 'error') {
    toast(msg.message)
  }
})
listen('backend-exit', () => toast('Backend stopped. Check the terminal for errors.'))

// --- helpers -----------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}
function short(key) {
  return key.slice(0, 8)
}
function nameOf(key) {
  return state.profiles[key]?.name || 'anon-' + short(key)
}
function color(key) {
  return `hsl(${parseInt(key.slice(0, 6), 16) % 360} 65% 45%)`
}
function avatar(key, big) {
  return `<div class="avatar${big ? ' big' : ''}" style="background:${color(key)}" data-profile="${key}">${esc(nameOf(key)[0].toUpperCase())}</div>`
}
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return Math.floor(s) + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return new Date(ts).toLocaleDateString()
}
function toast(text) {
  const el = document.getElementById('toast')
  el.textContent = text
  el.classList.add('show')
  clearTimeout(toast.t)
  toast.t = setTimeout(() => el.classList.remove('show'), 2500)
}
function following() {
  return new Set(state.profiles[state.me]?.following || [])
}
function replyCount(id) {
  return state.posts.filter((p) => p.replyTo === id).length
}

// --- components --------------------------------------------------------

function postHtml(p, focus) {
  const liked = state.likedByMe.includes(p.id)
  const parent = p.replyTo && state.posts.find((x) => x.id === p.replyTo)
  return `
    <article class="post${focus ? ' focus' : ''}" data-thread="${p.id}">
      ${avatar(p.author)}
      <div class="body">
        <div class="meta">
          <span class="name" data-profile="${p.author}">${esc(nameOf(p.author))}</span>
          <span>@${short(p.author)}</span><span>·</span><span>${ago(p.ts)}</span>
        </div>
        ${p.replyTo ? `<div class="replying">Replying to ${parent ? '@' + esc(short(parent.author)) : 'a post'}</div>` : ''}
        <div class="text">${esc(p.text)}</div>
        <div class="actions">
          <button data-reply="${p.id}">💬 ${replyCount(p.id) || ''}</button>
          <button class="like${liked ? ' liked' : ''}" data-like="${p.id}">${liked ? '♥' : '♡'} ${state.likes[p.id] || ''}</button>
        </div>
      </div>
    </article>`
}

function composeHtml(replyTo) {
  return `
    <form class="compose" data-compose="${replyTo || ''}">
      ${avatar(state.me)}
      <div style="flex:1">
        <textarea name="text" rows="2" placeholder="${replyTo ? 'Post your reply' : "What's happening?"}"></textarea>
        <div class="row"><span class="count"></span><button class="primary" disabled>${replyTo ? 'Reply' : 'Post'}</button></div>
      </div>
    </form>`
}

function feedHtml(posts, emptyText) {
  return posts.length ? posts.map((p) => postHtml(p)).join('') : `<div class="empty">${emptyText}</div>`
}

// --- views -------------------------------------------------------------

const views = {
  home() {
    const f = following()
    const posts = state.posts.filter((p) => p.author === state.me || f.has(p.author))
    return `<div class="header">Home</div>${composeHtml()}${feedHtml(
      posts,
      'Your timeline is empty. Find people in <a href="#explore">Explore</a> and follow them.'
    )}`
  },

  explore() {
    return `<div class="header">Explore</div>
      <form class="addkey" id="addkey">
        <input name="key" placeholder="Paste someone's feed key to add them manually" />
        <button class="outline">Add</button>
      </form>
      ${feedHtml(state.posts, 'No posts yet. Peers on the network show up here as they connect.')}`
  },

  profile(key) {
    key = key || state.me
    const prof = state.profiles[key] || { name: '', bio: '', following: [] }
    const mine = key === state.me
    const isFollowing = following().has(key)
    const posts = state.posts.filter((p) => p.author === key)
    const btn = mine
      ? `<button class="outline" id="edit-profile">Edit profile</button>`
      : `<button class="${isFollowing ? 'outline' : 'primary'}" data-follow="${key}">${isFollowing ? 'Unfollow' : 'Follow'}</button>`
    return `<div class="header"><button class="back" data-back>←</button>${esc(nameOf(key))}</div>
      <div class="profile">
        <div class="top">${avatar(key, true)}${btn}</div>
        <h2>${esc(nameOf(key))}</h2>
        <div class="key">${key}</div>
        ${prof.bio ? `<p>${esc(prof.bio)}</p>` : ''}
        <div class="stats">
          <span><b>${prof.following?.length || 0}</b> Following</span>
          <span><b>${state.followers[key] || 0}</b> Followers</span>
          <span><b>${posts.length}</b> Posts</span>
        </div>
      </div>
      ${feedHtml(posts, mine ? 'You have not posted yet.' : 'No posts synced yet.')}`
  },

  thread(id) {
    const post = state.posts.find((p) => p.id === id)
    if (!post) return `<div class="header"><button class="back" data-back>←</button>Post</div><div class="empty">Post not found (yet).</div>`
    const replies = state.posts.filter((p) => p.replyTo === id).reverse()
    return `<div class="header"><button class="back" data-back>←</button>Post</div>
      ${postHtml(post, true)}${composeHtml(id)}${feedHtml(replies, 'No replies yet.')}`
  }
}

function render() {
  if (!state) return
  document.getElementById('net-peers').textContent = `${state.peers} peer${state.peers === 1 ? '' : 's'} connected`
  document.getElementById('net-dot').classList.toggle('on', state.peers > 0)
  for (const a of document.querySelectorAll('.sidebar a')) {
    a.classList.toggle('active', a.dataset.view === route.view && (route.view !== 'profile' || !route.arg || route.arg === state.me))
  }

  if (!state.profiles[state.me]?.name && !askedSetup) {
    askedSetup = true
    document.getElementById('setup').showModal()
  }

  // Keep a half-written post and the cursor across re-renders.
  const active = document.activeElement
  const draft = active?.name === 'text' ? { compose: active.form.dataset.compose, value: active.value, pos: active.selectionStart } : null
  const scroll = window.scrollY

  main.innerHTML = views[route.view](route.arg)

  if (draft) {
    const ta = main.querySelector(`form[data-compose="${draft.compose}"] textarea`)
    if (ta) {
      ta.value = draft.value
      ta.focus()
      ta.setSelectionRange(draft.pos, draft.pos)
      updateCount(ta)
    }
  }
  window.scrollTo(0, scroll)
}

// --- routing -----------------------------------------------------------

function go(view, arg) {
  const hash = '#' + view + (arg ? '/' + arg : '')
  if (location.hash !== hash) location.hash = hash
  else onHash()
}
function onHash() {
  const [view, arg] = location.hash.slice(1).split('/')
  route = { view: views[view] ? view : 'home', arg }
  render()
  window.scrollTo(0, 0)
}
window.addEventListener('hashchange', onHash)

// --- events ------------------------------------------------------------

function updateCount(ta) {
  const form = ta.form
  const left = MAX_POST - ta.value.length
  const count = form.querySelector('.count')
  count.textContent = ta.value ? left : ''
  count.classList.toggle('over', left < 0)
  form.querySelector('button').disabled = !ta.value.trim() || left < 0
}

main.addEventListener('input', (e) => {
  if (e.target.name === 'text') updateCount(e.target)
})

main.addEventListener('keydown', (e) => {
  if (e.target.name === 'text' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.target.form.requestSubmit()
})

main.addEventListener('submit', (e) => {
  e.preventDefault()
  const form = e.target
  if (form.id === 'addkey') {
    const key = form.key.value.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(key)) return toast('A feed key is 64 hex characters')
    send({ cmd: 'add', key })
    form.reset()
    go('profile', key)
    return
  }
  const text = form.text.value.trim()
  if (!text || text.length > MAX_POST) return
  send({ cmd: 'post', text, replyTo: form.dataset.compose || undefined })
  form.text.value = ''
  form.text.blur()
  updateCount(form.text)
})

main.addEventListener('click', (e) => {
  const t = e.target.closest('[data-profile],[data-like],[data-reply],[data-follow],[data-back],#edit-profile,[data-thread]')
  if (!t || e.target.closest('textarea,input,a')) return
  e.stopPropagation()
  const d = t.dataset
  if (d.profile) go('profile', d.profile)
  else if (d.like) send({ cmd: state.likedByMe.includes(d.like) ? 'unlike' : 'like', id: d.like })
  else if (d.reply) go('thread', d.reply)
  else if (d.follow) send({ cmd: following().has(d.follow) ? 'unfollow' : 'follow', key: d.follow })
  else if ('back' in d) history.length > 1 ? history.back() : go('home')
  else if (t.id === 'edit-profile') openSetup()
  else if (d.thread && route.arg !== d.thread) go('thread', d.thread)
})

function openSetup() {
  const form = document.getElementById('setup-form')
  const prof = state.profiles[state.me] || {}
  form.name.value = prof.name || ''
  form.bio.value = prof.bio || ''
  document.getElementById('setup').showModal()
}

document.getElementById('setup-form').addEventListener('submit', (e) => {
  const form = e.target
  send({ cmd: 'profile', name: form.name.value.trim(), bio: form.bio.value.trim() })
})

document.getElementById('copy-key').addEventListener('click', async () => {
  if (!state) return
  try {
    await navigator.clipboard.writeText(state.me)
    toast('Feed key copied')
  } catch {
    prompt('Your feed key', state.me)
  }
})

// Relative timestamps drift; refresh them now and then.
setInterval(() => document.activeElement?.name !== 'text' && render(), 30000)

onHash()
send({ cmd: 'refresh' })
