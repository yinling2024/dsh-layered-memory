import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const DAY_MS = 86400000

export function nowIso() {
  return new Date().toISOString()
}

export function toDay(iso) {
  const t = Date.parse(String(iso || ''))
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function dayDiff(iso, now = Date.now()) {
  const t = Date.parse(String(iso || ''))
  if (!Number.isFinite(t)) return Infinity
  return Math.max(0, (now - t) / DAY_MS)
}

export function clip(text, max) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

export function normalizeText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function hashText(text) {
  return createHash('sha1').update(normalizeText(text)).digest('hex')
}

export function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
}

export function safeFileName(value, fallback = 'item') {
  const raw = String(value || '')
  const clean = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return clean || `${fallback}_${createHash('sha1').update(raw).digest('hex').slice(0, 10)}`
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return fallback
  }
}

export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, String(text), 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch {
    fs.copyFileSync(tmp, file)
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}

export function readJson(file, fallback) {
  const text = readText(file, '')
  if (!text.trim()) return fallback
  try {
    return JSON.parse(text)
  } catch {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {}
    return fallback
  }
}

export function writeJson(file, value) {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n')
}

export function appendJsonl(file, value, maxBytes = 5 * 1024 * 1024) {
  ensureDir(path.dirname(file))
  try {
    const st = fs.statSync(file)
    if (st.size > maxBytes) fs.renameSync(file, `${file}.1`)
  } catch {}
  fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8')
}

const CN_STOP = new Set([
  '的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '吗', '呢', '啊', '吧', '呀',
  '就', '都', '也', '和', '与', '这', '那', '什么', '怎么', '一个', '一下', '现在', '今天',
  '可以', '不要', '没有', '不是', '还是', '就是', '因为', '所以', '但是', '如果', '然后',
  '这个', '那个', '自己', '觉得', '知道', '时候', '已经', '还有', '只是', '真的', '有点',
])

const EN_STOP = new Set([
  'the', 'and', 'for', 'you', 'are', 'was', 'were', 'with', 'this', 'that', 'have', 'has',
  'but', 'not', 'from', 'they', 'will', 'can', 'just', 'what', 'when', 'where', 'how',
])

/**
 * 中文按二元组、英文按单词切。返回带重复的 token 数组，供 BM25 统计词频。
 */
export function tokenList(text) {
  const s = String(text ?? '').toLowerCase()
  const out = []
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) {
    if (!EN_STOP.has(m[0])) out.push(`w:${m[0]}`)
  }
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const seq = m[0]
    for (let i = 0; i < seq.length; i++) {
      const ch = seq[i]
      if (!CN_STOP.has(ch)) out.push(`u:${ch}`)
      if (i < seq.length - 1) {
        const bg = seq.slice(i, i + 2)
        if (!CN_STOP.has(bg)) out.push(`c:${bg}`)
      }
    }
  }
  return out
}

export function termCounts(tokens) {
  const map = new Map()
  for (const t of tokens) map.set(t, (map.get(t) || 0) + 1)
  return map
}

export function uniqueTokens(tokens) {
  return [...new Set(tokens)]
}

/**
 * 行级 diff（LCS）。只用于给人看，超过 240 行会截断。
 */
export function lineDiff(before, after) {
  const a = String(before ?? '').replace(/\r\n?/g, '\n').split('\n').slice(0, 240)
  const b = String(after ?? '').replace(/\r\n?/g, '\n').split('\n').slice(0, 240)
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${a[i]}`)
      i++
    } else {
      out.push(`+${b[j]}`)
      j++
    }
    if (out.length > 400) {
      out.push('…（diff 截断）')
      break
    }
  }
  while (i < n && out.length <= 400) out.push(`-${a[i++]}`)
  while (j < m && out.length <= 400) out.push(`+${b[j++]}`)
  return out.join('\n')
}

export function listFiles(dir, ext = '') {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && (!ext || d.name.endsWith(ext)))
      .map((d) => d.name)
  } catch {
    return []
  }
}
