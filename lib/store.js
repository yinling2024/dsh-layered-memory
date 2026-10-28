import fs from 'node:fs'
import path from 'node:path'
import { appendJsonl, clip, dayDiff, DAY_MS, hashText, lineDiff, nowIso, randomId, readJson, readText, safeFileName, toDay, tokenList, termCounts, uniqueTokens, writeJson, writeTextAtomic } from './util.js'
import { coreFiles, ensureLayout, readCoreText } from './config.js'

const KIND_LABEL = { preference: '偏好', strategy: '策略', skill: '技能' }

function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

function parseTime(value) {
  const t = Date.parse(String(value || ''))
  return Number.isFinite(t) ? t : 0
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const out = []
  for (const t of tags) {
    const s = String(t || '').trim().slice(0, 24)
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= 12) break
  }
  return out
}

function firstLineTitle(content) {
  for (const line of String(content || '').split('\n')) {
    const s = line.replace(/^#{1,6}\s*/, '').trim()
    if (s) return clip(s, 60)
  }
  return '未命名记忆'
}

function summaryOf(content, max = 160) {
  return clip(String(content || '').replace(/\s+/g, ' ').trim(), max)
}

function isUniversalFactKey(key) {
  return /(^|\.)(内容|相关|其他|的事|事情|东西)$/.test(key)
}

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  } catch {
    try {
      fs.copyFileSync(from, to)
      fs.rmSync(from, { force: true })
    } catch {}
  }
}

function removeFile(file) {
  try { fs.rmSync(file, { force: true }) } catch {}
}

function readDirFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
}

export class LayeredStore {
  constructor(dir, config, options = {}) {
    this.dir = dir
    this.config = config
    this.diag = options.diag || (() => {})
    this.explicitDir = path.join(dir, 'explicit')
    this.entriesDir = path.join(this.explicitDir, 'entries')
    this.archiveDir = path.join(this.explicitDir, 'archive')
    this.trashDir = path.join(this.explicitDir, 'trash')
    this.manifestPath = path.join(this.explicitDir, 'manifest.json')
    this.implicitDir = path.join(dir, 'implicit')
    this.implicitPath = path.join(this.implicitDir, 'implicit.json')
    this.coreDir = path.join(dir, 'core')
    this.proposalsDir = path.join(this.coreDir, 'proposals')
    this.versionsDir = path.join(this.coreDir, 'versions')
    this.shortDir = path.join(dir, 'short-term')
    this.auditPath = path.join(dir, 'audit.jsonl')
    this._manifest = null
    this._manifestMtime = 0
    this._index = null
    this._implicit = null
    this._implicitMtime = 0
    ensureLayout(dir)
  }

  // ---------- 通用 ----------

  audit(actor, layer, action, target, details = {}) {
    try {
      appendJsonl(this.auditPath, {
        ts: nowIso(),
        actor: String(actor || 'system'),
        layer,
        action,
        target: String(target || ''),
        ...details,
      })
    } catch (error) {
      this.diag(`audit 写入失败：${error.message}`)
    }
  }

  loadManifest() {
    let mtime = 0
    try { mtime = fs.statSync(this.manifestPath).mtimeMs } catch {}
    if (this._manifest && mtime === this._manifestMtime) return this._manifest
    const raw = readJson(this.manifestPath, null)
    const manifest = raw && Array.isArray(raw.entries) ? raw : { version: 1, entries: [] }
    this._manifest = manifest
    this._manifestMtime = mtime
    return manifest
  }

  saveManifest(manifest) {
    writeJson(this.manifestPath, manifest)
    try { this._manifestMtime = fs.statSync(this.manifestPath).mtimeMs } catch {}
    this._manifest = manifest
    this._index = null
  }

  entryPath(entry) {
    const id = safeFileName(entry.id, 'mem')
    const rel = String(entry.file || '')
    if (/^(entries|archive|trash)\/[A-Za-z0-9._-]+\.md$/.test(rel)) {
      return path.join(this.explicitDir, rel)
    }
    return path.join(this.entriesDir, `${id}.md`)
  }

  entryContent(entry) {
    return readText(this.entryPath(entry), '')
  }

  findEntry(id) {
    const manifest = this.loadManifest()
    return manifest.entries.find((e) => e.id === id) || null
  }

  // ---------- 外显长期 ----------

  storeExplicit(input = {}) {
    const now = nowIso()
    const content = String(input.content || '').trim()
    if (!content) throw new Error('内容不能为空')
    if (content.length > 8000) throw new Error('单条记忆不能超过 8000 字')
    const type = input.type === 'episodic' ? 'episodic' : 'semantic'
    const significance = clamp(input.significance ?? 0.6, 0, 1)
    const confidence = clamp(input.confidence ?? 0.8, 0, 1)
    const title = clip(String(input.title || firstLineTitle(content)).trim(), 60)
    const summary = clip(String(input.summary || summaryOf(content)).trim(), 200)
    const tags = normalizeTags(input.tags)
    const factKey = clip(String(input.factKey || '').trim(), 80)
    if (factKey && isUniversalFactKey(factKey)) {
      throw new Error(`事实键过于笼统：「${factKey}」。请用「对象.方面」，例如「用户.称呼」`)
    }
    const source = clip(String(input.source || '').trim(), 200)
    const expiresAt = parseTime(input.expiresAt) ? new Date(parseTime(input.expiresAt)).toISOString() : null
    const contentHash = hashText(content)
    const manifest = this.loadManifest()
    const existing = manifest.entries.find((e) =>
      ['active', 'candidate'].includes(e.status) && e.contentHash === contentHash
    )
    if (existing) {
      existing.updatedAt = now
      existing.significance = Math.max(Number(existing.significance) || 0, significance)
      existing.tags = [...new Set([...(existing.tags || []), ...tags])].slice(0, 12)
      existing.hits = (Number(existing.hits) || 1) + 1
      let superseded = null
      if (existing.status === 'candidate' && (input.status === 'active' || significance >= this.config.explicit.candidateBelow)) {
        existing.status = 'active'
        existing.type = type
        existing.title = title || existing.title
        existing.summary = summary || existing.summary
        existing.confidence = Math.max(Number(existing.confidence) || 0, confidence)
        if (factKey && !existing.factKey) existing.factKey = factKey
        if (existing.factKey) {
          for (const old of manifest.entries) {
            if (old.id !== existing.id && old.status === 'active' && old.factKey === existing.factKey) {
              old.status = 'superseded'
              old.supersededBy = existing.id
              old.updatedAt = now
              existing.supersedes = old.id
              superseded = old
            }
          }
        }
        this.audit('model', 'explicit', 'promote-on-store', existing.id, {
          title: existing.title,
          significance: existing.significance,
          superseded: superseded ? superseded.id : undefined,
        })
      }
      this.saveManifest(manifest)
      return { entry: existing, deduped: true, superseded }
    }

    const id = randomId('mem')
    const status = input.status === 'candidate' || significance < this.config.explicit.candidateBelow ? 'candidate' : 'active'
    const entry = {
      id,
      type,
      title,
      summary,
      tags,
      significance,
      confidence,
      status,
      source,
      contentHash,
      factKey: factKey || null,
      file: `entries/${id}.md`,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: null,
      accessCount: 0,
      hits: 1,
      expiresAt,
      supersededBy: null,
      supersedes: null,
    }
    writeTextAtomic(path.join(this.entriesDir, `${id}.md`), `# ${title}\n\n${content}\n`)

    let superseded = null
    if (factKey) {
      for (const old of manifest.entries) {
        if (old.id !== id && old.status === 'active' && old.factKey === factKey) {
          old.status = 'superseded'
          old.supersededBy = id
          old.updatedAt = now
          entry.supersedes = old.id
          superseded = old
        }
      }
    }
    manifest.entries.push(entry)
    this.saveManifest(manifest)
    this.audit('model', 'explicit', 'store', id, {
      title,
      type,
      significance,
      status,
      factKey: factKey || undefined,
      superseded: superseded ? superseded.id : undefined,
    })
    return { entry, deduped: false, superseded }
  }

  maybeCandidate(text, source) {
    if (!this.config.shortTerm.autoCandidate) return null
    const content = String(text || '').trim()
    if (content.length < 8) return null
    const manifest = this.loadManifest()
    const hash = hashText(content)
    const existing = manifest.entries.find((e) => ['candidate', 'active'].includes(e.status) && e.contentHash === hash)
    if (existing) {
      existing.hits = (Number(existing.hits) || 1) + 1
      existing.updatedAt = nowIso()
      this.saveManifest(manifest)
      return existing.status === 'candidate' ? existing : null
    }
    const candidates = manifest.entries.filter((e) => e.status === 'candidate')
    if (candidates.length >= this.config.shortTerm.maxCandidates) {
      candidates.sort((a, b) => parseTime(a.createdAt) - parseTime(b.createdAt))
      const oldest = candidates[0]
      if (oldest) {
        oldest.status = 'deleted'
        oldest.updatedAt = nowIso()
        oldest.file = `trash/${oldest.id}.md`
        moveFile(path.join(this.entriesDir, `${oldest.id}.md`), path.join(this.trashDir, `${oldest.id}.md`))
      }
    }
    const id = randomId('mem')
    const entry = {
      id,
      type: 'episodic',
      title: firstLineTitle(content),
      summary: summaryOf(content),
      tags: [],
      significance: 0.45,
      confidence: 0.55,
      status: 'candidate',
      source: clip(source || 'short-term', 200),
      contentHash: hash,
      factKey: null,
      file: `entries/${id}.md`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastAccessedAt: null,
      accessCount: 0,
      hits: 1,
      expiresAt: null,
      supersededBy: null,
      supersedes: null,
    }
    writeTextAtomic(path.join(this.entriesDir, `${id}.md`), `# ${entry.title}\n\n${content}\n`)
    manifest.entries.push(entry)
    this.saveManifest(manifest)
    this.audit('system', 'explicit', 'candidate', id, { source: entry.source, summary: entry.summary })
    return entry
  }

  buildIndex() {
    if (this._index) return this._index
    const manifest = this.loadManifest()
    const entries = manifest.entries.filter((e) => ['active', 'candidate'].includes(e.status))
    const rows = []
    const df = new Map()
    for (const entry of entries) {
      const content = this.entryContent(entry)
      const tokens = tokenList(`${entry.title} ${(entry.tags || []).join(' ')} ${entry.summary} ${content}`)
      const counts = termCounts(tokens)
      for (const token of counts.keys()) df.set(token, (df.get(token) || 0) + 1)
      rows.push({ entry, counts, tokenCount: Math.max(1, tokens.length), content })
    }
    this._index = { rows, df, n: rows.length, builtAt: Date.now() }
    return this._index
  }

  scoreRow(row, queryTokens, idf, norm) {
    let raw = 0
    for (const token of queryTokens) {
      const tf = row.counts.get(token) || 0
      if (!tf) continue
      const weight = token.startsWith('u:') ? 0.35 : 1
      raw += idf * (tf / (tf + 1.2)) * weight
    }
    let relevance = norm > 0 ? raw / Math.sqrt(row.tokenCount) / norm : 0
    const entry = row.entry
    const tagText = (entry.tags || []).join(' ').toLowerCase()
    if (tagText) {
      for (const token of queryTokens) {
        const plain = token.slice(2)
        if (plain.length >= 2 && tagText.includes(plain)) {
          relevance += 0.12
          break
        }
      }
    }
    const age = dayDiff(entry.createdAt)
    const recency = Number.isFinite(age) ? Math.exp(-age / Math.max(1, this.config.recall.halfLifeDays)) : 0.4
    const significance = clamp(entry.significance, 0, 1)
    const confidence = clamp(entry.confidence, 0, 1)
    const final = 0.55 * relevance + 0.2 * recency + 0.15 * significance + 0.1 * confidence
    return { relevance, recency, significance, confidence, final }
  }

  searchExplicit(query = '', options = {}) {
    const limit = Math.max(1, Math.min(20, Number(options.limit) || this.config.recall.topK))
    const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : this.config.recall.minScore
    const includeCandidates = options.includeCandidates === true
    const index = this.buildIndex()
    const manifest = this.loadManifest()
    const rows = index.rows.filter((r) => includeCandidates || r.entry.status === 'active')
    const now = Date.now()
    const queryText = String(query || '').trim()
    const queryTokens = uniqueTokens(tokenList(queryText))
    const idf = new Map()
    for (const token of queryTokens) {
      const df = index.df.get(token) || 0
      idf.set(token, Math.log(1 + (index.n - df + 0.5) / (df + 0.5)))
    }
    const norm = [...idf.values()].reduce((a, b) => a + b, 0) || 1
    const scored = []
    for (const row of rows) {
      const score = queryTokens.length ? this.scoreRow(row, queryTokens, idf, norm) : {
        relevance: 0,
        recency: Math.exp(-dayDiff(row.entry.createdAt) / Math.max(1, this.config.recall.halfLifeDays)),
        significance: clamp(row.entry.significance, 0, 1),
        confidence: clamp(row.entry.confidence, 0, 1),
        final: clamp(row.entry.significance, 0, 1) * 0.6 + Math.exp(-dayDiff(row.entry.createdAt) / Math.max(1, this.config.recall.halfLifeDays)) * 0.4,
      }
      if (row.entry.expiresAt && parseTime(row.entry.expiresAt) <= now) continue
      if (queryTokens.length && score.relevance <= 0 && !options.includeLowRelevance) continue
      if (queryTokens.length && score.final < minScore) continue
      scored.push({ entry: row.entry, content: row.content, score })
    }
    scored.sort((a, b) => b.score.final - a.score.final)
    const picked = []
    const seen = new Set()
    const alwaysFacts = Math.max(0, Math.min(5, Number(this.config.recall.alwaysFacts) || 0))
    if (alwaysFacts > 0) {
      const facts = manifest.entries
        .filter((e) => e.status === 'active' && e.type === 'semantic' && clamp(e.significance, 0, 1) >= 0.8)
        .sort((a, b) => (Number(b.significance) || 0) - (Number(a.significance) || 0) || parseTime(b.createdAt) - parseTime(a.createdAt))
        .slice(0, alwaysFacts)
      for (const entry of facts) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        picked.push({
          entry,
          content: this.entryContent(entry),
          score: { relevance: 0, recency: 1, significance: clamp(entry.significance, 0, 1), confidence: clamp(entry.confidence, 0, 1), final: 1 },
          always: true,
        })
      }
    }
    for (const row of scored) {
      if (picked.length >= limit + alwaysFacts) break
      if (seen.has(row.entry.id)) continue
      seen.add(row.entry.id)
      picked.push(row)
    }
    if (options.touch) {
      const ids = new Set(picked.map((p) => p.entry.id))
      let changed = false
      for (const entry of manifest.entries) {
        if (!ids.has(entry.id)) continue
        entry.lastAccessedAt = nowIso()
        entry.accessCount = (Number(entry.accessCount) || 0) + 1
        changed = true
      }
      if (changed) this.saveManifest(manifest)
    }
    return {
      query: queryText,
      results: picked.map((row) => ({
        id: row.entry.id,
        title: row.entry.title,
        type: row.entry.type,
        status: row.entry.status,
        significance: row.entry.significance,
        confidence: row.entry.confidence,
        createdAt: row.entry.createdAt,
        tags: row.entry.tags || [],
        factKey: row.entry.factKey || null,
        always: row.always === true,
        score: Number(row.score.final.toFixed(3)),
        relevance: Number(row.score.relevance.toFixed(3)),
        snippet: clip(String(row.content || row.entry.summary || '').replace(/\s+/g, ' ').trim(), 240),
      })),
    }
  }

  forgetExplicit(id, options = {}) {
    const manifest = this.loadManifest()
    const entry = manifest.entries.find((e) => e.id === id)
    if (!entry) throw new Error(`找不到记忆 ${id}`)
    if (entry.status === 'deleted') return { already: true, entry }
    const source = this.entryPath(entry)
    entry.status = 'deleted'
    entry.deletedAt = nowIso()
    entry.updatedAt = nowIso()
    if (options.hard) {
      removeFile(source)
      entry.file = null
      manifest.entries = manifest.entries.filter((e) => e.id !== id)
    } else {
      const dest = path.join(this.trashDir, `${entry.id}.md`)
      moveFile(source, dest)
      entry.file = `trash/${entry.id}.md`
    }
    this.saveManifest(manifest)
    this.audit(options.actor || 'user', 'explicit', options.hard ? 'forget-hard' : 'forget', id, {
      title: entry.title,
      factKey: entry.factKey || undefined,
    })
    return { entry, hard: options.hard === true }
  }

  promoteCandidates() {
    const manifest = this.loadManifest()
    let changed = 0
    const now = Date.now()
    for (const entry of manifest.entries) {
      if (entry.status !== 'candidate') continue
      const age = now - parseTime(entry.createdAt)
      const expired = entry.expiresAt && parseTime(entry.expiresAt) <= now
      if (expired) {
        entry.status = 'expired'
        entry.updatedAt = nowIso()
        changed++
        continue
      }
      if (age > 30 * DAY_MS) {
        entry.status = 'deleted'
        entry.deletedAt = nowIso()
        entry.updatedAt = nowIso()
        moveFile(path.join(this.entriesDir, `${entry.id}.md`), path.join(this.trashDir, `${entry.id}.md`))
        entry.file = `trash/${entry.id}.md`
        changed++
        continue
      }
      const hits = Number(entry.hits) || 1
      const promote = (hits >= 2 && age >= 60 * 60 * 1000)
        || (Number(entry.significance) >= 0.65 && age >= 10 * 60 * 1000)
      if (promote) {
        entry.status = 'active'
        entry.significance = Math.max(Number(entry.significance) || 0, 0.55)
        entry.updatedAt = nowIso()
        this.audit('system', 'explicit', 'promote', entry.id, { hits, significance: entry.significance })
        changed++
      }
    }
    if (changed) this.saveManifest(manifest)
    return changed
  }

  archiveStale() {
    const manifest = this.loadManifest()
    const now = Date.now()
    let changed = 0
    for (const entry of manifest.entries) {
      if (entry.status !== 'active') continue
      const age = now - parseTime(entry.lastAccessedAt || entry.createdAt)
      const low = Number(entry.significance) < this.config.explicit.archiveBelow
      if (low && age > this.config.explicit.archiveAfterDays * DAY_MS) {
        entry.status = 'archived'
        entry.updatedAt = nowIso()
        const from = this.entryPath(entry)
        const to = path.join(this.archiveDir, `${entry.id}.md`)
        moveFile(from, to)
        entry.file = `archive/${entry.id}.md`
        this.audit('system', 'explicit', 'archive', entry.id, { significance: entry.significance })
        changed++
      }
    }
    for (const entry of manifest.entries) {
      if (entry.status !== 'deleted' || !entry.deletedAt || entry.purgedAt) continue
      if (now - parseTime(entry.deletedAt) > this.config.explicit.trashDays * DAY_MS) {
        removeFile(this.entryPath(entry))
        this.audit('system', 'explicit', 'purge', entry.id, {})
        entry.purgedAt = nowIso()
        entry.file = null
        changed++
      }
    }
    if (changed) this.saveManifest(manifest)
    return changed
  }

  // ---------- 内隐 ----------

  loadImplicit() {
    let mtime = 0
    try { mtime = fs.statSync(this.implicitPath).mtimeMs } catch {}
    if (this._implicit && mtime === this._implicitMtime) return this._implicit
    const raw = readJson(this.implicitPath, null)
    const value = raw && Array.isArray(raw.params) ? raw : { version: 1, params: [], candidates: [], daily: {} }
    if (!Array.isArray(value.candidates)) value.candidates = []
    if (!value.daily || typeof value.daily !== 'object') value.daily = {}
    this._implicit = value
    this._implicitMtime = mtime
    return value
  }

  saveImplicit(value) {
    writeJson(this.implicitPath, value)
    try { this._implicitMtime = fs.statSync(this.implicitPath).mtimeMs } catch {}
    this._implicit = value
  }

  observeImplicit(input = {}) {
    const kind = ['preference', 'strategy', 'skill'].includes(input.kind) ? input.kind : 'preference'
    const key = clip(String(input.key || '').trim(), 40)
    const value = clip(String(input.value || input.content || '').trim(), 300)
    const scope = clip(String(input.scope || 'global').trim(), 40) || 'global'
    if (!key || !value) throw new Error('内隐记忆需要 key 和 value')
    if (input.correct === true) {
      return this.correctImplicit({ kind, key, value, scope, note: input.note, actor: input.actor })
    }
    const data = this.loadImplicit()
    const now = nowIso()
    let candidate = data.candidates.find((c) =>
      c.status === 'open' && c.kind === kind && c.key === key && c.scope === scope && c.value.toLowerCase() === value.toLowerCase()
    )
    if (!candidate) {
      candidate = {
        id: randomId('impc'),
        kind,
        key,
        value,
        scope,
        status: 'open',
        evidence: [],
        createdAt: now,
        updatedAt: now,
      }
      data.candidates.push(candidate)
    }
    candidate.evidence.push({ at: now, note: clip(String(input.note || '').trim(), 200) })
    candidate.updatedAt = now
    this.saveImplicit(data)
    this.audit(input.actor || 'model', 'implicit', 'observe', candidate.id, { kind, key, value, scope })
    return candidate
  }

  correctImplicit(input = {}) {
    const kind = ['preference', 'strategy', 'skill'].includes(input.kind) ? input.kind : 'preference'
    const key = clip(String(input.key || '').trim(), 40)
    const value = clip(String(input.value || '').trim(), 300)
    const scope = clip(String(input.scope || 'global').trim(), 40) || 'global'
    if (!key || !value) throw new Error('内隐修正需要 key 和 value')
    const data = this.loadImplicit()
    const now = nowIso()
    for (const p of data.params) {
      if (p.kind === kind && p.key === key && p.scope === scope && p.status === 'active' && p.value.toLowerCase() !== value.toLowerCase()) {
        p.status = 'weakened'
        p.confidence = Math.max(0, Number(p.confidence || 0) * 0.5)
        p.updatedAt = now
        p.history = [...(p.history || []), { at: now, action: 'weakened-by-correction', oldConfidence: p.confidence }]
      }
    }
    let param = data.params.find((p) =>
      p.kind === kind && p.key === key && p.scope === scope && p.status === 'active' && p.value.toLowerCase() === value.toLowerCase()
    )
    if (!param) {
      param = {
        id: randomId('imp'),
        kind,
        key,
        value,
        scope,
        status: 'active',
        confidence: 0.6,
        evidence: [],
        createdAt: now,
        updatedAt: now,
        history: [],
      }
      data.params.push(param)
    }
    param.confidence = Math.min(0.8, Math.max(0.6, Number(param.confidence) || 0.6))
    param.evidence.push({ at: now, note: clip(String(input.note || '用户纠正').trim(), 200), correction: true })
    param.updatedAt = now
    this.saveImplicit(data)
    this.audit(input.actor || 'user', 'implicit', 'correct', param.id, { kind, key, value, scope })
    return param
  }

  reflectImplicit() {
    const data = this.loadImplicit()
    const cfg = this.config.implicit
    const now = new Date()
    const today = toDay(now.toISOString())
    const groups = new Map()
    for (const c of data.candidates) {
      if (c.status !== 'open') continue
      const gk = `${c.kind}\u0000${c.key}\u0000${c.scope}`
      if (!groups.has(gk)) groups.set(gk, [])
      groups.get(gk).push(c)
    }
    let updated = 0
    for (const group of groups.values()) {
      const evidence = group.flatMap((c) => c.evidence || [])
      if (evidence.length < cfg.minEvidence) continue
      const days = new Set(evidence.map((e) => toDay(e.at))).size
      if (days < cfg.minDays) continue
      if ((Number(data.daily[today]) || 0) >= cfg.dailyUpdates) break
      const best = [...group].sort((a, b) => (b.evidence.length - a.evidence.length) || (parseTime(b.updatedAt) - parseTime(a.updatedAt)))[0]
      if (!best) continue
      let param = data.params.find((p) =>
        p.kind === best.kind && p.key === best.key && p.scope === best.scope && p.status === 'active'
      )
      const step = Math.min(0.05, Math.max(0.01, Number(cfg.maxStep) || 0.05))
      if (!param) {
        param = {
          id: randomId('imp'),
          kind: best.kind,
          key: best.key,
          value: best.value,
          scope: best.scope,
          status: 'active',
          confidence: Math.min(0.75, 0.55 + 0.02 * evidence.length),
          evidence: [],
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          history: [],
        }
        data.params.push(param)
      } else if (param.value.toLowerCase() === best.value.toLowerCase()) {
        param.confidence = Math.min(0.95, Number(param.confidence) + Math.min(step, 0.01 + 0.005 * evidence.length))
        param.updatedAt = now.toISOString()
      } else {
        param.status = 'weakened'
        param.confidence = Math.max(0, Number(param.confidence) * 0.7)
        param.updatedAt = now.toISOString()
        param.history = [...(param.history || []), { at: param.updatedAt, action: 'weakened-by-new-evidence', oldValue: param.value }]
        param = {
          id: randomId('imp'),
          kind: best.kind,
          key: best.key,
          value: best.value,
          scope: best.scope,
          status: 'active',
          confidence: Math.min(0.75, 0.55 + 0.02 * evidence.length),
          evidence: [],
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          history: [],
        }
        data.params.push(param)
      }
      param.evidence = [...(param.evidence || []), ...evidence.slice(-8)].slice(-32)
      for (const c of group) {
        c.status = 'consolidated'
        c.consolidatedAt = now.toISOString()
      }
      data.daily[today] = (Number(data.daily[today]) || 0) + 1
      updated++
      this.audit('system', 'implicit', 'reflect', param.id, {
        kind: param.kind,
        key: param.key,
        value: param.value,
        evidence: evidence.length,
        days,
        confidence: Number(param.confidence.toFixed(3)),
      })
    }
    for (const key of Object.keys(data.daily)) {
      if (dayDiff(key + 'T00:00:00.000Z', now.getTime()) > 30) delete data.daily[key]
    }
    if (updated) this.saveImplicit(data)
    return updated
  }

  renderImplicit(maxChars = 900, maxItems = 12) {
    const data = this.loadImplicit()
    const minConfidence = Number(this.config.implicit.minConfidence) || 0.55
    const active = data.params
      .filter((p) => p.status === 'active' && Number(p.confidence) >= minConfidence)
      .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0) || parseTime(b.updatedAt) - parseTime(a.updatedAt))
      .slice(0, maxItems)
    if (!active.length) return ''
    const lines = active.map((p) => {
      const label = KIND_LABEL[p.kind] || p.kind
      const scope = p.scope && p.scope !== 'global' ? `（${p.scope}）` : ''
      return `- ${label}｜${p.key}${scope}：${p.value}（置信度 ${Math.round(Number(p.confidence) * 100)}%）`
    })
    return clip([
      '【内隐记忆 · 风格先验】',
      '这些是从长期互动中提炼的倾向，只影响你怎么表达、怎么偏好，不是事实；与核心层冲突时以核心层为准。',
      ...lines,
    ].join('\n'), maxChars)
  }

  // ---------- 短期 ----------

  shortPath(sid) {
    return path.join(this.shortDir, `${safeFileName(sid, 'session')}.json`)
  }

  loadShort(sid) {
    const raw = readJson(this.shortPath(sid), null)
    if (raw && Array.isArray(raw.items)) return raw
    return { version: 1, session: sid, items: [], updatedAt: null }
  }

  saveShort(sid, data) {
    data.updatedAt = nowIso()
    writeJson(this.shortPath(sid), data)
  }

  sweepShort(sid) {
    const data = this.loadShort(sid)
    const now = Date.now()
    const before = data.items.length
    data.items = data.items.filter((item) => parseTime(item.expiresAt) > now)
    if (data.items.length !== before) this.saveShort(sid, data)
    return data
  }

  appendShort(sid, input = {}) {
    const text = String(input.text || '').trim()
    if (!text) return null
    const data = this.sweepShort(sid)
    const role = input.role === 'assistant' ? 'assistant' : 'user'
    const salience = clamp(input.salience ?? 0.3, 0, 1)
    const ttlMinutes = Math.max(1, Number(input.ttlMinutes) || this.config.shortTerm.ttlMinutes)
    const at = nowIso()
    const last = data.items[data.items.length - 1]
    if (last && last.role === role && last.text === clip(text, 1200) && parseTime(last.at) > Date.now() - 60000) {
      return last
    }
    const item = {
      id: randomId('stm'),
      role,
      text: clip(text, 1200),
      at,
      expiresAt: new Date(Date.now() + ttlMinutes * 60000).toISOString(),
      salience,
    }
    data.items.push(item)
    if (data.items.length > this.config.shortTerm.maxItems) {
      data.items.sort((a, b) => (Number(a.salience) - Number(b.salience)) || (parseTime(a.at) - parseTime(b.at)))
      data.items = data.items.slice(data.items.length - this.config.shortTerm.maxItems)
    }
    this.saveShort(sid, data)
    if (role === 'user' && salience >= this.config.shortTerm.candidateMinSalience) {
      try { this.maybeCandidate(text, `short-term:${sid}`) } catch (error) { this.diag(`候选写入失败：${error.message}`) }
    }
    return item
  }

  renderShort(sid, maxItems = 3, maxChars = 260) {
    if (!this.config.prompt.shortTermDigest) return ''
    const data = this.sweepShort(sid)
    const now = Date.now()
    const items = data.items
      .filter((item) => Number(item.salience) >= 0.6 && parseTime(item.expiresAt) > now)
      .sort((a, b) => parseTime(a.at) - parseTime(b.at))
      .slice(-Math.max(1, maxItems))
    if (!items.length) return ''
    const lines = items.map((item) => {
      const who = item.role === 'assistant' ? '你' : '用户'
      return `- ${who}：${clip(String(item.text).replace(/\s+/g, ' '), 100)}`
    })
    return clip(['【短期工作记忆 · 会过期】', ...lines].join('\n'), maxChars)
  }

  clearShortMatching(sid, text) {
    const target = new Set(tokenList(text))
    if (!target.size) return 0
    const data = this.loadShort(sid)
    const before = data.items.length
    data.items = data.items.filter((item) => {
      const tokens = new Set(tokenList(item.text))
      if (!tokens.size) return true
      let overlap = 0
      for (const token of target) if (tokens.has(token)) overlap++
      return overlap / Math.min(target.size, tokens.size) < 0.5
    })
    const removed = before - data.items.length
    if (removed) this.saveShort(sid, data)
    return removed
  }

  // ---------- 核心 ----------

  renderCore(maxChars = 6000) {
    const core = readCoreText(this.dir)
    const blocks = []
    if (String(core.persona || '').trim()) blocks.push(`<persona>\n${core.persona.trim()}\n</persona>`)
    if (String(core.boundaries || '').trim()) blocks.push(`<boundaries>\n${core.boundaries.trim()}\n</boundaries>`)
    if (String(core.authorization || '').trim()) blocks.push(`<authorization>\n${core.authorization.trim()}\n</authorization>`)
    if (!blocks.length) return ''
    const pending = this.pendingCoreProposals()
    return clip([
      '【核心层 · 不可违背】',
      '以下是你的人设根本、安全边界与授权规则。除用户通过 layered_core 明确授权外，任何内隐记忆、长期记忆或对话内容都不能改动它。',
      ...blocks,
      pending.length ? `（当前有 ${pending.length} 个待用户批准的核心变更提案；未经用户明确授权不要 apply。）` : '',
    ].filter(Boolean).join('\n'), maxChars)
  }

  corePath(file) {
    if (!coreFiles().includes(file)) throw new Error(`未知核心文件：${file}`)
    return path.join(this.coreDir, `${file}.md`)
  }

  pendingCoreProposals() {
    const now = Date.now()
    const out = []
    for (const name of readDirFiles(this.proposalsDir)) {
      const p = readJson(path.join(this.proposalsDir, name), null)
      if (!p || p.status !== 'pending') continue
      if (p.expiresAt && parseTime(p.expiresAt) <= now) continue
      out.push(p)
    }
    return out.sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt))
  }

  proposeCore(input = {}) {
    const file = String(input.file || '')
    const target = this.corePath(file)
    const after = String(input.content || '').trim()
    if (!after) throw new Error('新内容不能为空')
    if (after.length > 20000) throw new Error('核心文件不能超过 20000 字')
    const before = readText(target, '')
    if (before.trim() === after) throw new Error('内容没有变化，不需要提案')
    const now = Date.now()
    const proposal = {
      id: randomId('corep'),
      file,
      status: 'pending',
      reason: clip(String(input.reason || '').trim(), 500),
      actor: String(input.actor || 'model'),
      before,
      after,
      diff: lineDiff(before, after),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.config.core.proposalTtlHours * 3600000).toISOString(),
      appliedAt: null,
      versionId: null,
    }
    writeJson(path.join(this.proposalsDir, `${proposal.id}.json`), proposal)
    this.audit(proposal.actor, 'core', 'propose', proposal.id, { file, reason: proposal.reason })
    return proposal
  }

  applyCore(input = {}) {
    if (!this.config.core.applyEnabled) throw new Error('核心层变更已在 config.json 中关闭（core.applyEnabled=false）')
    if (input.confirm !== 'APPLY') throw new Error('核心层变更需要 confirm 参数恰好为 "APPLY"，并且必须先得到用户明确授权')
    const id = String(input.proposalId || input.proposal_id || '')
    const proposalPath = path.join(this.proposalsDir, `${safeFileName(id, 'corep')}.json`)
    const proposal = readJson(proposalPath, null)
    if (!proposal) throw new Error(`找不到提案 ${id}`)
    if (proposal.status !== 'pending') throw new Error(`提案 ${id} 状态是 ${proposal.status}，不能重复应用`)
    const now = Date.now()
    if (proposal.expiresAt && parseTime(proposal.expiresAt) <= now) throw new Error('提案已过期，请重新生成')
    const elapsed = now - parseTime(proposal.createdAt)
    const cooldown = this.config.core.applyCooldownSeconds * 1000
    if (elapsed < cooldown) {
      const wait = Math.ceil((cooldown - elapsed) / 1000)
      throw new Error(`提案刚生成，还需要 ${wait} 秒冷却；请先把 diff 给用户看并等待明确授权`)
    }
    const target = this.corePath(proposal.file)
    const versionId = `${proposal.file}.${now}.md`
    const backup = readText(target, '')
    writeTextAtomic(path.join(this.versionsDir, versionId), backup)
    writeTextAtomic(target, proposal.after + '\n')
    proposal.status = 'applied'
    proposal.appliedAt = new Date(now).toISOString()
    proposal.versionId = versionId
    writeJson(proposalPath, proposal)
    this.audit(input.actor || 'model', 'core', 'apply', proposal.id, {
      file: proposal.file,
      versionId,
      reason: proposal.reason,
    })
    return { proposal, versionId }
  }

  listCoreVersions(file) {
    this.corePath(file)
    const prefix = `${file}.`
    return fs.readdirSync(this.versionsDir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.md') && !n.endsWith('.rollback-before.md'))
      .sort()
      .reverse()
  }

  rollbackCore(input = {}) {
    if (!this.config.core.applyEnabled) throw new Error('核心层变更已关闭（core.applyEnabled=false）')
    if (input.confirm !== 'APPLY') throw new Error('回滚需要 confirm 参数恰好为 "APPLY"')
    const file = String(input.file || '')
    const target = this.corePath(file)
    const versions = this.listCoreVersions(file)
    if (!versions.length) throw new Error(`没有 ${file} 的历史版本`)
    const versionId = String(input.versionId || input.version_id || versions[0])
    if (!versions.includes(versionId)) throw new Error(`找不到版本 ${versionId}`)
    const old = readText(path.join(this.versionsDir, versionId), '')
    const current = readText(target, '')
    const safety = `${file}.${Date.now()}.rollback-before.md`
    writeTextAtomic(path.join(this.versionsDir, safety), current)
    writeTextAtomic(target, old)
    this.audit(input.actor || 'user', 'core', 'rollback', file, { versionId, safety })
    return { file, versionId, safety }
  }

  // ---------- 状态 ----------

  status() {
    const manifest = this.loadManifest()
    const counts = {}
    for (const e of manifest.entries) counts[e.status] = (counts[e.status] || 0) + 1
    const implicit = this.loadImplicit()
    const pending = this.pendingCoreProposals()
    const shortFiles = readDirFiles(this.shortDir).length
    return {
      dir: this.dir,
      explicit: {
        total: manifest.entries.length,
        counts,
        entries: manifest.entries.filter((e) => e.status === 'active').length,
        candidates: manifest.entries.filter((e) => e.status === 'candidate').length,
      },
      implicit: {
        params: implicit.params.filter((p) => p.status === 'active').length,
        candidates: implicit.candidates.filter((c) => c.status === 'open').length,
      },
      core: {
        pendingProposals: pending.length,
        versions: {
          persona: this.listCoreVersions('persona').length,
          boundaries: this.listCoreVersions('boundaries').length,
          authorization: this.listCoreVersions('authorization').length,
        },
      },
      shortTermSessions: shortFiles,
      config: this.config,
    }
  }
}
