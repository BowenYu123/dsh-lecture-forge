// lecture_ledger — 素材覆盖账本：列块、取下一批、回填 claim、统计、标记复核。
import path from 'node:path'
import { readTextSafe } from '../paths.mjs'
import {
  LectureError,
  loadLedger,
  loadProject,
  loadSources,
  saveLedger,
  sourceBlockIndex,
  computeCoverage,
  visionPending,
} from '../projects.mjs'
import { applyClaims, ledgerCounts, markReviewed } from '../ledger.mjs'
import { analyzeMarkdown } from '../render/markdown.mjs'
import { ok, fail, optionalInt, optionalString, projectDir, textOutput, toolSchema, wrap, withWarnings } from './common.mjs'

function excerptOf(block, max = 220) {
  const text = String(block?.text ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

function syncSections(projectDirPath, ledger) {
  const mdPath = path.join(projectDirPath, '.lecture', 'lecture.md')
  const md = readTextSafe(mdPath)
  if (!md) return { ledger, analysis: null, warning: '尚未写入 .lecture/lecture.md（claim 需要章节 id）' }
  const analysis = analyzeMarkdown(md)
  const sections = analysis.sections
    .filter((s) => s.id)
    .map((s) => ({ id: s.id, level: s.level, title: s.title, anchor: `#${s.id}` }))
  const changed = JSON.stringify(sections) !== JSON.stringify(ledger.sections)
  if (changed) ledger.sections = sections
  return { ledger, analysis, warning: null }
}

function statusLine(coverage) {
  return `覆盖 ${coverage.covered}/${coverage.total} 块（merged ${coverage.merged}，blocked ${coverage.blocked}，pending ${coverage.pending}，${coverage.percent}%）`
}

export function makeLedgerTool(config) {
  return {
    name: 'lecture_ledger',
    description:
      '素材覆盖账本：list 看状态与章节；next 取下一批未覆盖块（含出处与摘录）；claim/claim-batch 把块回填到讲义章节（status=covered|merged|blocked，kinds=…）；stats 看覆盖率；reviewed 标记已人工复核的低置信块。' +
      '每个素材块都必须覆盖或有明确去向，审计 lecture_audit 会检查。',
    parameters: toolSchema(
      {
        project: { type: 'string', description: '项目目录（相对会话工作区，缺省=工作区根）' },
        action: {
          type: 'string',
          enum: ['list', 'next', 'claim', 'claim-batch', 'stats', 'reviewed'],
          description: '操作类型',
        },
        limit: { type: 'integer', description: 'next 返回条数（1-50，缺省 10）' },
        sourceId: { type: 'string', description: 'next 只看某个来源，如 S01' },
        claims: {
          type: 'array',
          description: 'claim/claim-batch：要回填的块',
          items: {
            type: 'object',
            properties: {
              blockId: { type: 'string', description: '块 id，如 S01#p003-b02' },
              status: { type: 'string', enum: ['covered', 'merged', 'blocked'] },
              sections: { type: 'array', items: { type: 'string' }, description: '章节 id（可带 #）' },
              kinds: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['exposition', 'clarification', 'derivation', 'example', 'verification', 'exercise', 'solution'],
                },
                description: '该块在讲义中的使用方式',
              },
              mergeInto: { type: 'string', description: 'merged 时指向已覆盖的块 id' },
              reason: { type: 'string', description: 'blocked 时的原因' },
              reviewed: { type: 'boolean', description: '是否已人工复核（低置信块需要）' },
            },
            required: ['blockId', 'status'],
            additionalProperties: false,
          },
        },
        blockIds: { type: 'array', items: { type: 'string' }, description: 'reviewed：要标记的块 id' },
      },
      ['action'],
    ),
    output: textOutput(),
    execute: wrap(async (args, exec) => {
      const root = projectDir(exec, args)
      const project = loadProject(root)
      if (!project) throw new LectureError('NO_PROJECT', '项目未初始化', '先调用 lecture_init')
      const ledger = loadLedger(root)
      const sources = loadSources(root)
      const blockIndex = sourceBlockIndex(sources)
      const { analysis, warning } = syncSections(root, ledger)
      const coverage = computeCoverage(project, sources, ledger)
      const counts = ledgerCounts(ledger)
      const action = String(args.action ?? '')

      if (action === 'stats' || action === 'list') {
        const vision = visionPending(sources, ledger)
        const lines = [
          `${project.title}｜${sources.length} 个来源，${coverage.total} 块`,
          statusLine(coverage),
          `章节：${ledger.sections.length} 个｜已复核：${coverage.reviewed}｜视觉待处理页：${vision.length}`,
        ]
        if (vision.length) lines.push(`待 OCR 页：${vision.slice(0, 10).map((v) => `${v.sourceId}#p${v.page}`).join(', ')}${vision.length > 10 ? ' …' : ''}`)
        if (warning) lines.push(`⚠ ${warning}`)
        const perSource = coverage.perSource
          .map((s) => `- ${s.sourceId} ${s.label}：${s.covered}/${s.blocks} covered，merged ${s.merged}，blocked ${s.blocked}，pending ${s.pending}`)
          .join('\n')
        if (perSource) lines.push('', perSource)
        if (action === 'list') {
          if (ledger.sections.length) {
            lines.push('', '章节：', ...ledger.sections.map((s) => `- ${'#'.repeat(Math.min(6, s.level ?? 2))} ${s.title}（${s.id}）`))
          }
          const pending = sources.flatMap((s) => s.blocks.filter((b) => !ledger.blocks[b.id] || ['pending', undefined].includes(ledger.blocks[b.id].status)))
          lines.push('', `尚未映射的块：${pending.length}（用 next 查看）`)
        }
        return ok(withWarnings(lines.join('\n'), vision.length ? ['存在未复核的低文本页，构建前必须 attach-ocr 并标记 reviewed'] : []), {
          coverage,
          counts,
          sections: ledger.sections,
          visionPending: vision.slice(0, 40),
        })
      }

      if (action === 'next') {
        const limit = optionalInt(args, 'limit', { min: 1, max: 50, fallback: 10 })
        const only = optionalString(args, 'sourceId')
        const remaining = []
        for (const source of sources) {
          if (only && source.sourceId !== only) continue
          for (const block of source.blocks) {
            const record = ledger.blocks[block.id]
            if (record && record.status && record.status !== 'pending') continue
            remaining.push({ source, block })
          }
        }
        remaining.sort((a, b) => {
          if (a.source.sourceId !== b.source.sourceId) return a.source.sourceId.localeCompare(b.source.sourceId)
          if ((a.block.page ?? 0) !== (b.block.page ?? 0)) return (a.block.page ?? 0) - (b.block.page ?? 0)
          return String(a.block.id).localeCompare(String(b.block.id))
        })
        const batch = remaining.slice(0, limit)
        if (!batch.length) {
          return ok('所有素材块都已映射。下一步：lecture_build 导出，然后 lecture_audit 审计。', {
            remaining: 0,
            coverage,
          })
        }
        const lines = [`下一批未覆盖块（共剩 ${remaining.length}）：`]
        for (const { source, block } of batch) {
          const page = block.page ? `p.${block.page}` : block.section ? `§${block.section}` : ''
          const flags = [block.kind, block.confidence === 'low' ? 'low-confidence' : null, block.needsVision ? 'needs-vision' : null]
            .filter(Boolean)
            .join('/')
          lines.push(`\n[${block.id}] ${source.label} ${page}（${flags}）\n${excerptOf(block)}`)
        }
        lines.push(
          '',
          '处理方式：把内容写进 lecture.md 对应章节，并保留来源标记（如 [S01, p.3]）；然后在 claim-batch 里为这些块登记 section 与 kinds。',
        )
        return ok(lines.join('\n'), {
          remaining: remaining.length,
          batch: batch.map(({ source, block }) => ({
            blockId: block.id,
            sourceId: source.sourceId,
            page: block.page ?? null,
            kind: block.kind,
            confidence: block.confidence,
            needsVision: Boolean(block.needsVision),
            excerpt: excerptOf(block, 600),
          })),
          coverage,
        })
      }

      if (action === 'claim' || action === 'claim-batch') {
        const raw = Array.isArray(args.claims) ? args.claims : []
        if (!raw.length) return fail('EMPTY_CLAIMS', 'claims 不能为空', '每个 claim 需要 blockId 和 status')
        if (!analysis) {
          return fail('NO_LECTURE', '还没有 .lecture/lecture.md', '先写入讲义正文（标题带 {#sec-id}），再 claim')
        }
        const sectionIds = analysis.sections.map((s) => s.id).filter(Boolean)
        const result = applyClaims(ledger, raw, { blockIndex, sectionIds })
        saveLedger(root, ledger)
        const newCoverage = computeCoverage(project, sources, ledger)
        const appliedCount = Array.isArray(result.applied) ? result.applied.length : 0
        const lines = [`已回填 ${appliedCount} 条；${statusLine(newCoverage)}`]
        if (result.errors.length) {
          lines.push('', `失败 ${result.errors.length} 条：`, ...result.errors.map((e) => `- ${e.blockId ?? e.claim?.blockId ?? '?'}: ${e.code} ${e.message}`))
        }
        if (result.warnings.length) lines.push('', ...result.warnings.map((w) => `⚠ ${w}`))
        const payload = { applied: result.applied, errors: result.errors, warnings: result.warnings, coverage: newCoverage }
        if (appliedCount === 0 && result.errors.length) {
          return { ...fail('CLAIM_FAILED', lines.join('\n'), '检查 blockId / sections / kinds 是否与账本和正文一致'), ...payload }
        }
        return ok(lines.join('\n'), payload)
      }

      if (action === 'reviewed') {
        const ids = Array.isArray(args.blockIds) ? args.blockIds.map(String) : []
        if (!ids.length) return fail('MISSING_ARGUMENT', 'blockIds 不能为空')
        const changed = markReviewed(ledger, ids)
        saveLedger(root, ledger)
        const newCoverage = computeCoverage(project, sources, ledger)
        return ok(`已标记 ${changed} 块为已复核（共 ${newCoverage.reviewed} 块）。`, { reviewed: newCoverage.reviewed })
      }

      return fail('UNKNOWN_ACTION', `未知 action：${action}`, '可用：list / next / claim / claim-batch / stats / reviewed')
    }),
  }
}
