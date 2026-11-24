// lecture_build — 从 .lecture/lecture.md 导出 PDF / HTML / ipynb / Markdown，并做 QA。
import path from 'node:path'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { ASSETS_DIR, PY_DIR, copyDir, exists, ensureDir, projectPaths, readTextSafe, relPosix } from '../paths.mjs'
import {
  LectureError,
  computeCoverage,
  loadFigures,
  loadLedger,
  loadProject,
  loadSources,
  saveProject,
  sourceBlockIndex,
} from '../projects.mjs'
import { renderMarkdown } from '../render/markdown.mjs'
import { renderHtmlDocument } from '../render/html.mjs'
import { printHtmlToPdf } from '../render/pdf.mjs'
import { renderPdfPages } from '../render/qa.mjs'
import { buildNotebook, executeNotebook, notebookJson } from '../render/ipynb.mjs'
import { ok, fail, optionalBool, projectDir, textOutput, toolSchema, wrap, withWarnings } from './common.mjs'

const FORMAT_ENUM = ['pdf', 'html', 'ipynb', 'md']

function mimeFor(type) {
  return {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
  }[String(type).toLowerCase()] ?? 'application/octet-stream'
}

function pageSelection(pageCount, limit) {
  if (!Number.isInteger(pageCount) || pageCount < 1) return []
  const wanted = new Set([1])
  if (pageCount > 1) wanted.add(2)
  if (pageCount > 2) wanted.add(pageCount)
  if (pageCount > 4) wanted.add(Math.round(pageCount / 2))
  if (pageCount > 6) wanted.add(Math.round(pageCount / 2) + 1)
  if (pageCount > 8) wanted.add(pageCount - 1)
  return [...wanted].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b).slice(0, Math.max(1, limit))
}

async function fileInfo(file) {
  try {
    const s = await stat(file)
    return { file, bytes: s.size }
  } catch {
    return null
  }
}

export function makeBuildTool(config, getRuntime) {
  return {
    name: 'lecture_build',
    description:
      '把 .lecture/lecture.md 导出为指定格式：pdf（KaTeX 公式 + 无头 Edge 打印）、html（自包含）、ipynb（逐单元执行并写入输出）、md（带图）。' +
      '会先检查素材覆盖与公式/图片错误；产出 out/lecture.*、out/qa/ 页图与 .lecture/build/report.json，并写回覆盖统计。之后用 lecture_audit 审计。',
    parameters: toolSchema(
      {
        project: { type: 'string', description: '项目目录（相对会话工作区，缺省=工作区根）' },
        formats: {
          type: 'array',
          items: { type: 'string', enum: FORMAT_ENUM },
          description: '本次输出格式（缺省用 project.formats）',
        },
        allowIncomplete: {
          type: 'boolean',
          description: '允许在仍有未映射素材/公式错误时先出草稿（仅用于预览；审计不会通过）',
        },
        notebook: { type: 'string', description: '可选：指定要执行的 notebook 来源路径（缺省由 lecture.md 生成）' },
      },
      [],
    ),
    output: textOutput(),
    execute: wrap(async (args, exec) => {
      const root = projectDir(exec, args)
      const project = loadProject(root)
      if (!project) throw new LectureError('NO_PROJECT', '项目未初始化', '先调用 lecture_init')
      const paths = projectPaths(root)
      const runtime = await getRuntime()
      const allowIncomplete = optionalBool(args, 'allowIncomplete', false)
      const formats = Array.isArray(args.formats) && args.formats.length ? normalizeFormats(args.formats) : project.formats
      const bad = formats.find((f) => !FORMAT_ENUM.includes(f))
      if (bad) return fail('UNKNOWN_FORMAT', `不支持的格式：${bad}`, `可用：${FORMAT_ENUM.join(' / ')}`)

      const mdText = readTextSafe(paths.lectureFile)
      if (!mdText.trim()) return fail('EMPTY_LECTURE', '还没有讲义正文', '先在 .lecture/lecture.md 写入内容并标注章节 {#sec-id}')

      const ledger = loadLedger(root)
      const sources = loadSources(root)
      const figuresData = loadFigures(root)
      const blockIndex = sourceBlockIndex(sources)
      const coverage = computeCoverage(project, sources, ledger)

      if (coverage.pending > 0 && !allowIncomplete) {
        const pending = []
        for (const source of sources) {
          for (const block of source.blocks) {
            const record = ledger.blocks[block.id]
            if (!record || !record.status || record.status === 'pending') {
              pending.push(block.id)
              if (pending.length >= 12) break
            }
          }
          if (pending.length >= 12) break
        }
        return fail(
          'UNMAPPED_BLOCKS',
          `还有 ${coverage.pending} 个素材块未登记去向，不能构建：${pending.join(', ')}${coverage.pending > pending.length ? ' …' : ''}`,
          '用 lecture_ledger action=next 逐批覆盖，或传 allowIncomplete:true 只出预览草稿',
        )
      }

      let rendered
      try {
        rendered = renderMarkdown(mdText, { language: project.language })
      } catch (error) {
        throw new LectureError('RENDER_FAILED', `Markdown 渲染失败：${error?.message ?? error}`)
      }
      const { analysis, mathErrors = [], warnings: renderWarnings = [] } = rendered
      if (mathErrors.length && !allowIncomplete) {
        const sample = mathErrors.slice(0, 6).map((e) => `第 ${e.line ?? '?'} 行：${String(e.message).slice(0, 200)}`).join('\n')
        return fail('MATH_ERRORS', `有 ${mathErrors.length} 处公式无法解析：\n${sample}`, '修复 $…$ / $$…$$ 中的 LaTeX；或 allowIncomplete 先出草稿')
      }

      const assetIds = new Set(figuresData.assets.map((a) => a.assetId))
      const missingFigures = (analysis.figures ?? []).map((f) => f.assetId ?? f.id).filter((id) => id && !assetIds.has(id))
      if (missingFigures.length && !allowIncomplete) {
        return fail('MISSING_FIGURES', `正文引用了未登记的图片：${[...new Set(missingFigures)].join(', ')}`, '用 lecture_figure 登记，或删除引用')
      }

      ensureDir(paths.outDir)
      ensureDir(paths.buildDir)
      ensureDir(paths.tmpDir)
      const report = {
        schemaVersion: 1,
        builtAt: new Date().toISOString(),
        projectId: project.id,
        title: project.title,
        formats,
        allowIncomplete,
        coverage: {
          total: coverage.total,
          covered: coverage.covered,
          merged: coverage.merged,
          blocked: coverage.blocked,
          pending: coverage.pending,
          percent: coverage.percent,
        },
        files: {},
        mathErrors,
        warnings: [...renderWarnings],
        figures: figuresData.assets.length,
        sections: analysis.sections.length,
        markers: analysis.markers.length,
        runtime: {
          python: runtime.python ? { version: runtime.python.version, path: runtime.python.path } : null,
          chromium: runtime.chromium?.path ?? null,
          kit: runtime.kit?.ok ? { cli: runtime.kit.cli } : null,
        },
      }

      // 图片资产复制到 out/assets（Markdown 导出与 HTML 兜底用）
      if (exists(paths.assetsDir)) {
        copyDir(paths.assetsDir, path.join(paths.outDir, 'assets'))
      }

      // notebook 先构建再执行（失败不阻断其它格式，但最终返回失败）
      let notebookFailure = null
      if (formats.includes('ipynb')) {
        try {
          const built = buildNotebook({ project, analysis, mdText, assets: figuresData.assets })
          const srcNotebook = built.notebook
          await writeFile(path.join(paths.buildDir, 'lecture.src.ipynb'), notebookJson(srcNotebook), 'utf8')
          const codeCells = (srcNotebook.cells ?? []).filter((c) => c.cell_type === 'code').length
          const execution = await executeNotebook({
            notebook: srcNotebook,
            pythonPath: runtime.python?.path,
            cwd: root,
            pyDir: PY_DIR,
            cellTimeoutMs: config.cellTimeoutMs,
            totalTimeoutMs: config.notebookTimeoutMs,
            signal: exec?.signal,
          })
          const executedNotebook = execution.notebook ?? srcNotebook
          await writeFile(path.join(paths.outDir, 'lecture.ipynb'), notebookJson(executedNotebook), 'utf8')
          // 随产物分发 lecturekit，便于用户本地重跑
          const helpers = path.join(paths.outDir, 'lecture_helpers')
          ensureDir(helpers)
          copyDir(path.join(PY_DIR, 'lecturekit'), path.join(helpers, 'lecturekit'))
          const ipynbInfo = await fileInfo(path.join(paths.outDir, 'lecture.ipynb'))
          report.files.ipynb = ipynbInfo ? { file: 'out/lecture.ipynb', bytes: ipynbInfo.bytes } : null
          report.notebook = {
            file: 'out/lecture.ipynb',
            executed: execution.executed,
            codeCells,
            failed: execution.failed,
            cells: execution.cells,
            warnings: execution.warnings ?? [],
          }
          report.warnings.push(...(built.warnings ?? []), ...(execution.warnings ?? []))
          if (execution.failed > 0 || execution.executed !== codeCells) {
            notebookFailure = `Notebook 执行未全部成功：${execution.executed}/${codeCells}，失败 ${execution.failed}`
          }
        } catch (error) {
          notebookFailure = `Notebook 构建失败：${error?.message ?? error}`
          report.notebook = report.notebook ?? { file: null, executed: 0, codeCells: 0, failed: 1, cells: [] }
        }
      }

      const assetDataUrls = {}
      for (const figure of analysis.figures ?? []) {
        const id = figure.assetId ?? figure.id
        if (!id) continue
        const record = figuresData.assets.find((a) => a.assetId === id)
        if (!record) continue
        const abs = path.join(root, '.lecture', record.file)
        if (!exists(abs)) continue
        try {
          assetDataUrls[id] = `data:${mimeFor(record.type)};base64,${(await readFile(abs)).toString('base64')}`
        } catch {
          report.warnings.push(`图片 ${id} 读取失败，HTML 中将缺失`)
        }
      }
      let html = null
      try {
        const css = {
          lecture: readTextSafe(path.join(ASSETS_DIR, 'css', 'lecture.css')),
          print: readTextSafe(path.join(ASSETS_DIR, 'css', 'print.css')),
        }
        const blockedBlocks = []
        for (const [blockId, record] of Object.entries(ledger.blocks ?? {})) {
          if (record?.status !== 'blocked') continue
          const entry = blockIndex.get(blockId)
          blockedBlocks.push({
            blockId,
            sourceId: entry?.source?.sourceId ?? blockId.split('#')[0],
            page: entry?.block?.page ?? entry?.block?.section ?? blockId,
            text: entry?.block?.text ? String(entry.block.text).slice(0, 160) : record.reason ?? '',
          })
        }
        let reviewNotes = []
        try {
          const reviewFile = path.join(paths.lectureDir, 'review.json')
          if (exists(reviewFile)) {
            const review = JSON.parse(readTextSafe(reviewFile) || '{}')
            reviewNotes = Array.isArray(review.notes) ? review.notes : review.notes ? [review.notes] : []
            if (review.verdict) reviewNotes.unshift(`复核结论：${review.verdict}`)
            if (Array.isArray(review.issues) && review.issues.length) {
              reviewNotes.push(...review.issues.map((issue) => `待关注：${String(issue)}`))
            }
          }
        } catch {
          // review.json 损坏时不影响构建
        }
        const sourceCards = sources.map((source) => ({
          sourceId: source.sourceId,
          label: source.label,
          kind: source.kind,
          pages: Number.isFinite(source.structure?.pages)
            ? source.structure.pages
            : source.structure?.sections
              ? Object.keys(source.structure.sections).length
              : null,
          blocks: Array.isArray(source.blocks) ? source.blocks.length : 0,
        }))
        const doc = renderHtmlDocument({
          project,
          analysis,
          bodyHtml: rendered.html,
          extras: {
            assetDataUrls,
            sources: sourceCards,
            coverage,
            blockedBlocks,
            reviewNotes,
            figures: figuresData.assets,
          },
          css,
        })
        html = doc.html
        report.warnings.push(...(doc.warnings ?? []))
      } catch (error) {
        report.warnings.push(`HTML 模板渲染失败：${error?.message ?? error}`)
      }

      if (formats.includes('html')) {
        if (!html) return fail('HTML_FAILED', 'HTML 渲染失败', report.warnings.slice(-3).join('；'))
        const htmlPath = path.join(paths.outDir, 'lecture.html')
        await writeFile(htmlPath, html, 'utf8')
        const info = await fileInfo(htmlPath)
        report.files.html = info ? { file: 'out/lecture.html', bytes: info.bytes } : null
      }

      if (formats.includes('md')) {
        const mdPath = path.join(paths.outDir, 'lecture.md')
        await writeFile(mdPath, mdText, 'utf8')
        const info = await fileInfo(mdPath)
        report.files.md = info ? { file: 'out/lecture.md', bytes: info.bytes } : null
      }

      if (formats.includes('pdf')) {
        if (!runtime.chromium?.path) {
          return fail('CHROMIUM_MISSING', '找不到 Edge/Chrome，无法打印 PDF', '配置 chromiumPath，或改用 formats=["html"]')
        }
        if (!html) return fail('HTML_FAILED', 'PDF 需要先渲染 HTML，但 HTML 渲染失败')
        const htmlPath = path.join(paths.buildDir, 'lecture.print.html')
        await writeFile(htmlPath, html, 'utf8')
        const pdfPath = path.join(paths.outDir, 'lecture.pdf')
        const printed = await printHtmlToPdf({
          htmlPath,
          pdfPath,
          chromiumPath: runtime.chromium.path,
          timeoutMs: config.buildTimeoutMs,
          signal: exec?.signal,
          tmpDir: paths.tmpDir,
        })
        if (!printed.ok) {
          return fail('PDF_FAILED', `PDF 打印失败：${printed.message ?? '未知原因'}`, '检查无头浏览器是否可运行；也可先导出 html')
        }
        const pdfInfo = await fileInfo(pdfPath)
        report.pdf = { file: 'out/lecture.pdf', bytes: pdfInfo?.bytes ?? null, pageCount: printed.pages ?? null }
        if (runtime.kit?.ok) {
          const qaDir = path.join(paths.outDir, 'qa')
          ensureDir(qaDir)
          let pageCount = printed.pages
          let renderedPages = []
          let qaMessage = null
          if (!pageCount) {
            const first = await renderPdfPages({
              pdfPath,
              outDir: qaDir,
              pages: [1],
              dpi: config.qaDpi,
              kit: runtime.kit,
              signal: exec?.signal,
              timeoutMs: config.buildTimeoutMs,
            })
            qaMessage = first.message ?? qaMessage
            pageCount = first.pageCount
            renderedPages = first.pages ?? []
          }
          const selection = pageSelection(pageCount, config.qaPages)
          if (selection.length && renderedPages.length === 0) {
            const rest = await renderPdfPages({
              pdfPath,
              outDir: qaDir,
              pages: selection,
              dpi: config.qaDpi,
              kit: runtime.kit,
              signal: exec?.signal,
              timeoutMs: config.buildTimeoutMs,
            })
            qaMessage = rest.message ?? qaMessage
            renderedPages = rest.pages ?? []
            report.pdf.pageCount = rest.pageCount ?? pageCount
            report.pdf.missingFonts = rest.missingFonts ?? []
          }
          report.qa = {
            pages: renderedPages.map((p) => ({ page: p.page, file: relPosix(root, p.file) })),
            dpi: config.qaDpi,
          }
          if (!renderedPages.length) {
            report.warnings.push(`QA 页图渲染失败，未生成视觉检查图${qaMessage ? `：${qaMessage}` : ''}`)
          }
        } else {
          report.qa = { pages: [] }
          report.warnings.push(
            'LibreOffice Kit 不可用（缺内置 node 或 kit cli），未生成 QA 页图；请检查 DSH 内置运行时，或配置 libreOfficeKitCli。',
          )
        }
      }

      report.pages = report.pdf?.pageCount ?? null
      await writeFile(path.join(paths.buildDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
      await writeFile(path.join(paths.outDir, 'build-report.json'), JSON.stringify(report, null, 2), 'utf8')
      project.updatedAt = new Date().toISOString()
      project.lastBuild = { at: report.builtAt, formats }
      saveProject(root, project)

      const lines = [
        `构建完成：${formats.map((f) => `out/lecture.${f}`).join('，')}`,
        `覆盖 ${coverage.covered}/${coverage.total}（merged ${coverage.merged}，blocked ${coverage.blocked}，pending ${coverage.pending}）｜章节 ${analysis.sections.length}｜来源标记 ${analysis.markers.length}｜图 ${figuresData.assets.length}`,
      ]
      if (report.pdf?.pageCount) lines.push(`PDF：${report.pdf.pageCount} 页${report.pdf.bytes ? `，${Math.round(report.pdf.bytes / 1024)} KB` : ''}`)
      if (report.qa?.pages?.length) lines.push(`视觉检查页：${report.qa.pages.map((p) => `p.${p.page}`).join(', ')}（可用 read_image 查看 out/qa/）`)
      if (report.notebook) lines.push(`Notebook：执行 ${report.notebook.executed}/${report.notebook.codeCells}，失败 ${report.notebook.failed}`)
      if (mathErrors.length) lines.push(`⚠ 仍有 ${mathErrors.length} 处公式错误（因 allowIncomplete 继续构建）`)
      if (report.warnings.length) lines.push('', '警告：', ...report.warnings.slice(0, 8).map((w) => `- ${w}`))
      lines.push(
        '',
        '下一步：',
        '1. `lecture_audit`（结构审计）修掉所有 error；',
        '2. 让另一个 subagent 独立审阅讲义（漏内容/错推导/虚构），再用 lecture_audit action=record-review 记录；',
        '3. `lecture_audit level=full` 通过后才算完成。',
      )
      const summary = { files: report.files, pdf: report.pdf ?? null, qa: report.qa ?? null, report: '.lecture/build/report.json' }
      if (notebookFailure) {
        return { ...fail('NOTEBOOK_FAILED', notebookFailure, '修复 notebook 单元后重新 lecture_build；PDF/HTML 已生成'), ...summary }
      }
      return ok(withWarnings(lines.join('\n'), report.warnings.slice(0, 5)), summary)
    }),
  }
}

function normalizeFormats(formats) {
  const allowed = new Set(FORMAT_ENUM)
  const out = []
  for (const raw of formats) {
    const f = String(raw).toLowerCase()
    if (!allowed.has(f)) continue
    if (!out.includes(f)) out.push(f)
  }
  return out.length ? out : ['pdf']
}
