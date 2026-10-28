import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDir, readJson, readText, writeJson, writeTextAtomic } from './util.js'

export const DEFAULT_CONFIG = {
  enabled: true,
  prompt: {
    coreMaxChars: 6000,
    implicitMaxChars: 900,
    hint: true,
    recallMaxChars: 900,
    shortTermDigest: true,
    shortTermMaxItems: 3,
  },
  recall: {
    topK: 5,
    minScore: 0.28,
    alwaysFacts: 2,
    halfLifeDays: 30,
  },
  shortTerm: {
    ttlMinutes: 30,
    maxItems: 40,
    autoCandidate: true,
    candidateMinSalience: 0.65,
    maxCandidates: 200,
  },
  implicit: {
    minEvidence: 3,
    minDays: 2,
    dailyUpdates: 3,
    maxStep: 0.05,
    minConfidence: 0.55,
    maxItems: 12,
  },
  explicit: {
    candidateBelow: 0.5,
    archiveAfterDays: 120,
    archiveBelow: 0.35,
    trashDays: 30,
  },
  core: {
    applyEnabled: true,
    applyCooldownSeconds: 30,
    proposalTtlHours: 24,
  },
}

const CORE_FILES = ['persona', 'boundaries', 'authorization']

const CORE_TEMPLATES = {
  persona: `# 核心层 · 人设（只读）

> 这是分层记忆的核心层。插件默认只读；修改必须通过 layered_core 生成提案，
> 并在用户明确授权后执行 apply。把「她是谁」写在这里：名字、身份、说话方式、
> 关系定位、不可违背的承诺。事实、偏好、事件不要写进核心层。

（待填写）
`,
  boundaries: `# 核心层 · 安全边界（只读）

- 不冒充用户本人做对外操作。
- 不把用户的隐私信息发给第三方。
- 不确定的事实不要编；想不起来就说想不起来。
- 与用户的明确指令冲突时，先确认，不自行扩大授权。

（按需补充）
`,
  authorization: `# 核心层 · 授权规则（只读）

- 核心层变更必须由用户明确提出；模型不得自行决定。
- 涉及对外发送、删除记忆、修改人设的操作，先向用户确认。
- 用户说「忘掉」时，删除对应外显记忆，并同步清理索引、缓存和摘要引用。
- 内隐记忆只能改变「怎么表达、怎么偏好」，不能改变「她是谁」和安全边界。

（按需补充）
`,
}

export function resolveDataDir() {
  if (process.env.LAYERED_MEMORY_HOME) return path.resolve(process.env.LAYERED_MEMORY_HOME)
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'layered-memory')
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function mergeDefaults(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  if (!isPlainObject(extra)) return out
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue
    if (isPlainObject(out[k]) && isPlainObject(v)) out[k] = mergeDefaults(out[k], v)
    else out[k] = v
  }
  return out
}

export function loadConfig(dir) {
  const file = path.join(dir, 'config.json')
  const raw = readJson(file, null)
  if (!raw || !isPlainObject(raw)) {
    writeJson(file, DEFAULT_CONFIG)
    return structuredClone(DEFAULT_CONFIG)
  }
  const merged = mergeDefaults(DEFAULT_CONFIG, raw)
  // 把新增的默认字段写回去，方便用户直接看到所有可调项
  try { writeJson(file, merged) } catch {}
  return merged
}

export function ensureLayout(dir) {
  ensureDir(dir)
  for (const sub of ['core', 'core/versions', 'core/proposals', 'explicit/entries', 'explicit/archive', 'explicit/trash', 'implicit', 'short-term', 'state']) {
    ensureDir(path.join(dir, sub))
  }
  for (const name of CORE_FILES) {
    const file = path.join(dir, 'core', `${name}.md`)
    if (!fs.existsSync(file)) writeTextAtomic(file, CORE_TEMPLATES[name])
  }
  return dir
}

export function coreFiles() {
  return [...CORE_FILES]
}

export function createDiag(dir) {
  const file = path.join(dir, 'diag.log')
  return (message) => {
    try {
      ensureDir(dir)
      try {
        const st = fs.statSync(file)
        if (st.size > 1024 * 1024) fs.renameSync(file, `${file}.1`)
      } catch {}
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${String(message)}\n`, 'utf8')
    } catch {}
  }
}

export function readCoreText(dir) {
  const out = {}
  for (const name of CORE_FILES) out[name] = readText(path.join(dir, 'core', `${name}.md`), '')
  return out
}
