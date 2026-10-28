import { createDiag, ensureLayout, loadConfig, resolveDataDir } from './config.js'
import { LayeredStore } from './store.js'
import { clip, toDay } from './util.js'

export const name = 'layered-memory'

// 这些服务由 DSH 宿主提供；缺任何一个都说明 profile 不完整。
export const inject = ['agents', 'systemPrompt', 'tools', 'timer']

const TYPE_LABEL = { episodic: '情景', semantic: '语义' }

const HINT = [
  '【分层记忆】',
  '你有四层记忆：核心（只读）、内隐（风格先验）、外显长期（可检索、可陈述）、短期（自动过期）。',
  '值得长期记住的事，用 layered_store 安静地记，不要每次都说「我记住了」；想回忆用 layered_search。',
  '核心人设只能用 layered_core 生成提案，用户明确授权后才能 apply。',
].join('\n')

function agentOf(exec) {
  const candidate = exec && (exec.agent || exec.caller?.agent || exec.agentRef || exec.caller)
  return candidate && typeof candidate === 'object' ? candidate : null
}

function sidOf(session) {
  if (!session) return ''
  for (const key of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
    try {
      const value = session[key]
      if (typeof value === 'string' && value) return value
    } catch {}
  }
  return ''
}

function sidFromExec(exec, fallback = 'global') {
  const agent = agentOf(exec)
  const sid = sidOf(agent?.session) || sidOf(exec?.session)
  if (sid) return sid
  for (const key of ['sessionId', 'session_id']) {
    if (typeof exec?.[key] === 'string' && exec[key]) return exec[key]
  }
  return fallback
}

function isSubagent(agent) {
  try {
    const header = agent?.session?.header
    if (!header) return false
    if (header.origin === 'subagent') return true
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  } catch {}
  return false
}

function textOfMessage(payload) {
  if (!payload) return ''
  if (typeof payload === 'string') return payload.slice(0, 4000)
  if (typeof payload.text === 'string') return payload.text.slice(0, 4000)
  if (typeof payload.content === 'string') return payload.content.slice(0, 4000)
  if (Array.isArray(payload.content)) {
    const parts = []
    for (const block of payload.content) {
      if (typeof block === 'string') parts.push(block)
      else if (block && typeof block.text === 'string') parts.push(block.text)
    }
    if (parts.length) return parts.join(' ').slice(0, 4000)
  }
  return ''
}

function lastUserTextOf(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return ''
    const events = session.snapshotEvents() || []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (!event || (event.type !== 'user/message' && event.kind !== 'user/message')) continue
      const text = textOfMessage(event.payload !== undefined ? event.payload : event.data)
      if (text) return text
    }
  } catch {}
  return ''
}

function lastAssistantTextOf(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return ''
    const events = session.snapshotEvents() || []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (!event || (event.type !== 'assistant/message' && event.kind !== 'assistant/message')) continue
      const payload = event.data?.message !== undefined ? event.data.message : event.payload
      const text = textOfMessage(payload)
      if (text) return text
    }
  } catch {}
  return ''
}

function salienceOf(text) {
  const value = String(text || '')
  if (!value.trim()) return 0
  let salience = 0.3
  if (/(记住|记一下|记下|别忘|不要忘|以后|约定|答应|提醒|重要|我喜欢|我不喜欢|别叫我|叫我|称呼|习惯)/.test(value)) salience = 0.7
  if (/^(记住|记一下|别忘了|以后都|以后叫|以后别)/.test(value.trim())) salience = 0.85
  if (value.length < 6) salience = Math.min(salience, 0.3)
  return salience
}

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
      },
      render(_args, value) {
        const text = value && typeof value.text === 'string' ? value.text : ''
        return [{ type: 'text', text: text || '（没有输出）' }]
      },
    },
    async execute(args, exec) {
      try {
        return await execute(args || {}, exec)
      } catch (error) {
        return { ok: false, text: String(error?.message || error) }
      }
    },
  }
}

function makeTools(store, config, diag) {
  return [
    tool(
      'layered_store',
      '把值得长期保留的事写进分层记忆。explicit=事件/事实（外显长期，可检索、可陈述）；implicit=稳定的偏好/策略/技能倾向（内隐，经过证据累积才生效）。' +
      '只记长期有价值的内容：用户明确说要记住的、约定、重要事件、稳定偏好。日常琐事、寒暄、你自己做过的事不要记。' +
      '记的时候安静地记，不要在回复里汇报「记下了」；一次只记一件事。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          layer: { type: 'string', enum: ['explicit', 'implicit'], description: 'explicit=外显长期；implicit=内隐倾向' },
          content: { type: 'string', description: '要记住的内容。explicit 写清一件事；implicit 写倾向本身' },
          type: { type: 'string', enum: ['episodic', 'semantic'], description: 'explicit 类型：episodic=发生的事；semantic=事实/知识' },
          title: { type: 'string', description: '可选，短标题' },
          summary: { type: 'string', description: '可选，一句话摘要' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选，关键词' },
          significance: { type: 'number', description: '0..1，重要度；约定/关系/核心状态用 0.8 以上' },
          confidence: { type: 'number', description: '0..1，置信度，默认 0.8' },
          factKey: { type: 'string', description: '会变的事实用「对象.方面」，如「用户.称呼」；一次性事件留空' },
          expiresAt: { type: 'string', description: '可选，ISO 过期时间' },
          kind: { type: 'string', enum: ['preference', 'strategy', 'skill'], description: 'implicit 类型' },
          key: { type: 'string', description: 'implicit 的稳定键，如「称呼」「回复长度」' },
          scope: { type: 'string', description: 'implicit 作用域，默认 global' },
          correct: { type: 'boolean', description: '用户明确纠正某个偏好时填 true' },
          note: { type: 'string', description: '可选，证据说明' },
        },
        required: ['layer', 'content'],
      },
      async (args, exec) => {
        if (args.layer === 'implicit') {
          if (!args.key) return { ok: false, text: 'implicit 记忆需要 key（例如「称呼」「回复长度」）' }
          const result = store.observeImplicit({
            kind: args.kind,
            key: args.key,
            value: args.content,
            scope: args.scope,
            correct: args.correct === true,
            note: args.note,
            actor: 'model',
          })
          return {
            ok: true,
            text: `内隐${args.correct ? '纠正' : '观察'}已记录：${result.key} = ${result.value}（候选证据 ${result.evidence?.length || 1} 条）`,
          }
        }
        const agent = agentOf(exec)
        if (isSubagent(agent)) return { ok: false, text: '子代理不写长期记忆；请把结果交回主会话再记。' }
        const sid = sidFromExec(exec, '')
        const result = store.storeExplicit({
          content: args.content,
          type: args.type,
          title: args.title,
          summary: args.summary,
          tags: args.tags,
          significance: args.significance,
          confidence: args.confidence,
          factKey: args.factKey,
          expiresAt: args.expiresAt,
          source: sid ? `session:${sid}` : 'tool',
        })
        const entry = result.entry
        const lines = [
          `${result.deduped ? '已存在，已合并' : '已写入'}：${entry.id}`,
          `状态：${entry.status}；类型：${TYPE_LABEL[entry.type] || entry.type}；重要度：${entry.significance}`,
        ]
        if (result.superseded) lines.push(`已取代旧记忆：${result.superseded.id}（旧条目保留，可审计）`)
        return { ok: true, text: lines.join('\n') }
      },
    ),

    tool(
      'layered_search',
      '检索外显长期记忆。按相关度+新近+重要度排序，返回记忆摘要；需要正文时用返回的 id 再查，或直接阅读 entries 目录。' +
      '不要在没查到的时候编造记忆。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '检索词；留空则返回最近/最重要的记忆' },
          limit: { type: 'number', description: '最多返回几条，默认 5' },
          include_candidates: { type: 'boolean', description: '是否包含尚未晋升的候选记忆' },
        },
        required: ['query'],
      },
      async (args, exec) => {
        let query = String(args.query || '').trim()
        const agent = agentOf(exec)
        if (!query) query = lastUserTextOf(agent?.session)
        if (!query) return { ok: true, text: '没有查询词。' }
        const result = store.searchExplicit(query, {
          limit: args.limit,
          includeCandidates: args.include_candidates === true,
          touch: true,
        })
        if (!result.results.length) return { ok: true, text: '没有找到相关记忆。' }
        const lines = [`找到 ${result.results.length} 条：`]
        for (const item of result.results) {
          const date = toDay(item.createdAt) || '未知时间'
          const label = TYPE_LABEL[item.type] || item.type
          const always = item.always ? '常驻｜' : ''
          lines.push(`- [${item.id}] ${date}｜${label}｜${always}重要度 ${item.significance}：${item.snippet}`)
        }
        lines.push('（以上是真实记录；没有出现的内容不要编。）')
        return { ok: true, text: lines.join('\n') }
      },
    ),

    tool(
      'layered_forget',
      '删除一条外显长期记忆。默认移入回收站并保留 30 天；hard=true 立即彻底删除。用户明确说「忘掉」时才用。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '记忆 id，如 mem_xxx' },
          hard: { type: 'boolean', description: '是否彻底删除，默认 false（进回收站）' },
        },
        required: ['id'],
      },
      async (args, exec) => {
        const id = String(args.id || '')
        const entry = store.findEntry(id)
        const content = entry ? store.entryContent(entry) : ''
        const sid = sidFromExec(exec, '')
        let cleared = 0
        if (sid && content) cleared = store.clearShortMatching(sid, content)
        const result = store.forgetExplicit(id, { hard: args.hard === true, actor: 'user' })
        return {
          ok: true,
          text: result.already
            ? `记忆 ${args.id} 已经是删除状态。`
            : `已${args.hard ? '彻底删除' : '移入回收站'}：${args.id}${cleared ? `；同时清掉 ${cleared} 条短期缓冲` : ''}`,
        }
      },
    ),

    tool(
      'layered_core',
      '核心层变更门控。核心人设默认只读：propose 只生成 diff 提案；apply 需要用户明确授权，并且 confirm 必须恰好是 "APPLY"；rollback 用于回滚。' +
      '不要自行 apply，也不要把普通事实/偏好写进核心层。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'propose', 'apply', 'rollback'], description: '操作' },
          file: { type: 'string', enum: ['persona', 'boundaries', 'authorization'], description: '核心文件' },
          content: { type: 'string', description: 'propose 时的新正文' },
          reason: { type: 'string', description: '变更原因' },
          proposal_id: { type: 'string', description: 'apply 时的提案 id' },
          version_id: { type: 'string', description: 'rollback 时的版本文件名，默认最新' },
          confirm: { type: 'string', description: 'apply/rollback 时必须为 APPLY' },
        },
        required: ['action'],
      },
      async (args) => {
        if (args.action === 'list') {
          const pending = store.pendingCoreProposals()
          if (!pending.length) return { ok: true, text: '没有待批准的核心变更提案。' }
          return {
            ok: true,
            text: pending.map((p) => `- ${p.id}｜${p.file}｜${p.createdAt}｜${p.reason || '无原因'}`).join('\n'),
          }
        }
        if (args.action === 'propose') {
          if (!args.file) return { ok: false, text: 'propose 需要 file' }
          const proposal = store.proposeCore({
            file: args.file,
            content: args.content,
            reason: args.reason,
            actor: 'model',
          })
          return {
            ok: true,
            text: [
              `提案已生成：${proposal.id}（${proposal.file}）`,
              '下面是给用户看的 diff（+ 新增，- 删除）：',
              '```diff',
              clip(proposal.diff, 3000),
              '```',
              '请把 diff 展示给用户并等待明确授权；用户确认后再调用 action=apply、confirm="APPLY"。',
            ].join('\n'),
          }
        }
        if (args.action === 'apply') {
          const result = store.applyCore({
            proposalId: args.proposal_id,
            confirm: args.confirm,
            actor: 'model',
          })
          return {
            ok: true,
            text: `核心层已更新：${result.proposal.file}（提案 ${result.proposal.id}，备份 ${result.versionId}）`,
          }
        }
        if (args.action === 'rollback') {
          if (!args.file) return { ok: false, text: 'rollback 需要 file' }
          const result = store.rollbackCore({
            file: args.file,
            versionId: args.version_id,
            confirm: args.confirm,
            actor: 'model',
          })
          return { ok: true, text: `已回滚 ${result.file} 到 ${result.versionId}（回滚前备份：${result.safety}）` }
        }
        return { ok: false, text: `未知 action：${args.action}` }
      },
    ),

    tool(
      'layered_status',
      '查看分层记忆的状态：各层条数、待批准的核心提案、数据目录与当前配置。排查「为什么没记住/没想起来」时先看它。',
      { type: 'object', additionalProperties: false, properties: {} },
      async () => {
        const status = store.status()
        return { ok: true, text: clip(JSON.stringify(status, null, 2), 5000) }
      },
    ),
  ]
}

function formatRecall(shortText, results, maxChars) {
  const parts = []
  if (shortText) parts.push(shortText)
  if (results.length) {
    parts.push('【长期记忆 · 召回】')
    parts.push('下面是从长期记忆里按当前话题挑出来的真实记录；需要细节时用 layered_search 查原文。')
    for (const item of results) {
      const date = toDay(item.createdAt) || '未知时间'
      const label = TYPE_LABEL[item.type] || item.type
      const always = item.always ? '常驻｜' : ''
      parts.push(`- [${item.id}] ${date}｜${label}｜${always}重要度 ${item.significance}：${item.snippet}`)
    }
  }
  if (!parts.length) return ''
  parts.push('（没有出现在这里的记忆不要编；想不起来就说想不起来。）')
  return clip(parts.join('\n'), maxChars)
}

export function apply(ctx) {
  const dir = resolveDataDir()
  ensureLayout(dir)
  const diag = createDiag(dir)
  const config = loadConfig(dir)
  if (!config.enabled) {
    diag('插件在 config.json 里 enabled=false，跳过装配')
    return
  }
  const store = new LayeredStore(dir, config, { diag })
  diag(`apply：${dir}`)

  // 工具是全局的；会话级 section/context 由 tick 挂到每个 agent 上。
  const toolDisposers = []
  for (const definition of makeTools(store, config, diag)) {
    try {
      const off = ctx.tools.register(definition)
      toolDisposers.push(typeof off === 'function' ? off : () => {})
      diag(`工具挂上：${definition.name}`)
    } catch (error) {
      diag(`工具 ${definition.name} 注册失败：${error.message}`)
    }
  }

  const mounted = new Map()

  function mount(agent, sid) {
    const offs = []
    const keep = (off) => {
      if (typeof off === 'function') offs.push(off)
    }
    const safeKeep = (label, fn) => {
      try { keep(fn()) } catch (error) { diag(`${label} 注册失败：${error.message}`) }
    }

    safeKeep('核心层 section', () => agent.ctx.systemPrompt.section({
      name: 'layered-memory-core',
      order: 10300,
      interpolate: false,
      text: () => {
        try { return store.renderCore(config.prompt.coreMaxChars) } catch (error) {
          diag(`核心层注入失败：${error.message}`)
          return ''
        }
      },
    }))

    safeKeep('内隐层 section', () => agent.ctx.systemPrompt.section({
      name: 'layered-memory-implicit',
      order: 10310,
      interpolate: false,
      text: () => {
        try { return store.renderImplicit(config.prompt.implicitMaxChars, config.implicit.maxItems) } catch (error) {
          diag(`内隐层注入失败：${error.message}`)
          return ''
        }
      },
    }))

    if (config.prompt.hint) {
      safeKeep('记忆提示 section', () => agent.ctx.systemPrompt.section({
        name: 'layered-memory-hint',
        order: 10320,
        interpolate: false,
        text: HINT,
      }))
    }

    let lastUserText = ''
    safeKeep('收消息监听', () => agent.ctx.on('agent/inbox/inserted', (payload) => {
      try {
        const message = payload && payload.message ? payload.message : payload
        const text = textOfMessage(message)
        if (!text) return
        lastUserText = text
        store.appendShort(sid, { role: 'user', text, salience: salienceOf(text) })
        diag(`收到本会话消息：${text.length} 字`)
      } catch (error) {
        diag(`收消息失败：${error.message}`)
      }
    }))

    safeKeep('回合结束监听', () => agent.ctx.on('agent/turn-stopping', () => {
      try {
        const reply = lastAssistantTextOf(agent.session)
        if (reply) store.appendShort(sid, { role: 'assistant', text: reply, salience: 0.2 })
      } catch (error) {
        diag(`回合结束写短期失败：${error.message}`)
      }
    }))

    safeKeep('召回 context', () => agent.ctx.systemPrompt.context({
      name: 'layered-memory-recall',
      order: 950,
      interpolate: false,
      text: () => {
        try {
          const query = lastUserText || lastUserTextOf(agent.session)
          const shortText = store.renderShort(sid, config.prompt.shortTermMaxItems)
          const result = query
            ? store.searchExplicit(query, { limit: config.recall.topK })
            : { results: [] }
          return formatRecall(shortText, result.results, config.prompt.recallMaxChars)
        } catch (error) {
          diag(`召回注入失败：${error.message}`)
          return ''
        }
      },
    }))

    return function off() {
      for (const fn of offs.reverse()) {
        try { fn() } catch {}
      }
    }
  }

  function tick() {
    try {
      const list = ctx.agents?.list?.() || []
      const live = new Set()
      for (const agent of list) {
        const sid = sidOf(agent?.session)
        if (!sid) continue
        live.add(sid)
        if (isSubagent(agent)) {
          const current = mounted.get(sid)
          if (current) {
            try { current.off() } catch {}
            mounted.delete(sid)
          }
          continue
        }
        const current = mounted.get(sid)
        if (current && current.agent === agent) continue
        if (current) {
          try { current.off() } catch {}
          mounted.delete(sid)
        }
        try {
          const off = mount(agent, sid)
          mounted.set(sid, { agent, off })
          diag(`挂上会话 ${sid}`)
        } catch (error) {
          diag(`挂会话 ${sid} 失败：${error.message}`)
        }
      }
      for (const [sid, value] of mounted) {
        if (live.has(sid)) continue
        try { value.off() } catch {}
        mounted.delete(sid)
        diag(`卸下会话 ${sid}`)
      }
    } catch (error) {
      diag(`tick 失败：${error.message}`)
    }
  }

  tick()
  try {
    ctx.effect(() => ctx.interval(tick, 1000))
  } catch (error) {
    diag(`挂载定时器失败：${error.message}`)
  }
  try {
    ctx.effect(() => ctx.interval(() => {
      try {
        const implicit = store.reflectImplicit()
        const promoted = store.promoteCandidates()
        const archived = store.archiveStale()
        if (implicit || promoted || archived) diag(`维护：内隐 ${implicit}，晋升 ${promoted}，归档/清理 ${archived}`)
      } catch (error) {
        diag(`维护任务失败：${error.message}`)
      }
    }, 10 * 60 * 1000))
  } catch (error) {
    diag(`挂维护定时器失败：${error.message}`)
  }

  ctx.effect(() => () => {
    for (const value of mounted.values()) {
      try { value.off() } catch {}
    }
    mounted.clear()
    for (const off of toolDisposers) {
      try { off() } catch {}
    }
    diag('插件已卸载')
  })
}
