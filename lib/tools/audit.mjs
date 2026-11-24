// lecture_audit — 确定性审计 + 独立语义复核记录。
import path from 'node:path'
import { writeJson, readTextSafe, readJson, projectPaths } from '../paths.mjs'
import { LectureError, computeCoverage, loadFigures, loadLedger, loadProject, loadSources, sourceBlockIndex } from '../projects.mjs'
import { renderMarkdown } from '../render/markdown.mjs'
import { runAudit } from '../audit.mjs'
import { fail, ok, optionalString, projectDir, textOutput, toolSchema, wrap, withWarnings } from './common.mjs'

const LEVELS = ['structure', 'full']

function formatIssues(list, limit = 12) {
  return list
    .slice(0, limit)
    .map((item) => `- [${item.code}] ${item.message}`)
    .join('\n')
}

export function makeAuditTool(config) {
  return {
    name: 'lecture_audit',
    description:
      '审计讲义是否真正覆盖全部素材并满足质量门槛（确定性检查，不含模型判断）：未映射素材块、来源标记缺失/越界、澄清标注双向对应、brief 补充要求、图片登记与来源、交叉引用、公式错误、扫描页 OCR 复核；level=full 还检查 PDF/Notebook/QA 页图与独立复核记录。' +
      'action=record-review 用于记录另一个 agent 的独立语义复核结论（写入 .lecture/review.json）。',
    parameters: toolSchema(
      {
        project: { type: 'string', description: '项目目录（相对会话工作区，缺省=工作区根）' },
        action: { type: 'string', enum: ['run', 'record-review'], description: '缺省 run' },
        level: { type: 'string', enum: LEVELS, description: 'structure=内容与结构；full=再加构建物与复核记录（交付前必须 full 通过）' },
        notes: { type: 'string', description: 'record-review 必填：复核结论摘要' },
        issues: { type: 'array', items: { type: 'string' }, description: 'record-review 可选：发现的问题清单' },
        verdict: { type: 'string', enum: ['pass', 'issues'], description: 'record-review 可选：结论' },
        reviewer: { type: 'string', description: 'record-review 可选：复核者标识（如 subagent 任务 id）' },
      },
      [],
    ),
    output: textOutput(),
    execute: wrap(async (args, exec) => {
      const root = projectDir(exec, args)
      const project = loadProject(root)
      if (!project) throw new LectureError('NO_PROJECT', '项目未初始化', '先调用 lecture_init')
      const paths = projectPaths(root)
      const action = optionalString(args, 'action', 'run')

      if (action === 'record-review') {
        const notes = optionalString(args, 'notes', '')
        if (!String(notes).trim()) {
          return fail('MISSING_NOTES', 'record-review 需要 notes（复核结论摘要）', '先让另一个 subagent 通读 out/lecture.md 或 PDF 并给出问题清单')
        }
        const issues = Array.isArray(args.issues) ? args.issues.map((s) => String(s)).filter(Boolean) : []
        const verdict = optionalString(args, 'verdict', issues.length ? 'issues' : 'pass')
        const review = {
          schemaVersion: 1,
          verdict,
          notes: String(notes),
          issues,
          reviewer: optionalString(args, 'reviewer', exec?.agent?.id ?? 'unknown'),
          reviewedAt: new Date().toISOString(),
        }
        writeJson(path.join(paths.lectureDir, 'review.json'), review)
        return ok(
          `已记录独立复核：${verdict}${issues.length ? `，${issues.length} 个问题` : ''}。${issues.length ? '修复这些问题后重新 record-review。' : '现在可以运行 lecture_audit level=full 做交付前检查。'}\n文件：.lecture/review.json`,
          { review },
        )
      }

      const level = optionalString(args, 'level', 'structure')
      if (!LEVELS.includes(level)) return fail('UNKNOWN_LEVEL', `未知审计级别：${level}`, `可用：${LEVELS.join(' / ')}`)

      const mdText = readTextSafe(paths.lectureFile)
      if (!mdText.trim()) return fail('EMPTY_LECTURE', '还没有讲义正文', '先写 .lecture/lecture.md')

      const ledger = loadLedger(root)
      const sources = loadSources(root)
      const figuresData = loadFigures(root)
      const blockIndex = sourceBlockIndex(sources)
      let rendered
      try {
        rendered = renderMarkdown(mdText, { language: project.language })
      } catch (error) {
        return fail('RENDER_FAILED', `Markdown 渲染失败：${error?.message ?? error}`, '先修复 lecture.md 的语法')
      }
      const buildReport = readJson(path.join(paths.buildDir, 'report.json'), null)
      const result = runAudit({
        project,
        sources,
        ledger,
        mdText,
        analysis: rendered.analysis,
        mathErrors: rendered.mathErrors ?? [],
        figuresData,
        config,
        projectDir: root,
        blockIndex,
        formats: project.formats,
        buildReport,
        level,
      })
      const coverage = computeCoverage(project, sources, ledger)

      const lines = [
        result.ok ? `✅ 审计通过（${level}）` : `❌ 审计未通过（${level}）：${result.errorCount} 个错误，${result.warningCount} 个警告`,
        `覆盖：${coverage.covered}/${coverage.total} covered，merged ${coverage.merged}，blocked ${coverage.blocked}，pending ${coverage.pending}（${coverage.percent}%）`,
        `章节 ${result.stats.sections}｜来源标记 ${result.stats.markers}｜标注块 ${result.stats.callouts}｜公式 ${result.stats.equations}｜图 ${result.stats.figures}`,
      ]
      if (result.errors.length) lines.push('', '错误：', formatIssues(result.errors))
      if (result.warnings.length) lines.push('', '警告：', formatIssues(result.warnings, 8))
      if (!result.ok) {
        lines.push('', '修复后重新运行 lecture_audit；不要用修改审计规则或伪造账本来通过。')
      } else if (level === 'structure') {
        lines.push('', '结构通过。接下来：构建产物 → 独立语义复核（另派 agent）→ lecture_audit action=record-review → lecture_audit level=full。')
      } else {
        lines.push('', '交付前检查通过：可以把 out/ 下的文件交给用户，并附上覆盖统计与未覆盖说明。')
      }
      return {
        ...(result.ok ? ok(lines.join('\n')) : fail('AUDIT_FAILED', lines.join('\n'), '按错误清单逐项修复')),
        level,
        ok: result.ok,
        errors: result.errors,
        warnings: result.warnings,
        errorCount: result.errorCount,
        warningCount: result.warningCount,
        coverage,
        stats: result.stats,
      }
    }),
  }
}
