// Proof of Work and Tokenizer utilities for p2p-social
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const STOP_WORDS = new Set([
  // English
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during',
  'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how',
  'if', 'in', 'into', 'is', 'it', 'its', 'itself',
  'just', 'me', 'more', 'most', 'my', 'myself',
  'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'same', 'she', 'should', 'so', 'some', 'such',
  'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
  // Turkish
  'acaba', 'altı', 'ama', 'ancak', 'artık', 'asla', 'aslında', 'ayrıca', 'bana', 'bazen', 'bazı', 'belki', 'ben', 'beni', 'benim', 'beri', 'bile', 'bir', 'biri', 'birkaç', 'birşey', 'biz', 'bize', 'bizi', 'bizim', 'böyle', 'bu', 'buna', 'bunda', 'bundan', 'bunu', 'bunun', 'burada', 'bütün', 'çoğu', 'çok', 'çünkü', 'da', 'daha', 'dahi', 'de', 'defa', 'değil', 'demek', 'diğer', 'diye', 'dolayı', 'edecek', 'eden', 'ederek', 'ediyor', 'eğer', 'en', 'etti', 'fakat', 'gibi', 'göre', 'halen', 'hangi', 'hatta', 'hem', 'henüz', 'hep', 'hepsi', 'her', 'herkes', 'hiç', 'hiçbir', 'ise', 'için', 'içinde', 'iki', 'ile', 'ilgili', 'işte', 'kadar', 'karşı', 'kendi', 'kendini', 'kendisi', 'kez', 'ki', 'kim', 'kime', 'mu', 'mü', 'mı', 'nasıl', 'ne', 'neden', 'nerede', 'nereye', 'niye', 'olan', 'olarak', 'oldu', 'olduğu', 'olmak', 'olması', 'olmaz', 'olsa', 'olsun', 'olur', 'oluyor', 'ona', 'ondan', 'onlar', 'onların', 'onu', 'onun', 'oysa', 'öyle', 'pek', 'rağmen', 'sadece', 'sanki', 'sen', 'seni', 'senin', 'siz', 'sizi', 'sizin', 'sonra', 'şey', 'şimdi', 'şöyle', 'şu', 'şuna', 'şunu', 'tarafından', 'tüm', 'üç', 'üzere', 'var', 'vardı', 've', 'veya', 'ya', 'yani', 'yapmak', 'yaptı', 'yine', 'yok', 'zaten'
])

function countLeadingZeroBits(buf) {
  let bits = 0
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]
    if (byte === 0) {
      bits += 8
    } else {
      bits += Math.clz32(byte) - 24
      break
    }
  }
  return bits
}

function verifyPoW(challenge, nonce, targetBits) {
  if (targetBits <= 0) return true
  if (nonce === undefined || nonce === null) return false
  const input = `${challenge}:${nonce}`
  const hash = crypto.hash(b4a.from(input))
  return countLeadingZeroBits(hash) >= targetBits
}

function minePoW(challenge, targetBits = 10, maxIterations = 2000000) {
  if (targetBits <= 0) return { nonce: 0, difficulty: 0 }
  let nonce = 0
  while (nonce < maxIterations) {
    const input = `${challenge}:${nonce}`
    const hash = crypto.hash(b4a.from(input))
    if (countLeadingZeroBits(hash) >= targetBits) {
      return { nonce, difficulty: targetBits }
    }
    nonce++
  }
  return { nonce, difficulty: 0 }
}

function extractTokens(text) {
  if (!text || typeof text !== 'string') return []
  // Strip URLs and mentions
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@\S+/g, ' ')
    .normalize('NFKC')
    .toLowerCase()

  // Match unicode words (letters and numbers)
  const words = cleaned.match(/[\p{L}\p{N}]+/gu) || []
  const tokens = []
  const seen = new Set()

  for (const w of words) {
    if (w.length < 3 || w.length > 25) continue
    if (STOP_WORDS.has(w)) continue
    if (!seen.has(w)) {
      seen.add(w)
      tokens.push(w)
      if (tokens.length >= 20) break
    }
  }
  return tokens
}

// Anti-Spam / Anti-Token-Stuffing:
// Guarantees that claimed tokens are actually contained within the post's text.
function filterValidTokens(claimedTokens, text) {
  if (!Array.isArray(claimedTokens) || !text || typeof text !== 'string') return []
  const lower = text.toLowerCase()
  const valid = []
  const seen = new Set()

  for (const t of claimedTokens) {
    if (typeof t !== 'string') continue
    const tok = t.trim().toLowerCase()
    if (tok.length < 3 || tok.length > 25) continue
    if (seen.has(tok)) continue
    // Check if word occurs in the text
    if (lower.includes(tok)) {
      seen.add(tok)
      valid.push(tok)
      if (valid.length >= 20) break
    }
  }
  return valid
}

module.exports = {
  STOP_WORDS,
  countLeadingZeroBits,
  verifyPoW,
  minePoW,
  extractTokens,
  filterValidTokens
}
