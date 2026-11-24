// LectureForge — 确定性审计测试（正例 + 各类负例）。
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { analyzeMarkdown, renderMarkdown } from '../lib/render/markdown.mjs'
import { runAudit } from '../lib/audit.mjs'
import { resolveConfig } from '../lib/config.mjs'

const BLOCK_ID = 'S01#p001-b01'

function source(extra = {}) {
  return {
    sourceId: 'S01',
    label: '样例',
    kind: 'pdf',
    structure: { pages: 1 },
    blocks: [
      {
        id: BLOCK_ID,
        page: 1,
        section: null,
        kind: 'text',
        text: '正文内容',
        chars: 4,
        confidence: 'high',
        needsVision: false,
        provenance: 'textlayer',
        imageAssetId: null,
      },
    ],
    lowTextPages: [],
    figures: [],
    warnings: [],
    ...extra,
  }
}

function makeCase({ mdText, ledgerBlocks, sources = [source()], figuresData = { schemaVersion: 1, assets: [] }, mathErrors = [] } = {}) {
  const md = mdText ?? '# 讲义\n\n## 1. 引言 {#sec-1}\n\n正文 [S01, p.1]。\n'
  const rendered = renderMarkdown(md)
  const blocks = ledgerBlocks ?? {
    [BLOCK_ID]: { status: 'covered', sections: ['sec-1'], kinds: ['exposition'], reviewed: false },
  }
  const blockIndex = new Map()
  for (const item of sources) {
    for (const block of item.blocks) blockIndex.set(block.id, { source: item, block })
  }
  return {
    project: { formats: ['pdf'] },
    sources,
    ledger: { schemaVersion: 1, sections: [], blocks },
    mdText: md,
    analysis: rendered.analysis,
    mathErrors: mathErrors.length ? mathErrors : rendered.mathErrors,
    figuresData,
    config: resolveConfig({}),
    projectDir: path.join(os.tmpdir(), 'lf-audit-test'),
    blockIndex,
    formats: ['pdf'],
  }
}

const codes = (result) => result.errors.map((error) => error.code)

test('审计：完整覆盖的讲义通过结构审计', () => {
  const result = runAudit(makeCase())
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(result.errorCount, 0)
})

test('审计：未映射素材块报 UNMAPPED_BLOCK', () => {
  const result = runAudit(makeCase({ ledgerBlocks: {} }))
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('UNMAPPED_BLOCK'))
})

test('审计：章节内缺少来源标记报 MISSING_SOURCE_MARKER', () => {
  const result = runAudit(makeCase({ mdText: '# 讲义\n\n## 1. 引言 {#sec-1}\n\n正文没有标记。\n' }))
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('MISSING_SOURCE_MARKER'))
})

test('审计：公式解析错误报 MATH_ERROR', () => {
  const result = runAudit(makeCase({ mathErrors: [{ tex: '\\frac{1}{', line: 5, message: 'Expected }' }] }))
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('MATH_ERROR'))
})

test('审计：引用未登记图片报 FIGURE_UNREGISTERED', () => {
  const md = '# 讲义\n\n## 1. 引言 {#sec-1}\n\n正文 [S01, p.1]，见图 [@fig-001]。\n\n![图](assets/fig-001.svg){#fig-001}\n'
  const result = runAudit(makeCase({ mdText: md }))
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('FIGURE_UNREGISTERED'))
})

test('审计：clarification 声明缺少 [!CLARIFY] 报 CLARIFY_CALLOUT_MISSING', () => {
  const result = runAudit(
    makeCase({
      ledgerBlocks: {
        [BLOCK_ID]: { status: 'covered', sections: ['sec-1'], kinds: ['exposition', 'clarification'], reviewed: false },
      },
    }),
  )
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('CLARIFY_CALLOUT_MISSING'))
})

test('审计：低文本页没有 OCR 块报 VISION_UNREVIEWED', () => {
  const result = runAudit(makeCase({ sources: [source({ lowTextPages: [1] })] }))
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('VISION_UNREVIEWED'))
})

test('审计：断链交叉引用报 BROKEN_REF', () => {
  const result = runAudit(makeCase({ mdText: '# 讲义\n\n## 1. 引言 {#sec-1}\n\n正文 [S01, p.1]，见 [@sec-nope]。\n' }))
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('BROKEN_REF'))
})

test('审计：blocked 必须给理由，且进入未覆盖附录数据', () => {
  const result = runAudit(
    makeCase({
      ledgerBlocks: { [BLOCK_ID]: { status: 'blocked', sections: [], kinds: [], reason: '', reviewed: false } },
    }),
  )
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('BLOCKED_WITHOUT_REASON'))
})

test('审计：level=full 时缺少构建物与复核记录会报错', () => {
  const input = makeCase()
  const result = runAudit({ ...input, level: 'full', formats: ['pdf', 'ipynb'], buildReport: null })
  assert.equal(result.ok, false)
  const list = codes(result)
  assert.ok(list.includes('PDF_NOT_BUILT'))
  assert.ok(list.includes('NOTEBOOK_NOT_BUILT'))
  assert.ok(list.includes('REVIEW_REQUIRED'))
})
