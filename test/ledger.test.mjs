// LectureForge — 账本状态机与路径围栏测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { applyClaims, normalizeClaims, markReviewed, ledgerCounts, validateLedger, BLOCK_KINDS } from '../lib/ledger.mjs'
import { assertInside, resolveInputPath } from '../lib/paths.mjs'

function blockIndex(ids) {
  const map = new Map()
  for (const id of ids) map.set(id, { source: { sourceId: id.split('#')[0], blocks: [] }, block: { id, page: 1 } })
  return map
}

function emptyLedger() {
  return { schemaVersion: 1, sections: [], blocks: {}, updatedAt: null }
}

test('claim：covered 写入章节与 kinds', () => {
  const ledger = emptyLedger()
  const claims = normalizeClaims([{ blockId: 'S01#p001-b01', status: 'covered', sections: ['sec-1'], kinds: ['exposition'] }])
  const result = applyClaims(ledger, claims, { blockIndex: blockIndex(['S01#p001-b01']), sectionIds: new Set(['sec-1']) })
  assert.equal(result.errors.length, 0)
  assert.equal(result.applied.length, 1)
  assert.equal(ledger.blocks['S01#p001-b01'].status, 'covered')
  assert.deepEqual(ledger.blocks['S01#p001-b01'].sections, ['sec-1'])
})

test('claim：未知块、未知章节、未知 kind、缺 kind 都会拒绝', () => {
  const ledger = emptyLedger()
  const cases = [
    [{ blockId: 'S02#p001-b01', sections: ['sec-1'], kinds: ['exposition'] }, 'UNKNOWN_BLOCK'],
    [{ blockId: 'S01#p001-b01', sections: ['sec-x'], kinds: ['exposition'] }, 'UNKNOWN_SECTION'],
    [{ blockId: 'S01#p001-b01', sections: ['sec-1'], kinds: ['magic'] }, 'UNKNOWN_KIND'],
    [{ blockId: 'S01#p001-b01', sections: ['sec-1'], kinds: [] }, 'MISSING_KINDS'],
    [{ blockId: 'S01#p001-b01', sections: [], kinds: ['exposition'] }, 'MISSING_SECTION'],
  ]
  for (const [raw, code] of cases) {
    const result = applyClaims(ledger, normalizeClaims([raw]), { blockIndex: blockIndex(['S01#p001-b01']), sectionIds: new Set(['sec-1']) })
    assert.equal(result.errors[0].code, code, JSON.stringify(raw))
    assert.equal(result.applied.length, 0)
  }
})

test('claim：merged 只能指向已 covered 的块并继承章节', () => {
  const ledger = emptyLedger()
  const index = blockIndex(['S01#p001-b01', 'S01#p001-b02'])
  const base = applyClaims(
    ledger,
    normalizeClaims([{ blockId: 'S01#p001-b01', sections: ['sec-1'], kinds: ['exposition'] }]),
    { blockIndex: index, sectionIds: new Set(['sec-1']) },
  )
  assert.equal(base.errors.length, 0)

  const merged = applyClaims(
    ledger,
    normalizeClaims([{ blockId: 'S01#p001-b02', status: 'merged', mergeInto: 'S01#p001-b01', kinds: ['exposition'] }]),
    { blockIndex: index, sectionIds: new Set(['sec-1']) },
  )
  assert.equal(merged.errors.length, 0)
  assert.equal(ledger.blocks['S01#p001-b02'].status, 'merged')
  assert.deepEqual(ledger.blocks['S01#p001-b02'].sections, ['sec-1'])

  const self = applyClaims(
    ledger,
    normalizeClaims([{ blockId: 'S01#p001-b02', status: 'merged', mergeInto: 'S01#p001-b02', kinds: ['exposition'] }]),
    { blockIndex: index, sectionIds: new Set(['sec-1']) },
  )
  assert.equal(self.errors[0].code, 'SELF_MERGE')
})

test('claim：blocked 必须写 reason', () => {
  const ledger = emptyLedger()
  const index = blockIndex(['S01#p001-b01'])
  const bad = applyClaims(ledger, normalizeClaims([{ blockId: 'S01#p001-b01', status: 'blocked', kinds: ['exposition'] }]), {
    blockIndex: index,
    sectionIds: new Set(['sec-1']),
  })
  assert.equal(bad.errors[0].code, 'MISSING_REASON')
  const good = applyClaims(
    ledger,
    normalizeClaims([{ blockId: 'S01#p001-b01', status: 'blocked', kinds: ['exposition'], reason: '扫描页无法辨认' }]),
    { blockIndex: index, sectionIds: new Set(['sec-1']) },
  )
  assert.equal(good.errors.length, 0)
  assert.equal(ledger.blocks['S01#p001-b01'].status, 'blocked')
})

test('reviewed 标记与计数、账本自检', () => {
  const ledger = emptyLedger()
  const index = blockIndex(['S01#p001-b01'])
  applyClaims(ledger, normalizeClaims([{ blockId: 'S01#p001-b01', sections: ['sec-1'], kinds: ['exposition'] }]), {
    blockIndex: index,
    sectionIds: new Set(['sec-1']),
  })
  const marked = markReviewed(ledger, ['S01#p001-b01'])
  assert.deepEqual(marked.reviewed, ['S01#p001-b01'])
  assert.equal(marked.errors.length, 0)
  assert.equal(ledger.blocks['S01#p001-b01'].reviewed, true)
  const counts = ledgerCounts(ledger)
  assert.equal(counts.covered, 1)
  assert.equal(counts.reviewed, 1)
  assert.equal(validateLedger(ledger).length, 0)
  assert.ok(BLOCK_KINDS.includes('derivation'))
})

test('路径围栏：工作区外输入被拒绝，工作区内正常', () => {
  const cwd = process.cwd()
  const inside = resolveInputPath(cwd, path.join(cwd, 'test', 'fixtures', 'sample-2page.pdf'))
  assert.ok(path.isAbsolute(inside))
  const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'
  assert.throws(() => resolveInputPath(cwd, outside), /PATH_OUTSIDE_WORKSPACE|路径/)
  assert.equal(assertInside(cwd, outside), false)
  assert.doesNotThrow(() => assertInside(cwd, path.join(cwd, 'lib')))
})
