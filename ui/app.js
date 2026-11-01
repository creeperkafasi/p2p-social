// Webview UI for p2p-social.
// Talks to the Bare backend through the Tauri shell stdio bridge.

const tauri = window.__TAURI__
const invoke = tauri?.core?.invoke || (() => Promise.resolve())
const listen = tauri?.event?.listen || (() => {})

let state = null
let route = { view: 'home', arg: null, sub: null }
let askedSetup = false

// Draft states for composers
let homeDraft = { text: '', media: [], poll: null, showPoll: false, showEmoji: false }
let replyDrafts = {} // postId -> { text, media }
let dmDraft = { text: '', media: [] }
let activeDmPeer = null
let quoteTarget = null

// Modals
const setupDialog = document.getElementById('setup')
const editProfileDialog = document.getElementById('edit-profile-modal')
const quoteDialog = document.getElementById('quote-modal')
const qrDialog = document.getElementById('qr-modal')
const networkDialog = document.getElementById('network-modal')
const updateDialog = document.getElementById('update-modal')
const lightboxDialog = document.getElementById('lightbox')
const toastEl = document.getElementById('toast')
const postOptsDialog = document.getElementById('post-opts-sheet')
const reportDialog = document.getElementById('report-modal')
const confirmDialog = document.getElementById('confirm-modal')

let activePostOptsId = null
let pendingConfirmCallback = null

// Backdrop click dismiss for bottom sheets
;[postOptsDialog, reportDialog, confirmDialog].forEach((dlg) => {
  if (!dlg) return
  dlg.addEventListener('click', (e) => {
    const rect = dlg.getBoundingClientRect()
    const isInDialog =
      rect.top <= e.clientY && e.clientY <= rect.top + rect.height && rect.left <= e.clientX && e.clientX <= rect.left + rect.width
    if (!isInDialog) {
      dlg.close()
    }
  })
})

// --- Theme Management ---
let currentTheme = localStorage.getItem('p2p_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') || 'dark'
document.documentElement.setAttribute('data-theme', currentTheme)

function updateThemeElements() {
  document.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
    btn.innerHTML = currentTheme === 'dark' ? '☀️' : '🌙'
    btn.setAttribute('title', currentTheme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode')
  })
  const sidebarBtn = document.getElementById('btn-theme-toggle')
  if (sidebarBtn) sidebarBtn.textContent = `Theme: ${currentTheme === 'dark' ? 'Dark' : 'Light'}`
}
updateThemeElements()

function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', currentTheme)
  localStorage.setItem('p2p_theme', currentTheme)
  updateThemeElements()
}

// --- Bridge ---

function send(obj) {
  return invoke('send', { msg: JSON.stringify(obj) }).catch((err) => toast(String(err)))
}

let listening = false
async function initBackendListeners() {
  if (listening || !tauri?.event?.listen) return
  try {
    await listen('backend', (event) => {
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
    await listen('backend-exit', () => toast('Backend stopped. Check terminal logs.'))
    listening = true
  } catch (err) {
    console.warn('Backend listen pending page readiness, retrying:', err)
    setTimeout(initBackendListeners, 300)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBackendListeners)
} else {
  initBackendListeners()
}

// --- Helpers ---

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

function short(key) {
  return (key || '').slice(0, 8)
}

function nameOf(key) {
  return state?.profiles?.[key]?.name || 'anon-' + short(key)
}

function color(key) {
  if (!key) return 'hsl(210, 65%, 45%)'
  const hue = parseInt(key.slice(0, 6), 16) % 360
  return `hsl(${hue}, 65%, 45%)`
}

function avatar(key, big = false) {
  const prof = state?.profiles?.[key]
  const letter = esc(nameOf(key)[0]?.toUpperCase() || '?')
  if (prof?.avatar) {
    return `<div class="avatar${big ? ' big' : ''}" style="background-image:url(${prof.avatar})" data-profile="${key}" title="${esc(nameOf(key))}"></div>`
  }
  return `<div class="avatar${big ? ' big' : ''}" style="background:${color(key)}" data-profile="${key}" title="${esc(nameOf(key))}">${letter}</div>`
}

function bannerGradient(key) {
  if (!key) return 'linear-gradient(135deg, #1d9bf0, #8b5cf6)'
  const h1 = parseInt(key.slice(0, 4), 16) % 360
  const h2 = (h1 + 60) % 360
  return `linear-gradient(135deg, hsl(${h1}, 70%, 50%), hsl(${h2}, 80%, 40%))`
}

function ago(ts) {
  if (!ts) return 'now'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return Math.floor(s) + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd'
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function toast(text) {
  if (!toastEl) return
  toastEl.textContent = text
  toastEl.classList.add('show')
  clearTimeout(toast.t)
  toast.t = setTimeout(() => toastEl.classList.remove('show'), 2600)
}

function following() {
  return new Set(state?.profiles?.[state?.me]?.following || [])
}

function isBlocked(key) {
  return state?.blockedByMe?.includes(key)
}

function isMuted(key) {
  return state?.mutedByMe?.includes(key)
}

function replyCount(id) {
  return state?.posts?.filter((p) => p.replyTo === id)?.length || 0
}

function repostCount(id) {
  return state?.reposts?.[id] || 0
}

function likeCount(id) {
  return state?.likes?.[id] || 0
}

function formatText(text) {
  if (!text) return ''
  let escaped = esc(text)
  // Autolink URLs
  escaped = escaped.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
  // Autolink Hashtags
  escaped = escaped.replace(/#([a-zA-Z0-9_\u00c0-\u017e]+)/g, '<span class="hashtag" data-search="#$1">#$1</span>')
  // Autolink Mentions
  escaped = escaped.replace(/@([a-zA-Z0-9_]{1,50})/g, (match, username) => {
    // Check if matching known profile name
    for (const [key, prof] of Object.entries(state?.profiles || {})) {
      if (prof.name?.toLowerCase() === username.toLowerCase() || short(key).toLowerCase() === username.toLowerCase()) {
        return `<span class="mention" data-profile="${key}">@${esc(prof.name || username)}</span>`
      }
    }
    return match
  })
  return escaped
}

// Client-side image resizing and compression using HTML5 Canvas
function compressImage(file, maxWidth = 800, maxHeight = 800, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = (e) => {
      const img = new Image()
      img.onerror = reject
      img.onload = () => {
        let w = img.width
        let h = img.height
        if (w > maxWidth || h > maxHeight) {
          const ratio = Math.min(maxWidth / w, maxHeight / h)
          w = Math.round(w * ratio)
          h = Math.round(h * ratio)
        }
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  })
}

// --- Components ---

function mediaGridHtml(media) {
  if (!media || !media.length) return ''
  const count = Math.min(media.length, 4)
  const cells = media
    .slice(0, 4)
    .map(
      (url, i) => `
    <div class="media-cell" data-lightbox="${url}">
      <img src="${url}" alt="Attachment ${i + 1}" loading="lazy" />
    </div>`
    )
    .join('')
  return `<div class="post-media-grid grid-${count}">${cells}</div>`
}

function pollHtml(p) {
  if (!p.poll) return ''
  const poll = p.poll
  const votes = state?.pollVotes?.[p.id] || { counts: {}, total: 0 }
  const total = votes.total || 0
  const hasVoted = votes.myVote !== undefined
  const isExpired = poll.expiresAt && Date.now() > poll.expiresAt

  if (!hasVoted && !isExpired && p.author !== state?.me) {
    const options = poll.options
      .map(
        (opt, idx) => `
      <button class="poll-option-btn" data-vote-post="${p.id}" data-vote-option="${idx}">
        ${esc(opt)}
      </button>`
      )
      .join('')
    return `
      <div class="post-poll-box">
        ${options}
        <div class="poll-meta">${total} vote${total === 1 ? '' : 's'} · Poll active</div>
      </div>`
  }

  // Show results
  const bars = poll.options
    .map((opt, idx) => {
      const count = votes.counts?.[idx] || 0
      const pct = total > 0 ? Math.round((count / total) * 100) : 0
      const isMyPick = votes.myVote === idx
      return `
      <div class="poll-result-bar">
        <div class="poll-result-fill" style="width: ${pct}%"></div>
        <div class="poll-result-text">
          <span>${esc(opt)} ${isMyPick ? '✓' : ''}</span>
          <span><b>${pct}%</b> (${count})</span>
        </div>
      </div>`
    })
    .join('')

  return `
    <div class="post-poll-box">
      ${bars}
      <div class="poll-meta">${total} vote${total === 1 ? '' : 's'} ${isExpired ? '· Final results' : ''}</div>
    </div>`
}

function quoteEmbedHtml(quoteOfId) {
  if (!quoteOfId) return ''
  const target = state?.posts?.find((p) => p.id === quoteOfId)
  if (!target) {
    return `<div class="quote-embed muted"><small>Referenced post not found</small></div>`
  }
  return `
    <div class="quote-embed" data-thread="${target.id}">
      <div class="quote-embed-meta">
        ${avatar(target.author)}
        <span class="quote-embed-name">${esc(nameOf(target.author))}</span>
        <span class="quote-embed-key">@${short(target.author)}</span>
        <span class="post-dot">·</span>
        <span class="post-time">${ago(target.ts)}</span>
      </div>
      <div class="post-text">${formatText(target.text)}</div>
      ${mediaGridHtml(target.media)}
    </div>`
}

// --- Client-Side FYP, Tokenizer & Taste Vector Engine ---

const CLIENT_STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during',
  'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how',
  'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'more', 'most', 'my', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'or', 'our', 'out', 'own',
  'she', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'with', 'you', 'your',
  'ama', 'ancak', 'artik', 'ben', 'beni', 'benim', 'beri', 'bile', 'bir', 'biri', 'birkac', 'biz', 'bize', 'bizi', 'bizim', 'boyle', 'bu', 'buna', 'bunda', 'bundan', 'bunu', 'bunun', 'burada', 'cunku', 'da', 'daha', 'de', 'degil', 'demek', 'diye', 'en', 'fakat', 'gibi', 'gore', 'hem', 'hep', 'hepsi', 'her', 'herkes', 'hic', 'icin', 'ile', 'ilgili', 'kadar', 'kendi', 'kendisi', 'ki', 'kim', 'nasil', 'ne', 'neden', 'nerede', 'olan', 'olarak', 'oldu', 'olmak', 'olur', 'ona', 'ondan', 'onlar', 'onu', 'onun', 'oysa', 'oyle', 'pek', 'sadece', 'sanki', 'sen', 'seni', 'senin', 'siz', 'sizi', 'sizin', 'sonra', 'sey', 'simdi', 'su', 'suna', 'sunu', 'tum', 'var', 've', 'veya', 'ya', 'yani', 'yok', 'zaten'
])

function extractClientTokens(text) {
  if (!text || typeof text !== 'string') return []
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@\S+/g, ' ')
    .normalize('NFKC')
    .toLowerCase()
  const words = cleaned.match(/[\p{L}\p{N}]+/gu) || []
  const tokens = []
  const seen = new Set()
  for (const w of words) {
    if (w.length < 3 || w.length > 25) continue
    if (CLIENT_STOP_WORDS.has(w)) continue
    if (!seen.has(w)) {
      seen.add(w)
      tokens.push(w)
      if (tokens.length >= 20) break
    }
  }
  return tokens
}

let revealedPosts = new Set()

function getTasteVector() {
  try {
    return JSON.parse(localStorage.getItem('p2p_taste_vector') || '{}')
  } catch {
    return {}
  }
}

function saveTasteVector(v) {
  try {
    const entries = Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, 120)
    localStorage.setItem('p2p_taste_vector', JSON.stringify(Object.fromEntries(entries)))
  } catch {}
}

function recordTaste(tokens, weight) {
  if (!Array.isArray(tokens) || !tokens.length) return
  const taste = getTasteVector()
  for (const t of tokens) {
    if (typeof t !== 'string') continue
    const tok = t.toLowerCase()
    taste[tok] = (taste[tok] || 0) + weight
  }
  saveTasteVector(taste)
}

function computeFypScore(post, taste) {
  const now = Date.now()
  const ageHours = Math.max(0, (now - (post.ts || now)) / 3600000)
  const recency = 1 / (1 + Math.pow(ageHours / 36, 1.3))

  let affinity = 0
  if (Array.isArray(post.tokens)) {
    for (const t of post.tokens) {
      const w = taste[t.toLowerCase()] || 0
      affinity += Math.min(w, 8.0)
    }
  }

  const likeCnt = state?.likes?.[post.id] || 0
  const repostCnt = state?.reposts?.[post.id] || 0
  const cleanViewCnt = post.cleanViewCount || 0
  const engagement = Math.log2(1 + likeCnt * 2.0 + repostCnt * 3.0 + cleanViewCnt * 0.3)

  const prof = state?.profiles?.[post.author]
  const repScore = prof?.reputation?.score || 0
  const repTrust = prof?.reputation?.trust !== undefined ? prof.reputation.trust : 100
  const repBonus = Math.min(repScore / 20.0, 3.0)
  const trustMultiplier = repTrust < 60 ? (repTrust / 100) : 1.0
  const reportPenalty = post.reportCount ? Math.pow(0.5, post.reportCount) : 1.0

  return recency * (affinity * 2.5 + engagement + repBonus + 1.0) * trustMultiplier * reportPenalty
}

function computeTrendingScore(post) {
  const now = Date.now()
  const ageHours = Math.max(0, (now - (post.ts || now)) / 3600000)
  const likeCnt = state?.likes?.[post.id] || 0
  const repostCnt = state?.reposts?.[post.id] || 0
  const cleanViewCnt = post.cleanViewCount || 0
  return (likeCnt * 2.5 + repostCnt * 3.5 + cleanViewCnt * 0.4) / Math.pow(ageHours + 2, 1.4)
}

// Clean View Tracker: Lurkers who dwell on a post >= 1.5s without reporting it
const cleanViewTimers = new Map()
const cleanViewObserved = new Set()
let postObserver = null

function setupPostIntersectionObserver() {
  if (postObserver) postObserver.disconnect()
  if (typeof IntersectionObserver === 'undefined') return

  postObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target
        const postId = el.dataset.thread
        if (!postId || cleanViewObserved.has(postId)) continue

        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          if (!cleanViewTimers.has(postId)) {
            const timer = setTimeout(() => {
              cleanViewTimers.delete(postId)
              if (!cleanViewObserved.has(postId)) {
                cleanViewObserved.add(postId)
                const p = (state?.posts || []).find((x) => x.id === postId)
                if (p) {
                  if (p.tokens && p.tokens.length) {
                    recordTaste(p.tokens, 0.5)
                  }
                  send({ cmd: 'clean_view', id: postId })
                }
              }
            }, 1500)
            cleanViewTimers.set(postId, timer)
          }
        } else {
          if (cleanViewTimers.has(postId)) {
            clearTimeout(cleanViewTimers.get(postId))
            cleanViewTimers.delete(postId)
          }
        }
      }
    },
    { threshold: [0.5] }
  )

  document.querySelectorAll('article.post[data-thread]').forEach((el) => {
    postObserver.observe(el)
  })
}

function postHtml(p, opts = {}) {
  const { focus = false, repostedBy = null } = opts
  const liked = state?.likedByMe?.includes(p.id)
  const reposted = state?.repostedByMe?.includes(p.id)
  const bookmarked = state?.bookmarkedByMe?.includes(p.id)
  const isMine = p.author === state?.me
  const parent = p.replyTo && state?.posts?.find((x) => x.id === p.replyTo)

  // Community Flagged Post Blur / Warning
  if (p.flagged && !revealedPosts.has(p.id)) {
    const reasons = p.flagReasons ? Object.keys(p.flagReasons).join(', ') : 'community reports'
    return `
      <div class="flagged-post-card" data-flagged-id="${p.id}">
        <div class="flagged-banner">
          <div class="flagged-text">
            <strong>⚠️ Content Flagged by Community</strong>
            <div class="muted" style="font-size:12px">Hidden due to peer reports (${esc(reasons)}).</div>
          </div>
          <button type="button" class="btn-sm outline" data-reveal-flagged="${p.id}">Reveal</button>
        </div>
      </div>`
  }

  // Author Sovereign Trust Badge
  const prof = state?.profiles?.[p.author]
  const rep = prof?.reputation
  let trustBadge = ''
  if (rep) {
    let trustClass = ''
    let trustIcon = '🛡️'
    if (rep.trust < 60) {
      trustClass = 'danger'
      trustIcon = '⚠️'
    } else if (rep.trust < 85) {
      trustClass = 'warn'
      trustIcon = '⚡'
    }
    trustBadge = `<span class="author-trust-pill ${trustClass}" title="Decentralized Trust: ${rep.trust}% (${rep.score} pts)">${trustIcon} ${rep.trust}%</span>`
  }

  const tokensRow = (Array.isArray(p.tokens) && p.tokens.length)
    ? `<div class="post-tokens-row">${p.tokens.slice(0, 5).map((t) => `<span class="post-token-tag">#${esc(t)}</span>`).join('')}</div>`
    : ''

  const repostHeader = repostedBy
    ? `<div class="post-repost-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 1l4 4-4 4"></path><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><path d="M7 23l-4-4 4-4"></path><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>
        <span>${esc(nameOf(repostedBy))} reposted</span>
      </div>`
    : ''

  const replyHeader = p.replyTo
    ? `<div class="post-replying-to">Replying to <a href="#thread/${p.replyTo}">@${parent ? esc(nameOf(parent.author)) : short(p.replyTo.split(':')[0])}</a></div>`
    : ''

  return `
    <article class="post${focus ? ' focus' : ''}" data-thread="${p.id}">
      ${avatar(p.author)}
      <div class="post-inner">
        ${repostHeader}
        <div class="post-meta">
          <div class="post-author-row">
            <span class="post-author-name" data-profile="${p.author}">${esc(nameOf(p.author))}</span>
            ${trustBadge}
            <span class="post-author-key" data-profile="${p.author}">@${short(p.author)}</span>
            <span class="post-dot">·</span>
            <span class="post-time">${ago(p.ts)}</span>
          </div>
          <button class="post-dropdown-trigger" data-post-menu="${p.id}" title="More options">⋯</button>
        </div>
        ${replyHeader}
        <div class="post-text">${formatText(p.text)}</div>
        ${tokensRow}
        ${mediaGridHtml(p.media)}
        ${pollHtml(p)}
        ${quoteEmbedHtml(p.quoteOf)}
        <div class="post-actions">
          <button class="act-btn reply" data-reply="${p.id}" title="Reply">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            <span>${replyCount(p.id) || ''}</span>
          </button>
          <button class="act-btn repost${reposted ? ' active' : ''}" data-repost="${p.id}" title="Repost / Quote">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 1l4 4-4 4"></path><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><path d="M7 23l-4-4 4-4"></path><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>
            <span>${repostCount(p.id) || ''}</span>
          </button>
          <button class="act-btn like${liked ? ' active' : ''}" data-like="${p.id}" title="Like">
            <svg viewBox="0 0 24 24" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
            <span>${likeCount(p.id) || ''}</span>
          </button>
          <button class="act-btn bookmark${bookmarked ? ' active' : ''}" data-bookmark="${p.id}" title="Bookmark">
            <svg viewBox="0 0 24 24" fill="${bookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
          </button>
          <button class="act-btn share" data-share="${p.id}" title="Share / Copy Link">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line></svg>
          </button>
        </div>
      </div>
    </article>`
}

function composeHtml(opts = {}) {
  const { replyTo = '', quoteOf = '', placeholder = "What's happening?!" } = opts
  const draft = replyTo ? replyDrafts[replyTo] || { text: '', media: [] } : homeDraft
  const previews = draft.media
    .map(
      (m, i) => `
    <div class="media-preview-item">
      <img src="${m}" alt="Preview" />
      <button type="button" class="media-preview-remove" data-remove-media="${i}" data-compose-id="${replyTo}">×</button>
    </div>`
    )
    .join('')

  const pollBuilderHtml = draft.showPoll
    ? `
    <div class="poll-builder" data-compose-id="${replyTo}">
      <input name="poll-opt-0" placeholder="Option 1" maxlength="60" value="${esc(draft.poll?.options?.[0] || '')}" />
      <input name="poll-opt-1" placeholder="Option 2" maxlength="60" value="${esc(draft.poll?.options?.[1] || '')}" />
      <input name="poll-opt-2" placeholder="Option 3 (optional)" maxlength="60" value="${esc(draft.poll?.options?.[2] || '')}" />
      <input name="poll-opt-3" placeholder="Option 4 (optional)" maxlength="60" value="${esc(draft.poll?.options?.[3] || '')}" />
      <div class="poll-builder-actions">
        <span class="muted" style="font-size:12px">Poll length: 1 day</span>
        <button type="button" class="link" data-cancel-poll="${replyTo}">Remove poll</button>
      </div>
    </div>`
    : ''

  const emojiTrayHtml = draft.showEmoji
    ? `
    <div class="emoji-tray" data-compose-id="${replyTo}">
      ${['🔥', '🚀', '❤️', '😂', '👍', '🎉', '💯', '💡', '⚡', '🫡', '👏', '✨', '🌐', '💻', '🤝', '🔒']
        .map((emoji) => `<button type="button" class="emoji-btn" data-insert-emoji="${emoji}" data-compose-id="${replyTo}">${emoji}</button>`)
        .join('')}
    </div>`
    : ''

  const quotedTarget = quoteOf ? state?.posts?.find((p) => p.id === quoteOf) : null

  return `
    <form class="compose" data-compose="${replyTo}" data-quote="${quoteOf}">
      ${avatar(state?.me)}
      <div class="compose-inner">
        <textarea name="text" placeholder="${replyTo ? 'Post your reply' : placeholder}" rows="2">${esc(draft.text || '')}</textarea>
        ${previews ? `<div class="compose-previews">${previews}</div>` : ''}
        ${pollBuilderHtml}
        ${quotedTarget ? quoteEmbedHtml(quotedTarget.id) : ''}
        ${emojiTrayHtml}
        <div class="compose-toolbar">
          <div class="compose-tools">
            <label class="tool-icon-btn" title="Add Image">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
              <input type="file" class="compose-file-input" accept="image/*" multiple style="display:none" data-compose-id="${replyTo}" />
            </label>
            ${
              !replyTo
                ? `
            <button type="button" class="tool-icon-btn" data-toggle-poll="${replyTo}" title="Create Poll">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
            </button>`
                : ''
            }
            <button type="button" class="tool-icon-btn" data-toggle-emoji="${replyTo}" title="Add Emoji">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
            </button>
          </div>
          <div class="compose-submit-wrap">
            <span class="char-count"></span>
            <button class="primary" type="submit" disabled>${replyTo ? 'Reply' : 'Post'}</button>
          </div>
        </div>
      </div>
    </form>`
}

// --- Post Options Bottom Sheet & Confirm Actions ---

function openPostOpts(postId) {
  const post = (state?.posts || []).find((p) => p.id === postId)
  if (!post || !postOptsDialog) return
  activePostOptsId = postId
  const isMine = post.author === state?.me
  const isF = following().has(post.author)
  const isB = isBlocked(post.author)
  const isM = isMuted(post.author)

  const summaryEl = document.getElementById('sheet-post-summary')
  if (summaryEl) {
    summaryEl.innerHTML = `
      ${avatar(post.author)}
      <div style="min-width:0">
        <div class="sheet-post-author-name">${esc(nameOf(post.author))}</div>
        <div class="sheet-post-author-key">@${short(post.author)}</div>
      </div>`
  }

  const contentEl = document.getElementById('sheet-opts-content')
  if (contentEl) {
    const items = [
      `
      <button class="sheet-action-item" data-sheet-action="copy-text">
        <div class="sheet-action-left">
          <span class="sheet-action-icon">📋</span>
          <span>Copy Post Text</span>
        </div>
        <span class="sheet-hint">Markdown text</span>
      </button>`,
      `
      <button class="sheet-action-item" data-sheet-action="copy-key">
        <div class="sheet-action-left">
          <span class="sheet-action-icon">🔑</span>
          <span>Copy Author Key</span>
        </div>
        <span class="sheet-hint monospace">@${short(post.author)}</span>
      </button>`,
      `
      <button class="sheet-action-item" data-sheet-action="share">
        <div class="sheet-action-left">
          <span class="sheet-action-icon">🔗</span>
          <span>Share Post</span>
        </div>
        <span class="sheet-hint">Copy Post ID</span>
      </button>`
    ]

    if (isMine) {
      items.push(`
        <button class="sheet-action-item danger" data-sheet-action="delete">
          <div class="sheet-action-left">
            <span class="sheet-action-icon">🗑️</span>
            <span>Delete Post</span>
          </div>
          <span class="sheet-hint danger">Delete from your feed</span>
        </button>`)
    } else {
      items.push(`
        <button class="sheet-action-item" data-sheet-action="toggle-follow">
          <div class="sheet-action-left">
            <span class="sheet-action-icon">${isF ? '👤' : '➕'}</span>
            <span>${isF ? 'Unfollow' : 'Follow'} @${short(post.author)}</span>
          </div>
        </button>`)

      items.push(`
        <button class="sheet-action-item" data-sheet-action="toggle-mute">
          <div class="sheet-action-left">
            <span class="sheet-action-icon">${isM ? '🔊' : '🔇'}</span>
            <span>${isM ? 'Unmute' : 'Mute'} @${short(post.author)}</span>
          </div>
        </button>`)

      items.push(`
        <button class="sheet-action-item danger" data-sheet-action="toggle-block">
          <div class="sheet-action-left">
            <span class="sheet-action-icon">🚫</span>
            <span>${isB ? 'Unblock' : 'Block'} @${short(post.author)}</span>
          </div>
        </button>`)

      items.push(`
        <button class="sheet-action-item danger" data-sheet-action="open-report">
          <div class="sheet-action-left">
            <span class="sheet-action-icon">🚩</span>
            <span>Report Post</span>
          </div>
          <span class="sheet-badge">PoW Moderation</span>
        </button>`)
    }

    contentEl.innerHTML = items.join('')
  }

  postOptsDialog.showModal()
}

function showConfirm(title, message, onConfirm) {
  const titleEl = document.getElementById('confirm-modal-title')
  const msgEl = document.getElementById('confirm-modal-msg')
  if (titleEl) titleEl.textContent = title
  if (msgEl) msgEl.textContent = message
  pendingConfirmCallback = onConfirm
  confirmDialog?.showModal()
}

// --- Views ---

const views = {
  home() {
    const f = following()
    const activeSub = route.sub || 'forYou'

    let posts = (state?.posts || []).filter((p) => !isBlocked(p.author) && !isMuted(p.author))

    if (activeSub === 'following') {
      posts = posts.filter((p) => p.author === state?.me || f.has(p.author))
      posts.sort((a, b) => b.ts - a.ts)
    } else if (activeSub === 'trending') {
      posts = [...posts].sort((a, b) => computeTrendingScore(b) - computeTrendingScore(a))
    } else if (activeSub === 'latest') {
      posts = [...posts].sort((a, b) => b.ts - a.ts)
    } else {
      // ⚡ For You: Algorithmic ranking based on sovereign taste vector & trust
      const taste = getTasteVector()
      posts = [...posts].sort((a, b) => computeFypScore(b, taste) - computeFypScore(a, taste))
    }

    return `
      <div class="header">
        <span>Home</span>
        <div class="header-actions">
          <button class="icon-btn-ghost theme-toggle-btn" title="Toggle Theme">${currentTheme === 'dark' ? '☀️' : '🌙'}</button>
          <button class="icon-btn-ghost" id="btn-open-updates" title="In-App Updates">🔄</button>
        </div>
      </div>
      <div class="tabs-bar">
        <button class="tab-btn${activeSub === 'forYou' ? ' active' : ''}" data-subtab="forYou">⚡ For You</button>
        <button class="tab-btn${activeSub === 'trending' ? ' active' : ''}" data-subtab="trending">🔥 Trending</button>
        <button class="tab-btn${activeSub === 'latest' ? ' active' : ''}" data-subtab="latest">⏱️ Latest</button>
        <button class="tab-btn${activeSub === 'following' ? ' active' : ''}" data-subtab="following">👥 Following</button>
      </div>
      ${composeHtml()}
      <div class="feed">
        ${
          posts.length
            ? posts.map((p) => postHtml(p)).join('')
            : `<div class="empty-state">No posts in your feed yet. Discover peers in <a href="#explore">Explore</a>!</div>`
        }
      </div>`
  },

  explore() {
    const activeSub = route.sub || 'all'
    const query = (route.arg || '').trim().toLowerCase()

    let posts = (state?.posts || []).filter((p) => !isBlocked(p.author))
    if (query) {
      posts = posts.filter(
        (p) =>
          p.text.toLowerCase().includes(query) ||
          p.author.toLowerCase().includes(query) ||
          nameOf(p.author).toLowerCase().includes(query) ||
          (p.tags && p.tags.some((t) => ('#' + t).toLowerCase().includes(query)))
      )
    }

    if (activeSub === 'media') {
      posts = posts.filter((p) => p.media && p.media.length > 0)
    }

    const peers = Object.keys(state?.profiles || {})

    return `
      <div class="header">
        <span>Explore</span>
        <div class="header-actions">
          <button class="icon-btn-ghost theme-toggle-btn" title="Toggle Theme">${currentTheme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </div>
      <div class="tabs-bar">
        <button class="tab-btn${activeSub === 'all' ? ' active' : ''}" data-subtab="all">All</button>
        <button class="tab-btn${activeSub === 'media' ? ' active' : ''}" data-subtab="media">Media</button>
        <button class="tab-btn${activeSub === 'peers' ? ' active' : ''}" data-subtab="peers">Peers (${peers.length})</button>
      </div>
      <form class="compose" id="explore-addkey" style="border-bottom:1px solid var(--line)">
        <input name="key" placeholder="Connect manually: paste 64-hex peer feed key" style="flex:1;background:var(--input-bg);border:1px solid var(--line);border-radius:var(--radius-full);padding:10px 16px;outline:none;" />
        <button class="outline" type="submit">Connect</button>
      </form>
      ${
        activeSub === 'peers'
          ? `
        <div class="peer-list">
          ${peers
            .map((k) => {
              const isMe = k === state?.me
              const isFollowed = following().has(k)
              const prof = state?.profiles?.[k] || {}
              return `
            <div class="post" data-profile="${k}">
              ${avatar(k)}
              <div class="post-inner">
                <div class="post-meta">
                  <div>
                    <div style="font-weight:700">${esc(nameOf(k))}</div>
                    <div class="muted" style="font-size:12px">@${short(k)} · ${prof.length || 0} entries</div>
                  </div>
                  ${
                    !isMe
                      ? `<button class="${isFollowed ? 'outline' : 'primary'} btn-sm" data-follow="${k}">${isFollowed ? 'Unfollow' : 'Follow'}</button>`
                      : '<span class="muted" style="font-size:12px">You</span>'
                  }
                </div>
                ${prof.bio ? `<div style="margin-top:6px;font-size:14px">${esc(prof.bio)}</div>` : ''}
              </div>
            </div>`
            })
            .join('')}
        </div>`
          : `
        <div class="feed">
          ${posts.length ? posts.map((p) => postHtml(p)).join('') : `<div class="empty-state">No matching posts found.</div>`}
        </div>`
      }`
  },

  notifications() {
    const activeSub = route.sub || 'all'
    let notifs = state?.notifications || []

    if (activeSub === 'mentions') notifs = notifs.filter((n) => n.type === 'mention')
    if (activeSub === 'likes') notifs = notifs.filter((n) => n.type === 'like')
    if (activeSub === 'follows') notifs = notifs.filter((n) => n.type === 'follow')
    if (activeSub === 'reposts') notifs = notifs.filter((n) => n.type === 'repost')

    // Mark notifications as read
    localStorage.setItem('p2p_notifs_read', Date.now().toString())
    updateNotifBadge()

    const notifItem = (n) => {
      let icon = ''
      let desc = ''
      if (n.type === 'like') {
        icon = `<div class="notif-icon-col like"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg></div>`
        desc = `<b>${esc(nameOf(n.actor))}</b> liked your post`
      } else if (n.type === 'repost') {
        icon = `<div class="notif-icon-col repost"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 1l4 4-4 4"></path><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><path d="M7 23l-4-4 4-4"></path><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg></div>`
        desc = `<b>${esc(nameOf(n.actor))}</b> reposted your post`
      } else if (n.type === 'follow') {
        icon = `<div class="notif-icon-col follow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></div>`
        desc = `<b>${esc(nameOf(n.actor))}</b> followed you`
      } else if (n.type === 'reply') {
        icon = `<div class="notif-icon-col reply"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></div>`
        desc = `<b>${esc(nameOf(n.actor))}</b> replied: "${esc(n.text || '')}"`
      } else if (n.type === 'mention') {
        icon = `<div class="notif-icon-col mention"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"></path></svg></div>`
        desc = `<b>${esc(nameOf(n.actor))}</b> mentioned you: "${esc(n.post?.text || '')}"`
      }

      const targetPost = n.targetPostId ? state?.posts?.find((p) => p.id === n.targetPostId) : null

      return `
        <div class="notif-item" data-notif-target="${n.replyPostId || n.targetPostId || ''}" data-actor="${n.actor}">
          ${icon}
          <div class="notif-content">
            <div class="notif-actor-row">
              ${avatar(n.actor)}
              <div>${desc}</div>
              <span class="muted" style="margin-left:auto;font-size:12px">${ago(n.ts)}</span>
            </div>
            ${targetPost ? `<div class="notif-text">${esc(targetPost.text.slice(0, 100))}</div>` : ''}
          </div>
        </div>`
    }

    return `
      <div class="header">
        <span>Notifications</span>
        <div class="header-actions">
          <button class="icon-btn-ghost theme-toggle-btn" title="Toggle Theme">${currentTheme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </div>
      <div class="tabs-bar">
        <button class="tab-btn${activeSub === 'all' ? ' active' : ''}" data-subtab="all">All</button>
        <button class="tab-btn${activeSub === 'mentions' ? ' active' : ''}" data-subtab="mentions">Mentions</button>
        <button class="tab-btn${activeSub === 'likes' ? ' active' : ''}" data-subtab="likes">Likes</button>
        <button class="tab-btn${activeSub === 'follows' ? ' active' : ''}" data-subtab="follows">Follows</button>
      </div>
      <div class="feed">
        ${notifs.length ? notifs.map(notifItem).join('') : `<div class="empty-state">No notifications yet.</div>`}
      </div>`
  },

  messages() {
    const dms = state?.dms || {}
    const peerKeys = Object.keys(dms)
    const selectedPeer = route.arg || peerKeys[0] || null

    const convList = peerKeys.map((k) => {
      const msgs = dms[k] || []
      const last = msgs[msgs.length - 1]
      const isSelected = k === selectedPeer
      return `
        <div class="post${isSelected ? ' focus' : ''}" data-open-dm="${k}" style="cursor:pointer;padding:10px 14px">
          ${avatar(k)}
          <div class="post-inner" style="overflow:hidden">
            <div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(nameOf(k))}</div>
            <div class="muted" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(last?.text || 'Sent media')}</div>
          </div>
        </div>`
    })

    const activeMsgs = selectedPeer && dms[selectedPeer] ? dms[selectedPeer] : []

    const historyHtml = activeMsgs
      .map((m) => {
        const isOut = m.from === state?.me
        return `
        <div class="dm-bubble ${isOut ? 'out' : 'in'}">
          ${m.media ? mediaGridHtml(m.media) : ''}
          <div>${esc(m.text)}</div>
          <div class="dm-bubble-time">${ago(m.ts)}</div>
        </div>`
      })
      .join('')

    return `
      <div class="header">
        <span>Direct Messages</span>
        <div class="header-actions">
          <button class="icon-btn-ghost theme-toggle-btn" title="Toggle Theme">${currentTheme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </div>
      <div class="dms-container">
        <div class="dms-list">
          <div style="padding:10px;border-bottom:1px solid var(--line)">
            <input id="dm-new-peer-input" placeholder="Start DM: paste peer key…" style="width:100%;padding:6px 10px;font-size:12px;background:var(--input-bg);border:1px solid var(--line);border-radius:var(--radius-sm)" />
          </div>
          ${convList.length ? convList.join('') : '<div class="empty-state" style="padding:20px 10px">No chats yet.</div>'}
        </div>
        <div class="dm-chat-panel">
          ${
            selectedPeer
              ? `
            <div class="dm-chat-header">
              ${avatar(selectedPeer)}
              <div>
                <div style="font-weight:700" data-profile="${selectedPeer}">${esc(nameOf(selectedPeer))}</div>
                <div class="muted" style="font-size:12px">@${short(selectedPeer)}</div>
              </div>
            </div>
            <div class="dm-history" id="dm-history">
              ${historyHtml || '<div class="empty-state">No messages yet. Send a friendly greeting!</div>'}
            </div>
            <form class="dm-compose" id="dm-compose" data-dm-to="${selectedPeer}">
              <input name="text" placeholder="Start a new message…" autocomplete="off" />
              <button class="primary btn-sm" type="submit">Send</button>
            </form>`
              : `
            <div class="empty-state" style="margin:auto">
              Select a conversation or enter a peer key to start chatting.
            </div>`
          }
        </div>
      </div>`
  },

  bookmarks() {
    const bookmarkedIds = state?.bookmarkedByMe || []
    const posts = (state?.posts || []).filter((p) => bookmarkedIds.includes(p.id))

    return `
      <div class="header">
        <span>Bookmarks</span>
        <div class="header-actions">
          <button class="icon-btn-ghost theme-toggle-btn" title="Toggle Theme">${currentTheme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </div>
      <div class="feed">
        ${
          posts.length
            ? posts.map((p) => postHtml(p)).join('')
            : `<div class="empty-state">You haven’t added any posts to your Bookmarks yet. Bookmark posts to easily find them again.</div>`
        }
      </div>`
  },

  profile(key) {
    key = key || state?.me
    const prof = state?.profiles?.[key] || { name: '', bio: '', following: [] }
    const isMine = key === state?.me
    const isFollowed = following().has(key)
    const activeSub = route.sub || 'posts'

    let posts = (state?.posts || []).filter((p) => p.author === key)
    if (activeSub === 'replies') {
      posts = posts.filter((p) => p.replyTo)
    } else if (activeSub === 'media') {
      posts = posts.filter((p) => p.media && p.media.length > 0)
    } else if (activeSub === 'likes') {
      posts = (state?.posts || []).filter((p) => state?.likes?.[p.id] && p.author !== key) // liked posts
    } else {
      // posts tab: root posts
      posts = posts.filter((p) => !p.replyTo)
    }

    const bannerStyle = prof.banner ? `background-image:url(${prof.banner})` : `background:${bannerGradient(key)}`

    const actionButtons = isMine
      ? `<button class="outline" id="edit-profile">Edit profile</button>
         <button class="outline" id="btn-open-updates" title="In-App Updates">🔄 Updates</button>`
      : `
        <button class="${isFollowed ? 'outline' : 'primary'}" data-follow="${key}">${isFollowed ? 'Unfollow' : 'Follow'}</button>
        <button class="outline" data-open-dm="${key}" title="Direct Message">💬</button>
        <button class="outline" data-show-qr="${key}" title="Show QR Code">QR</button>`

    return `
      <div class="header">
        <div class="header-left">
          <button class="back-btn" data-back>←</button>
          <div>
            <div>${esc(nameOf(key))}</div>
            <div class="muted" style="font-size:12px;font-weight:400">${posts.length} post${posts.length === 1 ? '' : 's'}</div>
          </div>
        </div>
        <div class="header-actions">
          <button class="icon-btn-ghost theme-toggle-btn" title="Toggle Theme">${currentTheme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </div>
      <div class="profile-hero">
        <div class="profile-banner" style="${bannerStyle}"></div>
        <div class="profile-head-bar">
          ${avatar(key, true)}
          <div style="display:flex;gap:8px">${actionButtons}</div>
        </div>
        <div class="profile-details">
          <h2>${esc(nameOf(key))}</h2>
          <div class="profile-key">
            <span>@${short(key)}</span>
            <button class="link" data-copy-text="${key}" style="font-size:11px">[copy full key]</button>
          </div>
          ${prof.bio ? `<div class="profile-bio">${formatText(prof.bio)}</div>` : ''}
          <div class="profile-meta-row">
            ${prof.location ? `<div class="profile-meta-item">📍 ${esc(prof.location)}</div>` : ''}
            ${
              prof.website
                ? `<div class="profile-meta-item">🔗 <a href="${esc(prof.website)}" target="_blank" rel="noopener">${esc(prof.website)}</a></div>`
                : ''
            }
            <div class="profile-meta-item">⚡ ${prof.length || 0} Hypercore blocks</div>
          </div>
          <div class="profile-stats-row">
            <span><b>${prof.following?.length || 0}</b> Following</span>
            <span><b>${state?.followers?.[key] || 0}</b> Followers</span>
          </div>
          ${
            prof.reputation
              ? `
          <div class="reputation-badge-box">
            <div class="reputation-badge-header">
              <div class="rep-chip">
                <span>${prof.reputation.trust >= 90 ? '🛡️' : (prof.reputation.trust < 60 ? '⚠️' : '⚡')} ${prof.reputation.trust}% Sovereign Trust</span>
                <span class="muted" style="font-weight:400">(${prof.reputation.score} pts)</span>
              </div>
            </div>
            <div class="rep-stats muted">
              <span>❤️ ${prof.reputation.likes} likes</span> · 
              <span>👁️ ${prof.reputation.cleanViews} clean views</span>
              ${prof.reputation.reports > 0 ? ` · <span class="rep-reports">🚩 ${prof.reputation.reports} reports</span>` : ''}
            </div>
          </div>`
              : ''
          }
        </div>
      </div>
      <div class="tabs-bar">
        <button class="tab-btn${activeSub === 'posts' ? ' active' : ''}" data-subtab="posts">Posts</button>
        <button class="tab-btn${activeSub === 'replies' ? ' active' : ''}" data-subtab="replies">Replies</button>
        <button class="tab-btn${activeSub === 'media' ? ' active' : ''}" data-subtab="media">Media</button>
      </div>
      <div class="feed">
        ${posts.length ? posts.map((p) => postHtml(p)).join('') : `<div class="empty-state">No posts to display.</div>`}
      </div>`
  },

  thread(id) {
    const post = (state?.posts || []).find((p) => p.id === id)
    if (!post) {
      return `
        <div class="header"><button class="back-btn" data-back>←</button>Post</div>
        <div class="empty-state">Post not found or still syncing from peers…</div>`
    }

    // Build ancestor chain (parents)
    const ancestors = []
    let curr = post
    while (curr && curr.replyTo) {
      const parent = (state?.posts || []).find((p) => p.id === curr.replyTo)
      if (parent) {
        ancestors.unshift(parent)
        curr = parent
      } else {
        break
      }
    }

    const replies = (state?.posts || []).filter((p) => p.replyTo === id)

    return `
      <div class="header">
        <div class="header-left">
          <button class="back-btn" data-back>←</button>
          <span>Post</span>
        </div>
        <div class="header-actions">
          <button class="icon-btn-ghost theme-toggle-btn" title="Toggle Theme">${currentTheme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </div>
      <div class="thread-ancestors">
        ${ancestors.map((p) => postHtml(p)).join('')}
      </div>
      ${postHtml(post, { focus: true })}
      ${composeHtml({ replyTo: id, placeholder: 'Post your reply' })}
      <div class="feed thread-replies">
        ${replies.length ? replies.map((p) => postHtml(p)).join('') : `<div class="empty-state">No replies yet.</div>`}
      </div>`
  }
}

// --- Render Loop ---

const mainEl = document.getElementById('main')

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge')
  if (!badge) return
  const lastRead = Number(localStorage.getItem('p2p_notifs_read') || 0)
  const unreadCount = (state?.notifications || []).filter((n) => n.ts > lastRead).length
  badge.textContent = unreadCount > 0 ? (unreadCount > 99 ? '99+' : unreadCount) : ''
  badge.classList.toggle('show', unreadCount > 0)
}

function renderWidgets() {
  // Sidebar user card
  const myKey = state?.me || ''
  const avatarEl = document.getElementById('sidebar-user-avatar')
  if (avatarEl) avatarEl.innerHTML = avatar(myKey)
  const nameEl = document.getElementById('sidebar-user-name')
  if (nameEl) nameEl.textContent = nameOf(myKey)
  const keyEl = document.getElementById('sidebar-user-key')
  if (keyEl) keyEl.textContent = '@' + short(myKey)

  // Network pill
  const netDot = document.getElementById('net-dot')
  const netPeers = document.getElementById('net-peers')
  if (netPeers && state) {
    netPeers.textContent = `${state.peers} peer${state.peers === 1 ? '' : 's'} online`
    if (netDot) netDot.classList.toggle('on', state.peers > 0)
  }

  // Trending widget
  const trendingList = document.getElementById('trending-list')
  if (trendingList) {
    const tags = state?.trendingTags || []
    if (tags.length) {
      trendingList.innerHTML = tags
        .slice(0, 6)
        .map(
          (t) => `
        <div class="trending-item" data-search="#${esc(t.tag)}">
          <div>
            <div class="trending-tag">#${esc(t.tag)}</div>
            <div class="trending-count">${t.count} post${t.count === 1 ? '' : 's'}</div>
          </div>
          <span class="muted" style="font-size:12px">⋯</span>
        </div>`
        )
        .join('')
    } else {
      trendingList.innerHTML = `<div class="empty-state" style="padding:16px">No tags active yet</div>`
    }
  }

  // Who to follow widget
  const whoList = document.getElementById('who-to-follow-list')
  if (whoList && state) {
    const myFollows = following()
    const candidates = Object.keys(state.profiles || {}).filter((k) => k !== state.me && !myFollows.has(k) && !isBlocked(k))
    if (candidates.length) {
      whoList.innerHTML = candidates
        .slice(0, 4)
        .map(
          (k) => `
        <div class="peer-suggest-item" data-profile="${k}">
          ${avatar(k)}
          <div class="peer-info">
            <div class="peer-name">${esc(nameOf(k))}</div>
            <div class="peer-key">@${short(k)}</div>
          </div>
          <button class="primary btn-sm" data-follow="${k}">Follow</button>
        </div>`
        )
        .join('')
    } else {
      whoList.innerHTML = `<div class="empty-state" style="padding:16px">Connected to town square!</div>`
    }
  }

  // Theme toggle button
  updateThemeElements()
}

function render() {
  if (!state) return

  updateThemeElements()

  // Nav item active state
  document.querySelectorAll('.sidebar a').forEach((a) => {
    const v = a.dataset.view
    a.classList.toggle('active', v === route.view && (v !== 'profile' || !route.arg || route.arg === state.me))
  })

  // First-run profile setup dialog
  if (!state.profiles?.[state.me]?.name && !askedSetup) {
    askedSetup = true
    setupDialog?.showModal()
  }

  updateNotifBadge()
  renderWidgets()

  // Retain draft state & active form selection
  const active = document.activeElement
  const isTyping = active && (active.name === 'text' || active.name === 'poll-opt-0' || active.name === 'key')
  const savedForm = isTyping ? active.form?.dataset?.compose : null
  const savedValue = isTyping ? active.value : null
  const savedPos = isTyping ? active.selectionStart : null
  const scroll = window.scrollY

  const renderView = views[route.view] || views.home
  mainEl.innerHTML = renderView(route.arg)

  // Restore cursor and text if user was typing
  if (isTyping && savedForm !== null) {
    const ta = mainEl.querySelector(`form[data-compose="${savedForm}"] textarea[name="${active.name}"]`)
    if (ta) {
      ta.value = savedValue
      ta.focus()
      ta.setSelectionRange(savedPos, savedPos)
      updateCount(ta)
    }
  }

  window.scrollTo(0, scroll)

  // If chat is open, scroll history to bottom
  const dmHistory = document.getElementById('dm-history')
  if (dmHistory) {
    dmHistory.scrollTop = dmHistory.scrollHeight
  }

  setupPostIntersectionObserver()
}

// --- Routing ---

function go(view, arg = null, sub = null) {
  let hash = '#' + view
  if (arg) hash += '/' + encodeURIComponent(arg)
  if (sub) hash += '?sub=' + encodeURIComponent(sub)
  if (location.hash !== hash) {
    location.hash = hash
  } else {
    onHash()
  }
}

function onHash() {
  const full = location.hash.slice(1)
  const [pathPart, queryPart] = full.split('?')
  const parts = pathPart.split('/')
  const view = views[parts[0]] ? parts[0] : 'home'
  const arg = parts[1] ? decodeURIComponent(parts[1]) : null

  let sub = null
  if (queryPart) {
    const params = new URLSearchParams(queryPart)
    sub = params.get('sub')
  }

  route = { view, arg, sub }
  render()
  window.scrollTo(0, 0)
}

window.addEventListener('hashchange', onHash)

// --- Character Counting & Form Helpers ---

function updateCount(ta) {
  const form = ta.form
  if (!form) return
  const len = ta.value.length
  const left = 280 - len
  const countEl = form.querySelector('.char-count')
  const submitBtn = form.querySelector('button[type="submit"]')

  if (countEl) {
    countEl.textContent = len > 0 ? (left >= 0 ? left : left) : ''
    countEl.classList.toggle('warn', left < 40 && left >= 0)
    countEl.classList.toggle('over', left < 0)
  }
  if (submitBtn) {
    const hasMedia = form.dataset.compose ? replyDrafts[form.dataset.compose]?.media?.length : homeDraft.media.length
    submitBtn.disabled = (!ta.value.trim() && !hasMedia) || left < -720
  }
}

// --- Event Listeners ---

document.addEventListener('input', (e) => {
  if (e.target.name === 'text') {
    updateCount(e.target)
    const composeId = e.target.form?.dataset?.compose
    if (composeId) {
      if (!replyDrafts[composeId]) replyDrafts[composeId] = { text: '', media: [] }
      replyDrafts[composeId].text = e.target.value
    } else {
      homeDraft.text = e.target.value
    }
  }
})

document.addEventListener('keydown', (e) => {
  if (e.target.name === 'text' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.target.form?.requestSubmit()
  }
  if (e.key === 'Escape') {
    if (lightboxDialog?.open) lightboxDialog.close()
    if (qrDialog?.open) qrDialog.close()
    if (networkDialog?.open) networkDialog.close()
    if (editProfileDialog?.open) editProfileDialog.close()
    if (quoteDialog?.open) quoteDialog.close()
    if (updateDialog?.open) updateDialog.close()
  }
})

// Paste image from clipboard directly into compose!
document.addEventListener('paste', async (e) => {
  if (!e.clipboardData || !e.clipboardData.items) return
  const items = e.clipboardData.items
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) {
      const file = items[i].getAsFile()
      if (file) {
        e.preventDefault()
        const dataUrl = await compressImage(file)
        const composeId = e.target?.form?.dataset?.compose
        if (composeId) {
          if (!replyDrafts[composeId]) replyDrafts[composeId] = { text: '', media: [] }
          replyDrafts[composeId].media.push(dataUrl)
        } else {
          homeDraft.media.push(dataUrl)
        }
        render()
        toast('Image pasted from clipboard!')
        break
      }
    }
  }
})

// Form Submissions
document.addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.target

  if (form.id === 'setup-form') {
    const name = form.name.value.trim()
    const bio = form.bio.value.trim()
    send({ cmd: 'profile', name, bio })
    setupDialog?.close()
    return
  }

  if (form.id === 'edit-profile-form') {
    const name = form.name.value.trim()
    const bio = form.bio.value.trim()
    const location = form.location.value.trim()
    const website = form.website.value.trim()
    const avatar = form.dataset.avatar || state?.profiles?.[state?.me]?.avatar
    const banner = form.dataset.banner || state?.profiles?.[state?.me]?.banner
    send({ cmd: 'profile', name, bio, location, website, avatar, banner })
    editProfileDialog?.close()
    toast('Profile updated!')
    return
  }

  if (form.id === 'explore-addkey') {
    const key = form.key.value.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(key)) return toast('Feed key must be 64 hex characters')
    send({ cmd: 'add', key })
    form.reset()
    go('profile', key)
    toast('Peer added! Connecting…')
    return
  }

  if (form.id === 'dm-compose') {
    const to = form.dataset.dmTo
    const text = form.text.value.trim()
    if (!text) return
    send({ cmd: 'dm', to, text })
    form.text.value = ''
    return
  }

  // Compose forms (Home or Thread reply)
  if (form.classList.contains('compose')) {
    const replyTo = form.dataset.compose || undefined
    const quoteOf = form.dataset.quote || undefined
    const text = form.text.value.trim()
    const draft = replyTo ? replyDrafts[replyTo] : homeDraft

    let poll = undefined
    if (draft?.showPoll) {
      const opt0 = form['poll-opt-0']?.value?.trim()
      const opt1 = form['poll-opt-1']?.value?.trim()
      const opt2 = form['poll-opt-2']?.value?.trim()
      const opt3 = form['poll-opt-3']?.value?.trim()
      const opts = [opt0, opt1, opt2, opt3].filter(Boolean)
      if (opts.length >= 2) {
        poll = {
          question: text.slice(0, 100) || 'Poll',
          options: opts,
          expiresAt: Date.now() + 86400000
        }
      }
    }

    const tokens = extractClientTokens(text)
    recordTaste(tokens, 2.5)

    send({
      cmd: 'post',
      text,
      tokens,
      replyTo,
      quoteOf,
      media: draft?.media?.length ? draft.media : undefined,
      poll
    })

    // Reset draft
    if (replyTo) {
      delete replyDrafts[replyTo]
    } else {
      homeDraft = { text: '', media: [], poll: null, showPoll: false, showEmoji: false }
    }

    if (quoteDialog?.open) quoteDialog.close()
    if (updateDialog?.open) updateDialog.close()
    toast('Post published!')
  }
})

// Click Handling
document.addEventListener('click', async (e) => {
  // Subtabs
  const subBtn = e.target.closest('[data-subtab]')
  if (subBtn) {
    e.preventDefault()
    go(route.view, route.arg, subBtn.dataset.subtab)
    return
  }

  // Back button
  if (e.target.closest('[data-back]')) {
    if (history.length > 1) history.back()
    else go('home')
    return
  }

  // Profile click
  const profEl = e.target.closest('[data-profile]')
  if (profEl && !e.target.closest('button, input, textarea, a')) {
    go('profile', profEl.dataset.profile)
    return
  }

  // Thread click
  const threadEl = e.target.closest('[data-thread]')
  if (threadEl && !e.target.closest('button, input, textarea, a, .quote-embed, .post-dropdown-trigger')) {
    go('thread', threadEl.dataset.thread)
    return
  }

  // Reveal flagged post
  const revealBtn = e.target.closest('[data-reveal-flagged]')
  if (revealBtn) {
    const id = revealBtn.dataset.revealFlagged
    revealedPosts.add(id)
    render()
    return
  }

  // Like
  const likeBtn = e.target.closest('[data-like]')
  if (likeBtn) {
    const id = likeBtn.dataset.like
    const post = (state?.posts || []).find((p) => p.id === id)
    const isLiked = state?.likedByMe?.includes(id)
    send({ cmd: isLiked ? 'unlike' : 'like', id })
    if (!isLiked && post?.tokens) {
      recordTaste(post.tokens, 2.0)
    }
    return
  }

  // Repost
  const repostBtn = e.target.closest('[data-repost]')
  if (repostBtn) {
    const id = repostBtn.dataset.repost
    const isReposted = state?.repostedByMe?.includes(id)
    send({ cmd: isReposted ? 'unrepost' : 'repost', id })
    toast(isReposted ? 'Repost removed' : 'Reposted to your feed!')
    return
  }

  // Bookmark
  const bookmarkBtn = e.target.closest('[data-bookmark]')
  if (bookmarkBtn) {
    const id = bookmarkBtn.dataset.bookmark
    const post = (state?.posts || []).find((p) => p.id === id)
    const isBookmarked = state?.bookmarkedByMe?.includes(id)
    send({ cmd: isBookmarked ? 'unbookmark' : 'bookmark', id })
    if (!isBookmarked && post?.tokens) {
      recordTaste(post.tokens, 3.0)
    }
    toast(isBookmarked ? 'Removed from Bookmarks' : 'Saved to Bookmarks!')
    return
  }

  // Reply button in card
  const replyBtn = e.target.closest('[data-reply]')
  if (replyBtn) {
    go('thread', replyBtn.dataset.reply)
    return
  }

  // Share button
  const shareBtn = e.target.closest('[data-share]')
  if (shareBtn) {
    const id = shareBtn.dataset.share
    try {
      await navigator.clipboard.writeText(id)
      toast('Post ID copied to clipboard!')
    } catch {
      prompt('Post ID', id)
    }
    return
  }

  // Follow / Unfollow
  const followBtn = e.target.closest('[data-follow]')
  if (followBtn) {
    const key = followBtn.dataset.follow
    const isFollowed = following().has(key)
    send({ cmd: isFollowed ? 'unfollow' : 'follow', key })
    toast(isFollowed ? 'Unfollowed' : 'Following!')
    return
  }

  // Vote on poll
  const voteBtn = e.target.closest('[data-vote-post]')
  if (voteBtn) {
    const id = voteBtn.dataset.votePost
    const opt = Number(voteBtn.dataset.voteOption)
    send({ cmd: 'vote', id, option: opt })
    toast('Vote recorded!')
    return
  }

  // Lightbox view
  const lbCell = e.target.closest('[data-lightbox]')
  if (lbCell) {
    const url = lbCell.dataset.lightbox
    const img = document.getElementById('lightbox-img')
    if (img && lightboxDialog) {
      img.src = url
      lightboxDialog.showModal()
    }
    return
  }

  // Hashtag search click
  const tagEl = e.target.closest('[data-search]')
  if (tagEl) {
    go('explore', tagEl.dataset.search)
    return
  }

  // Open DM
  const dmTrigger = e.target.closest('[data-open-dm]')
  if (dmTrigger) {
    go('messages', dmTrigger.dataset.openDm)
    return
  }

  // Show QR code modal
  const qrTrigger = e.target.closest('#btn-show-qr, [data-show-qr]')
  if (qrTrigger) {
    const key = qrTrigger.dataset.showQr || state?.me
    openQrModal(key)
    return
  }

  // Network Inspector Modal
  if (e.target.closest('#open-network')) {
    openNetworkModal()
    return
  }

  // User pill menu
  if (e.target.closest('#user-menu-btn')) {
    openEditProfile()
    return
  }

  // Sidebar post button
  if (e.target.closest('#sidebar-post-btn')) {
    go('home')
    const ta = mainEl.querySelector('.compose textarea')
    if (ta) ta.focus()
    return
  }

  // Theme toggle
  if (e.target.closest('#btn-theme-toggle') || e.target.closest('.theme-toggle-btn')) {
    toggleTheme()
    return
  }

  // App updates
  if (e.target.closest('#btn-open-updates') || e.target.closest('#btn-net-open-updates')) {
    openUpdateModal()
    return
  }
  if (e.target.closest('#btn-clear-repo')) {
    const repoInput = document.getElementById('update-repo-input')
    if (repoInput) {
      repoInput.value = DEFAULT_REPO
      localStorage.setItem('p2p_github_repo', DEFAULT_REPO)
      repoInput.focus()
      toast('Reset repo to ' + DEFAULT_REPO)
    }
    return
  }
  if (e.target.closest('#btn-check-updates')) {
    checkUpdatesAction(true)
    return
  }
  if (e.target.closest('#btn-start-update')) {
    startDownloadAction()
    return
  }
  if (e.target.closest('#btn-start-ota')) {
    startOtaDownloadAction()
    return
  }
  if (e.target.closest('#btn-ota-reload')) {
    if (window.AndroidUpdater?.reloadWebView) {
      window.AndroidUpdater.reloadWebView()
    } else {
      location.reload()
    }
    return
  }
  if (e.target.closest('#btn-ota-dismiss')) {
    const banner = document.getElementById('ota-banner')
    if (banner) banner.style.display = 'none'
    return
  }

  // Close modals
  if (e.target.closest('[data-close-modal]')) {
    const dlg = e.target.closest('dialog')
    if (dlg) dlg.close()
    return
  }

  // Edit profile button
  if (e.target.closest('#edit-profile')) {
    openEditProfile()
    return
  }

  // Toggle Poll builder
  const pollBtn = e.target.closest('[data-toggle-poll]')
  if (pollBtn) {
    homeDraft.showPoll = !homeDraft.showPoll
    render()
    return
  }

  // Cancel Poll
  if (e.target.closest('[data-cancel-poll]')) {
    homeDraft.showPoll = false
    homeDraft.poll = null
    render()
    return
  }

  // Toggle Emoji bar
  const emojiBtn = e.target.closest('[data-toggle-emoji]')
  if (emojiBtn) {
    const composeId = emojiBtn.dataset.toggleEmoji
    if (composeId) {
      if (!replyDrafts[composeId]) replyDrafts[composeId] = { text: '', media: [] }
      replyDrafts[composeId].showEmoji = !replyDrafts[composeId].showEmoji
    } else {
      homeDraft.showEmoji = !homeDraft.showEmoji
    }
    render()
    return
  }

  // Insert Emoji
  const insertEmoji = e.target.closest('[data-insert-emoji]')
  if (insertEmoji) {
    const emoji = insertEmoji.dataset.insertEmoji
    const composeId = insertEmoji.dataset.composeId
    if (composeId) {
      if (!replyDrafts[composeId]) replyDrafts[composeId] = { text: '', media: [] }
      replyDrafts[composeId].text = (replyDrafts[composeId].text || '') + emoji
    } else {
      homeDraft.text = (homeDraft.text || '') + emoji
    }
    render()
    return
  }

  // Remove attached media
  const removeMedia = e.target.closest('[data-remove-media]')
  if (removeMedia) {
    const idx = Number(removeMedia.dataset.removeMedia)
    const composeId = removeMedia.dataset.composeId
    if (composeId) {
      replyDrafts[composeId]?.media?.splice(idx, 1)
    } else {
      homeDraft.media.splice(idx, 1)
    }
    render()
    return
  }

  // Copy text helper
  const copyText = e.target.closest('[data-copy-text]')
  if (copyText) {
    const val = copyText.dataset.copyText
    try {
      await navigator.clipboard.writeText(val)
      toast('Copied to clipboard!')
    } catch {
      prompt('Key', val)
    }
    return
  }

  // Post Menu dropdown (3 dots) - opens native bottom sheet
  const menuBtn = e.target.closest('[data-post-menu]')
  if (menuBtn) {
    const id = menuBtn.dataset.postMenu
    openPostOpts(id)
    return
  }

  // Sheet action item clicked
  const sheetActionBtn = e.target.closest('[data-sheet-action]')
  if (sheetActionBtn) {
    const act = sheetActionBtn.dataset.sheetAction
    const post = (state?.posts || []).find((p) => p.id === activePostOptsId)
    if (!post) {
      postOptsDialog?.close()
      return
    }

    if (act === 'copy-text') {
      try {
        await navigator.clipboard.writeText(post.text)
        toast('Post text copied!')
      } catch {
        prompt('Post text', post.text)
      }
      postOptsDialog?.close()
    } else if (act === 'copy-key') {
      try {
        await navigator.clipboard.writeText(post.author)
        toast('Author key copied!')
      } catch {
        prompt('Author key', post.author)
      }
      postOptsDialog?.close()
    } else if (act === 'share') {
      try {
        await navigator.clipboard.writeText(post.id)
        toast('Post ID copied!')
      } catch {
        prompt('Post ID', post.id)
      }
      postOptsDialog?.close()
    } else if (act === 'toggle-follow') {
      const isF = following().has(post.author)
      send({ cmd: isF ? 'unfollow' : 'follow', key: post.author })
      toast(isF ? `Unfollowed @${short(post.author)}` : `Following @${short(post.author)}!`)
      postOptsDialog?.close()
    } else if (act === 'toggle-mute') {
      const isM = isMuted(post.author)
      send({ cmd: isM ? 'unmute' : 'mute', key: post.author })
      toast(isM ? `Unmuted @${short(post.author)}` : `Muted @${short(post.author)}`)
      postOptsDialog?.close()
    } else if (act === 'toggle-block') {
      const isB = isBlocked(post.author)
      send({ cmd: isB ? 'unblock' : 'block', key: post.author })
      toast(isB ? `Unblocked @${short(post.author)}` : `Blocked @${short(post.author)}`)
      postOptsDialog?.close()
    } else if (act === 'delete') {
      postOptsDialog?.close()
      showConfirm('Delete Post', 'Are you sure you want to delete this post from your feed?', () => {
        send({ cmd: 'delete_post', id: activePostOptsId })
        toast('Post deleted.')
      })
    } else if (act === 'open-report') {
      postOptsDialog?.close()
      reportDialog?.showModal()
    }
    return
  }

  // Report Modal: Back button
  if (e.target.closest('#btn-report-back')) {
    reportDialog?.close()
    if (activePostOptsId) openPostOpts(activePostOptsId)
    return
  }

  // Report Modal: Submit
  if (e.target.closest('#btn-submit-report')) {
    const checked = document.querySelector('input[name="report-reason"]:checked')
    const reason = checked ? checked.value : 'spam'
    const id = activePostOptsId
    reportDialog?.close()
    if (id) {
      toast('⛏️ Mining Proof of Work for report…')
      send({ cmd: 'report', id, reason })
      toast('🚩 Post reported. Community moderation updated.')
    }
    return
  }

  // Confirm Modal: Confirm Action
  if (e.target.closest('#btn-confirm-action')) {
    confirmDialog?.close()
    if (typeof pendingConfirmCallback === 'function') {
      const cb = pendingConfirmCallback
      pendingConfirmCallback = null
      cb()
    }
    return
  }
})

// File attachment handler for Compose
document.addEventListener('change', async (e) => {
  if (e.target.classList.contains('compose-file-input')) {
    const files = e.target.files
    if (!files || !files.length) return
    const composeId = e.target.dataset.composeId
    const draft = composeId ? replyDrafts[composeId] || (replyDrafts[composeId] = { text: '', media: [] }) : homeDraft

    for (let i = 0; i < files.length; i++) {
      if (draft.media.length >= 4) break
      try {
        const dataUrl = await compressImage(files[i])
        draft.media.push(dataUrl)
      } catch (err) {
        toast('Failed to load image')
      }
    }
    render()
    return
  }

  // Profile avatar upload
  if (e.target.id === 'edit-avatar-file') {
    const file = e.target.files?.[0]
    if (!file) return
    const dataUrl = await compressImage(file, 250, 250, 0.8)
    const prev = document.getElementById('edit-avatar-preview')
    const form = document.getElementById('edit-profile-form')
    if (prev && form) {
      prev.style.backgroundImage = `url(${dataUrl})`
      prev.textContent = ''
      form.dataset.avatar = dataUrl
    }
    return
  }

  // Profile banner upload
  if (e.target.id === 'edit-banner-file') {
    const file = e.target.files?.[0]
    if (!file) return
    const dataUrl = await compressImage(file, 800, 300, 0.75)
    const prev = document.getElementById('edit-banner-preview')
    const form = document.getElementById('edit-profile-form')
    if (prev && form) {
      prev.style.backgroundImage = `url(${dataUrl})`
      form.dataset.banner = dataUrl
    }
    return
  }
})

// Global search input in right bar
const globalSearch = document.getElementById('global-search')
if (globalSearch) {
  globalSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = globalSearch.value.trim()
      if (val) go('explore', val)
    }
  })
}

// Reset banner in edit profile
document.getElementById('btn-clear-banner')?.addEventListener('click', () => {
  const prev = document.getElementById('edit-banner-preview')
  const form = document.getElementById('edit-profile-form')
  if (prev && form) {
    prev.style.backgroundImage = 'none'
    form.dataset.banner = ''
  }
})

function openEditProfile() {
  if (!editProfileDialog) return
  const form = document.getElementById('edit-profile-form')
  const prof = state?.profiles?.[state?.me] || {}
  form.name.value = prof.name || ''
  form.bio.value = prof.bio || ''
  form.location.value = prof.location || ''
  form.website.value = prof.website || ''
  form.dataset.avatar = prof.avatar || ''
  form.dataset.banner = prof.banner || ''

  const avPrev = document.getElementById('edit-avatar-preview')
  if (avPrev) {
    if (prof.avatar) {
      avPrev.style.backgroundImage = `url(${prof.avatar})`
      avPrev.textContent = ''
    } else {
      avPrev.style.backgroundImage = 'none'
      avPrev.style.background = color(state?.me)
      avPrev.textContent = esc(nameOf(state?.me)[0]?.toUpperCase() || '?')
    }
  }

  const banPrev = document.getElementById('edit-banner-preview')
  if (banPrev) {
    banPrev.style.backgroundImage = prof.banner ? `url(${prof.banner})` : bannerGradient(state?.me)
  }

  editProfileDialog.showModal()
}

function openQrModal(key) {
  if (!qrDialog) return
  const canvas = document.getElementById('qr-canvas')
  const keyDisplay = document.getElementById('qr-key-text')
  const title = document.getElementById('qr-modal-title')

  if (title) title.textContent = key === state?.me ? 'My Feed Key QR Code' : `${esc(nameOf(key))}'s Feed Key`
  if (keyDisplay) keyDisplay.textContent = key

  if (canvas && window.QRCode) {
    window.QRCode.toCanvas(
      canvas,
      key,
      {
        width: 200,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' }
      },
      (err) => {
        if (err) console.error('QR code error', err)
      }
    )
  }

  const copyBtn = document.getElementById('qr-copy-btn')
  if (copyBtn) {
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(key)
        toast('Feed key copied!')
      } catch {
        prompt('Key', key)
      }
    }
  }

  qrDialog.showModal()
}

function openNetworkModal() {
  if (!networkDialog) return
  const content = document.getElementById('network-inspector-content')
  if (!content || !state) return

  const feedsList = Object.entries(state.profiles || {})
    .map(
      ([k, p]) => `
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px">
        <div>
          <b>${esc(p.name || 'anon')}</b> <span class="muted monospace">${short(k)}</span>
          ${k === state.me ? '<span style="color:var(--accent)"> (You)</span>' : ''}
        </div>
        <div>${p.length || 0} blocks synced</div>
      </div>`
    )
    .join('')

  content.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="net-status-row" style="background:var(--input-bg);border-radius:var(--radius-sm)">
        <span class="label">Connected Swarm Peers:</span>
        <span class="val ok">${state.peers} peer${state.peers === 1 ? '' : 's'}</span>
      </div>
      <div class="net-status-row" style="background:var(--input-bg);border-radius:var(--radius-sm)">
        <span class="label">Known Hypercore Feeds:</span>
        <span class="val">${Object.keys(state.profiles || {}).length}</span>
      </div>
      <div class="net-status-row" style="background:var(--input-bg);border-radius:var(--radius-sm)">
        <span class="label">Total Posts Indexed:</span>
        <span class="val">${state.posts?.length || 0}</span>
      </div>
      <h3 style="margin-top:8px;font-size:15px">Active Feeds in Corestore</h3>
      <div style="max-height:220px;overflow-y:auto">
        ${feedsList}
      </div>
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center">
        <span class="muted" style="font-size:13px">App Updates (GitHub)</span>
        <button type="button" class="btn-sm outline" id="btn-net-open-updates">Check Updates</button>
      </div>
    </div>`

  networkDialog.showModal()
}

// --- In-App Updates (GitHub Releases) ---
const DEFAULT_REPO = 'creeperkafasi/p2p-social'
let availableUpdate = null

function getValidRepo(inputVal) {
  let r = (inputVal || localStorage.getItem('p2p_github_repo') || DEFAULT_REPO).trim()
  r = r.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '')
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(r)) {
    r = DEFAULT_REPO
  }
  localStorage.setItem('p2p_github_repo', r)
  return r
}

function getAppVersion() {
  if (window.AndroidUpdater?.getOtaVersion) {
    try {
      const ota = window.AndroidUpdater.getOtaVersion()
      const nativeVer = window.AndroidUpdater.getAppVersion()
      if (ota && ota !== nativeVer) return `${ota} (OTA)`
      return ota || nativeVer
    } catch {}
  }
  if (window.AndroidUpdater?.getAppVersion) {
    try {
      return window.AndroidUpdater.getAppVersion()
    } catch {}
  }
  return '0.1.0'
}

function openUpdateModal() {
  if (!updateDialog) return
  const currentVer = getAppVersion()
  const currentVerEl = document.getElementById('update-current-version')
  const repoInput = document.getElementById('update-repo-input')
  if (currentVerEl) currentVerEl.textContent = `v${currentVer}`
  if (repoInput) {
    repoInput.value = getValidRepo(repoInput.value)
  }
  updateDialog.showModal()
}

window.__onUpdateProgress = (percent, downloaded, total) => {
  const box = document.getElementById('update-progress-box')
  const fill = document.getElementById('update-progress-fill')
  const text = document.getElementById('update-progress-text')
  if (box) box.style.display = 'flex'
  if (fill) fill.style.width = `${percent}%`
  const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  if (text) {
    text.textContent = total > 0
      ? `Downloading… ${percent}% (${mb(downloaded)} / ${mb(total)})`
      : `Downloading… ${percent}% (${mb(downloaded)})`
  }
}

window.__onUpdateStatus = (status) => {
  const text = document.getElementById('update-progress-text')
  const btn = document.getElementById('btn-start-update')
  if (status === 'permission_required') {
    toast('Please enable "Install unknown apps" permission to update.')
    if (text) text.textContent = 'Awaiting installation permission…'
    if (btn) {
      btn.disabled = false
      btn.textContent = 'Open Installer'
    }
  } else if (status === 'installing') {
    toast('Launching system installer…')
    if (text) text.textContent = 'Installing update…'
  }
}

window.__onUpdateError = (err) => {
  toast('Update failed: ' + err)
  const btn = document.getElementById('btn-start-update')
  if (btn) {
    btn.disabled = false
    btn.textContent = 'Retry Download'
  }
  const text = document.getElementById('update-progress-text')
  if (text) text.textContent = 'Error: ' + err
}

async function checkUpdatesAction(interactive = true) {
  const btn = document.getElementById('btn-check-updates')
  const repoInput = document.getElementById('update-repo-input')
  const card = document.getElementById('update-info-card')
  const idleMsg = document.getElementById('update-idle-msg')
  const cardTitle = document.getElementById('update-card-title')
  const cardNotes = document.getElementById('update-card-notes')
  const fileSizeEl = document.getElementById('update-file-size')
  const startBtn = document.getElementById('btn-start-update')
  const progressBox = document.getElementById('update-progress-box')

  const repo = getValidRepo(repoInput?.value)
  if (repoInput) repoInput.value = repo

  if (btn) {
    btn.disabled = true
    btn.textContent = 'Checking…'
  }

  try {
    let updateInfo
    if (window.AndroidUpdater?.checkForUpdates) {
      const raw = window.AndroidUpdater.checkForUpdates(repo)
      updateInfo = JSON.parse(raw)
    } else {
      const current = getAppVersion()
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github.v3+json' }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} from GitHub API`)
      const json = await res.json()
      const tag = json.tag_name || ''
      const latest = tag.replace(/^v/, '').trim()
      const apkAsset = (json.assets || []).find((a) => a.name?.endsWith('.apk'))
      updateInfo = {
        success: true,
        currentVersion: current,
        latestVersion: latest,
        tagName: tag,
        releaseName: json.name || tag,
        releaseNotes: json.body || '',
        hasUpdate: isNewer(latest, current),
        apkUrl: apkAsset?.browser_download_url || json.html_url || '',
        apkSize: apkAsset?.size || 0
      }
    }

    if (!updateInfo.success) {
      throw new Error(updateInfo.error || 'Failed to check updates')
    }

    if (updateInfo.hasUpdate) {
      availableUpdate = updateInfo
      if (card) card.style.display = 'flex'
      if (idleMsg) idleMsg.style.display = 'none'
      if (cardTitle) cardTitle.textContent = `${updateInfo.releaseName || 'Release'} (${updateInfo.tagName})`
      if (cardNotes) cardNotes.textContent = updateInfo.releaseNotes || 'No release notes provided.'
      
      const otaBtn = document.getElementById('btn-start-ota')
      if (otaBtn) {
        if (updateInfo.hasOtaUpdate && updateInfo.otaUrl) {
          const kb = (updateInfo.otaSize / 1024).toFixed(0)
          otaBtn.style.display = 'inline-flex'
          otaBtn.textContent = `⚡ Apply Silent Update (${kb > 0 ? kb + ' KB' : 'Instant'})`
          otaBtn.disabled = false
        } else {
          otaBtn.style.display = 'none'
        }
      }

      if (fileSizeEl) {
        fileSizeEl.textContent = updateInfo.apkSize > 0
          ? `${(updateInfo.apkSize / (1024 * 1024)).toFixed(1)} MB`
          : ''
      }
      if (startBtn) {
        startBtn.disabled = !updateInfo.apkUrl
        startBtn.textContent = 'Download Full APK'
      }
      if (progressBox) progressBox.style.display = 'none'
      if (interactive) {
        openUpdateModal()
        toast(`New update available: ${updateInfo.tagName}`)
      }
    } else {
      availableUpdate = null
      if (card) card.style.display = 'none'
      if (idleMsg) {
        idleMsg.style.display = 'block'
        idleMsg.textContent = `You are on the latest version (v${updateInfo.currentOtaVersion || updateInfo.currentVersion}).`
      }
      if (interactive) toast('App is up to date!')
    }
  } catch (err) {
    if (interactive) toast('Update check: ' + err.message)
    if (idleMsg) {
      idleMsg.style.display = 'block'
      idleMsg.textContent = 'Could not fetch updates: ' + err.message
    }
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = 'Check for Updates'
    }
  }
}

function isNewer(latest, current) {
  if (!latest || !current || latest === current) return false
  const l = latest.split('.').map((n) => parseInt(n, 10) || 0)
  const c = current.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(l.length, c.length)
  for (let i = 0; i < len; i++) {
    const lPart = l[i] || 0
    const cPart = c[i] || 0
    if (lPart > cPart) return true
    if (lPart < cPart) return false
  }
  return false
}

function startDownloadAction() {
  if (!availableUpdate?.apkUrl) {
    toast('No download URL available for this update.')
    return
  }
  const btn = document.getElementById('btn-start-update')
  if (btn) {
    btn.disabled = true
    btn.textContent = 'Downloading…'
  }
  const box = document.getElementById('update-progress-box')
  if (box) box.style.display = 'flex'

  if (window.AndroidUpdater?.downloadAndInstall) {
    window.AndroidUpdater.downloadAndInstall(availableUpdate.apkUrl)
  } else {
    window.open(availableUpdate.apkUrl, '_blank')
    if (btn) {
      btn.disabled = false
      btn.textContent = 'Download in Browser'
    }
  }
}

function startOtaDownloadAction() {
  if (!availableUpdate?.otaUrl) {
    toast('No silent update bundle available.')
    return
  }
  const btn = document.getElementById('btn-start-ota')
  if (btn) {
    btn.disabled = true
    btn.textContent = 'Applying update…'
  }
  toast('Downloading silent update…')
  if (window.AndroidUpdater?.downloadAndApplyOta) {
    window.AndroidUpdater.downloadAndApplyOta(availableUpdate.otaUrl, availableUpdate.latestVersion)
  }
}

window.__onOtaApplied = (version) => {
  toast(`✨ Update v${version} applied silently!`)
  const banner = document.getElementById('ota-banner')
  const text = document.getElementById('ota-banner-text')
  if (banner && text) {
    text.textContent = `✨ Updated to v${version} silently!`
    banner.style.display = 'flex'
  }
  const otaBtn = document.getElementById('btn-start-ota')
  if (otaBtn) {
    otaBtn.disabled = true
    otaBtn.textContent = '✓ Applied!'
  }
  const curVer = document.getElementById('update-current-version')
  if (curVer) curVer.textContent = `v${version} (OTA)`
}

window.__onOtaError = (err) => {
  toast('Silent update error: ' + err)
  const otaBtn = document.getElementById('btn-start-ota')
  if (otaBtn) {
    otaBtn.disabled = false
    otaBtn.textContent = '⚡ Retry Silent Update'
  }
}

// Background silent OTA update check on boot (Instagram-style)
async function checkSilentOta() {
  if (!window.AndroidUpdater?.checkForUpdates) return
  try {
    const repo = getValidRepo()
    const raw = window.AndroidUpdater.checkForUpdates(repo)
    const updateInfo = JSON.parse(raw)
    if (updateInfo.success && updateInfo.hasOtaUpdate && updateInfo.otaUrl) {
      console.log('[OTA] Discovered silent update:', updateInfo.latestVersion)
      window.AndroidUpdater.downloadAndApplyOta(updateInfo.otaUrl, updateInfo.latestVersion)
    }
  } catch (err) {
    console.warn('[OTA] Silent check failed:', err)
  }
}

// Trigger silent check 4 seconds after app launches
setTimeout(checkSilentOta, 4000)

// Relative timestamps update every 20 seconds
setInterval(() => {
  if (document.activeElement?.name !== 'text') {
    render()
  }
}, 20000)

// Initial hash route
onHash()
send({ cmd: 'refresh' })
