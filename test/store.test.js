import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadConfig } from '../lib/config.js'
import { LayeredStore } from '../lib/store.js'

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layered-memory-test-'))
  const config = loadConfig(dir)
  config.core.applyCooldownSeconds = 0
  config.core.applyEnabled = true
  return { dir, config, store: new LayeredStore(dir, config) }
}

test('外显记忆：写入、检索、去重、事实键取代', () => {
  const { dir, store } = tempStore()
  const first = store.storeExplicit({
    content: '用户喜欢喝乌龙茶，不加糖。',
    type: 'semantic',
    tags: ['茶', '饮食'],
    significance: 0.8,
  })
  assert.equal(first.entry.status, 'active')
  assert.ok(first.entry.id.startsWith('mem_'))

  const found = store.searchExplicit('乌龙茶')
  assert.equal(found.results.length, 1)
  assert.equal(found.results[0].id, first.entry.id)

  const singleChar = store.searchExplicit('茶')
  assert.ok(singleChar.results.some((r) => r.id === first.entry.id), '单字查询也应命中')

  const unrelated = store.searchExplicit('量子力学')
  assert.equal(unrelated.results.filter((r) => !r.always).length, 0)
  assert.ok(unrelated.results.some((r) => r.always), '高重要度语义记忆应作为常驻事实出现')

  const dup = store.storeExplicit({ content: '用户喜欢喝乌龙茶，不加糖。', significance: 0.9 })
  assert.equal(dup.deduped, true)
  assert.equal(store.loadManifest().entries.length, 1)

  const old = store.storeExplicit({
    content: '用户现在叫阿灵。',
    type: 'semantic',
    factKey: '用户.称呼',
    significance: 0.8,
  })
  const fresh = store.storeExplicit({
    content: '用户现在叫殷灵。',
    type: 'semantic',
    factKey: '用户.称呼',
    significance: 0.9,
  })
  assert.equal(fresh.superseded.id, old.entry.id)
  const oldEntry = store.findEntry(old.entry.id)
  assert.equal(oldEntry.status, 'superseded')
  assert.equal(oldEntry.supersededBy, fresh.entry.id)

  assert.throws(() => store.storeExplicit({
    content: '泛化键测试',
    factKey: '用户.内容',
  }), /过于笼统/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('外显记忆：回收站与彻底删除', () => {
  const { dir, store } = tempStore()
  const entry = store.storeExplicit({ content: '明天下午三点开会。', type: 'episodic', significance: 0.7 }).entry
  const trashed = store.forgetExplicit(entry.id, { hard: false })
  assert.equal(trashed.entry.status, 'deleted')
  assert.ok(fs.existsSync(path.join(dir, 'explicit', 'trash', `${entry.id}.md`)))
  assert.equal(store.searchExplicit('开会').results.filter((r) => !r.always).length, 0)

  const second = store.storeExplicit({ content: '周末去爬山。', type: 'episodic', significance: 0.6 }).entry
  store.forgetExplicit(second.id, { hard: true })
  assert.equal(store.findEntry(second.id), null)
  assert.ok(!fs.existsSync(path.join(dir, 'explicit', 'entries', `${second.id}.md`)))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('内隐记忆：证据累积、反射晋升、用户纠正', () => {
  const { dir, config, store } = tempStore()
  config.implicit.minEvidence = 2
  config.implicit.minDays = 2
  config.implicit.dailyUpdates = 3
  for (let i = 0; i < 2; i++) {
    store.observeImplicit({ kind: 'preference', key: '称呼', value: '叫我殷灵' })
  }
  const data = store.loadImplicit()
  const candidate = data.candidates[0]
  candidate.evidence[0].at = new Date(Date.now() - 3 * 86400000).toISOString()
  candidate.evidence[1].at = new Date(Date.now() - 1 * 86400000).toISOString()
  store.saveImplicit(data)

  const updated = store.reflectImplicit()
  assert.equal(updated, 1)
  const param = store.loadImplicit().params.find((p) => p.key === '称呼')
  assert.ok(param)
  assert.equal(param.status, 'active')
  assert.ok(param.confidence >= 0.55)

  const corrected = store.observeImplicit({
    kind: 'preference',
    key: '称呼',
    value: '叫我阿灵',
    correct: true,
  })
  assert.equal(corrected.value, '叫我阿灵')
  assert.ok(corrected.confidence >= 0.6)
  const old = store.loadImplicit().params.find((p) => p.key === '称呼' && p.value === '叫我殷灵')
  assert.equal(old.status, 'weakened')

  const rendered = store.renderImplicit()
  assert.match(rendered, /内隐记忆/)
  assert.match(rendered, /叫我阿灵/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('核心层：提案、冷却、APPLY 门控、回滚', () => {
  const { dir, store } = tempStore()
  const proposal = store.proposeCore({
    file: 'persona',
    content: '# 核心\n\n她叫微。',
    reason: '用户要求补充名字',
  })
  assert.equal(proposal.status, 'pending')
  assert.match(proposal.diff, /\+她叫微/)

  assert.throws(() => store.applyCore({ proposalId: proposal.id, confirm: 'yes' }), /APPLY/)
  const applied = store.applyCore({ proposalId: proposal.id, confirm: 'APPLY' })
  assert.equal(applied.proposal.status, 'applied')
  assert.match(store.renderCore(), /她叫微/)
  assert.ok(fs.existsSync(path.join(dir, 'core', 'versions', applied.versionId)))

  const rolled = store.rollbackCore({ file: 'persona', confirm: 'APPLY' })
  assert.ok(rolled.versionId)
  assert.doesNotMatch(store.renderCore(), /她叫微/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('核心层：冷却期内拒绝 apply', () => {
  const { dir, config, store } = tempStore()
  config.core.applyCooldownSeconds = 60
  const proposal = store.proposeCore({ file: 'boundaries', content: '# 新边界\n- 不熬夜。' })
  assert.throws(() => store.applyCore({ proposalId: proposal.id, confirm: 'APPLY' }), /冷却/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('短期记忆：TTL、显著片段、候选晋升', () => {
  const { dir, config, store } = tempStore()
  config.shortTerm.autoCandidate = true
  config.shortTerm.candidateMinSalience = 0.6
  store.appendShort('session-a', { role: 'user', text: '记住：下周三去南昌。', salience: 0.85 })
  const rendered = store.renderShort('session-a')
  assert.match(rendered, /下周三去南昌/)
  const candidates = store.loadManifest().entries.filter((e) => e.status === 'candidate')
  assert.equal(candidates.length, 1)

  const promoted = store.storeExplicit({
    content: '记住：下周三去南昌。',
    type: 'episodic',
    significance: 0.8,
  })
  assert.equal(promoted.deduped, true)
  assert.equal(promoted.entry.status, 'active')
  assert.equal(store.loadManifest().entries.filter((e) => e.status === 'candidate').length, 0)

  const data = store.loadShort('session-a')
  data.items[0].expiresAt = new Date(Date.now() - 1000).toISOString()
  store.saveShort('session-a', data)
  assert.equal(store.renderShort('session-a'), '')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('遗忘传播：短期缓冲同步清理', () => {
  const { dir, store } = tempStore()
  store.appendShort('session-f', { role: 'user', text: '记住：下周三去南昌。', salience: 0.85 })
  const entry = store.storeExplicit({ content: '记住：下周三去南昌。', type: 'episodic', significance: 0.8 }).entry
  assert.match(store.renderShort('session-f'), /下周三去南昌/)
  const cleared = store.clearShortMatching('session-f', store.entryContent(entry))
  assert.equal(cleared, 1)
  assert.equal(store.renderShort('session-f'), '')
  store.forgetExplicit(entry.id, { hard: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('状态汇总', () => {
  const { dir, store } = tempStore()
  store.storeExplicit({ content: '一条长期事实：用户在南昌。', type: 'semantic', significance: 0.8 })
  store.observeImplicit({ kind: 'preference', key: '回复长度', value: '简洁' })
  store.appendShort('s1', { role: 'user', text: '随便聊聊。', salience: 0.3 })
  const status = store.status()
  assert.equal(status.explicit.total, 1)
  assert.equal(status.implicit.candidates, 1)
  assert.equal(status.shortTermSessions, 1)
  assert.ok(status.dir.includes('layered-memory-test-'))
  fs.rmSync(dir, { recursive: true, force: true })
})
