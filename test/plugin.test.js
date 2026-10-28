import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, name } from '../lib/index.js'

function makeHarness() {
  const sections = []
  const contexts = []
  const tools = new Map()
  const handlers = new Map()
  const disposers = []
  const events = []
  const agent = {
    session: {
      id: 'session-test',
      header: {},
      snapshotEvents: () => events,
    },
    ctx: {},
  }
  agent.ctx = {
    systemPrompt: {
      section(section) { sections.push(section); return () => {} },
      context(context) { contexts.push(context); return () => {} },
    },
    on(event, handler) { handlers.set(event, handler); return () => {} },
  }
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    agents: { list: () => [agent] },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    interval() { return () => {} },
    on() { return () => {} },
  }
  return { ctx, agent, sections, contexts, tools, handlers, disposers, events }
}

test('插件装配：5 个工具 + 每会话 section/context', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layered-memory-plugin-'))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ core: { applyCooldownSeconds: 0 } }), 'utf8')
  const oldHome = process.env.LAYERED_MEMORY_HOME
  process.env.LAYERED_MEMORY_HOME = dir
  try {
    assert.equal(name, 'layered-memory')
    const h = makeHarness()
    apply(h.ctx)

    assert.equal(h.tools.size, 5)
    for (const toolName of ['layered_store', 'layered_search', 'layered_forget', 'layered_core', 'layered_status']) {
      assert.ok(h.tools.has(toolName), `缺少工具 ${toolName}`)
    }
    assert.deepEqual(h.sections.map((s) => s.name), [
      'layered-memory-core',
      'layered-memory-implicit',
      'layered-memory-hint',
    ])
    assert.ok(h.contexts.some((c) => c.name === 'layered-memory-recall'))

    const core = h.sections.find((s) => s.name === 'layered-memory-core').text()
    assert.match(core, /核心层/)
    assert.match(core, /不可违背/)

    const exec = { agent: h.agent }
    const stored = await h.tools.get('layered_store').execute({
      layer: 'explicit',
      content: '用户喜欢喝乌龙茶，不加糖。',
      type: 'semantic',
      significance: 0.8,
    }, exec)
    assert.equal(stored.ok, true)
    assert.match(stored.text, /已写入/)

    const found = await h.tools.get('layered_search').execute({ query: '乌龙茶' }, exec)
    assert.equal(found.ok, true)
    assert.match(found.text, /乌龙茶/)

    h.handlers.get('agent/inbox/inserted')({ message: { content: [{ type: 'text', text: '记住：下周三去南昌。' }] } })
    const recall = h.contexts.find((c) => c.name === 'layered-memory-recall').text()
    assert.match(recall, /短期工作记忆/)
    assert.match(recall, /下周三去南昌/)

    h.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好，我记着了。' }] } } })
    h.handlers.get('agent/turn-stopping')()

    const status = await h.tools.get('layered_status').execute({}, exec)
    assert.equal(status.ok, true)
    assert.match(status.text, /"explicit"/)
    assert.match(status.text, /"shortTermSessions": 1/)

    fs.rmSync(dir, { recursive: true, force: true })
  } finally {
    if (oldHome === undefined) delete process.env.LAYERED_MEMORY_HOME
    else process.env.LAYERED_MEMORY_HOME = oldHome
  }
})

test('核心工具：propose + APPLY 门控', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layered-memory-core-'))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ core: { applyCooldownSeconds: 0 } }), 'utf8')
  const oldHome = process.env.LAYERED_MEMORY_HOME
  process.env.LAYERED_MEMORY_HOME = dir
  try {
    const h = makeHarness()
    apply(h.ctx)
    const exec = { agent: h.agent }
    const core = h.tools.get('layered_core')

    const proposed = await core.execute({
      action: 'propose',
      file: 'persona',
      content: '# 核心\n\n她叫微，说话简短。',
      reason: '测试',
    }, exec)
    assert.equal(proposed.ok, true)
    const id = proposed.text.match(/提案已生成：(corep_[a-z0-9_]+)/)?.[1]
    assert.ok(id)

    const bad = await core.execute({ action: 'apply', proposal_id: id, confirm: 'ok' }, exec)
    assert.equal(bad.ok, false)
    assert.match(bad.text, /APPLY/)

    const applied = await core.execute({ action: 'apply', proposal_id: id, confirm: 'APPLY' }, exec)
    assert.equal(applied.ok, true)
    assert.match(applied.text, /核心层已更新/)
    assert.match(h.sections.find((s) => s.name === 'layered-memory-core').text(), /她叫微/)

    fs.rmSync(dir, { recursive: true, force: true })
  } finally {
    if (oldHome === undefined) delete process.env.LAYERED_MEMORY_HOME
    else process.env.LAYERED_MEMORY_HOME = oldHome
  }
})
