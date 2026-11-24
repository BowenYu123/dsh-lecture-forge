// lecture_ingest — 摄取素材（PDF/DOCX/PPTX/MD/HTML/URL），登记块与图，生成视觉兜底队列。
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { copyFileTo, exists, ensureDir, formatBytes, relPosix, resolveInputPath, sha256File } from '../paths.mjs'
import {
  LectureError,
  computeCoverage,
  loadLedger,
  loadProject,
  loadSources,
  nextSourceId,
  saveSource,
} from '../projects.mjs'
import { ingestPath } from '../ingest/index.mjs'
import { registerAsset } from '../assets.mjs'
import { renderPdfPages } from '../render/qa.mjs'
import { ok, fail, optionalInt, optionalString, projectDir, textOutput, toolSchema, wrap, withWarnings } from './common.mjs'

const KIND_ENUM = ['pdf', 'docx', 'pptx', 'md', 'html', 'url', 'txt']

function kindFromPath(p) {
  const ext = path.extname(p).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  if (ext === '.pptx') return 'pptx'
  if (ext === '.md' || ext === '.markdown') return 'md'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.txt') return 'txt'
  return null
}

function summarizeBlocks(source) {
  const byKind = {}
  for (const block of source.blocks) byKind[block.kind] = (byKind[block.kind] ?? 0) + 1
  return byKind
}

async function buildVisionQueue(config, runtime, root, source, signal) {
  const low = Array.isArray(source.lowTextPages) ? source.lowTextPages : []
  if (!low.length) return { queue: [], warnings: [] }
  const pages = low.slice(0, config.visionQueueLimit)
  const warnings = []
  if (low.length > pages.length) {
    warnings.push(`低文本页共 ${low.length} 页，本次只生成前 ${pages.length} 页的页图（visionQueueLimit=${config.visionQueueLimit}）；其余页可再次调用 attach-ocr 或调整配置`)
  }
  if (source.kind !== 'pdf') return { queue: [], warnings }
  if (!runtime.kit?.ok) {
    return { queue: [], warnings: [...warnings, 'LibreOffice Kit 不可用，无法把 PDF 页栅格化为图片；可直接用 page 参数调用 attach-ocr 并转写文字'] }
  }
  const outDir = path.join(root, '.lecture', 'tmp', `vision-${source.sourceId}`)
  ensureDir(outDir)
  const result = await renderPdfPages({
    pdfPath: source.origin.storedPathAbs,
    outDir,
    pages,
    dpi: Math.min(config.qaDpi, 150),
    kit: runtime.kit,
    signal,
    timeoutMs: Math.min(config.buildTimeoutMs, 120000),
  })
  if (!result.ok) return { queue: [], warnings: [...warnings, `页图生成失败：${result.message ?? '未知原因'}`] }
  const byPage = new Map(result.pages.map((p) => [p.page, p.file]))
  const queue = pages.map((page) => ({
    page,
    image: relPosix(root, byPage.get(page) ?? ''),
    reason: 'low_text',
  }))
  return { queue, warnings }
}

export function makeIngestTool(config, getRuntime) {
  return {
    name: 'lecture_ingest',
    description:
      '摄取一个素材并规范化成可寻址的块：支持 PDF（含图片抽取、低文本页检测）、DOCX、PPTX、Markdown、HTML、网页 URL、纯文本。' +
      '返回 sourceId、块数、结构、低文本页视觉队列；扫描页/公式截图需再用 action=attach-ocr 回填转写（先用 read_image / modlens_read_image 看图）。',
    parameters: toolSchema(
      {
        project: { type: 'string', description: '项目目录（相对会话工作区，缺省=工作区根）' },
        action: { type: 'string', enum: ['source', 'attach-ocr'], description: '缺省 source' },
        source: { type: 'string', description: 'source：文件路径（相对会话工作区/绝对）或 http(s) 链接' },
        kind: { type: 'string', enum: KIND_ENUM, description: 'source：类型提示（缺省按扩展名/协议判断）' },
        label: { type: 'string', description: 'source：显示名（缺省取文件名/网页标题）' },
        force: { type: 'boolean', description: 'source：同一文件已摄取时强制再摄取一份' },
        sourceId: { type: 'string', description: 'attach-ocr：来源 id，如 S01' },
        page: { type: 'integer', description: 'attach-ocr：页码（1-based）' },
        text: { type: 'string', description: 'attach-ocr：该页的转写文字（含公式用 $…$ / $$…$$）' },
        caption: { type: 'string', description: 'attach-ocr：可选说明' },
        image: { type: 'string', description: 'attach-ocr：可选，关联一个 assetId（该页/该区域的图片）' },
        reviewed: { type: 'boolean', description: 'attach-ocr：是否已人工/视觉复核（缺省 false）' },
      },
      ['action'],
    ),
    output: textOutput(),
    execute: wrap(async (args, exec) => {
      const root = projectDir(exec, args)
      const project = loadProject(root)
      if (!project) throw new LectureError('NO_PROJECT', '项目未初始化', '先调用 lecture_init')
      const runtime = await getRuntime()
      const action = String(args.action ?? 'source')

      if (action === 'attach-ocr') {
        const sourceId = optionalString(args, 'sourceId')
        if (!sourceId) return fail('MISSING_ARGUMENT', 'attach-ocr 需要 sourceId')
        const page = optionalInt(args, 'page', { min: 1, max: config.maxPages })
        if (!page) return fail('MISSING_ARGUMENT', 'attach-ocr 需要 page')
        const text = optionalString(args, 'text', { max: 200000 })
        if (!text) return fail('MISSING_ARGUMENT', 'attach-ocr 需要 text（该页的转写内容）')
        const sources = loadSources(root)
        const source = sources.find((s) => s.sourceId === sourceId)
        if (!source) return fail('UNKNOWN_SOURCE', `找不到来源 ${sourceId}`, `现有来源：${sources.map((s) => s.sourceId).join(', ') || '无'}`)
        const nextIndex = source.blocks.filter((b) => b.page === page).length + 1
        const blockId = `${sourceId}#p${String(page).padStart(3, '0')}-b${String(nextIndex).padStart(2, '0')}`
        const block = {
          id: blockId,
          page,
          section: null,
          kind: 'ocr',
          text,
          chars: text.length,
          confidence: 'high',
          needsVision: false,
          imageAssetId: optionalString(args, 'image') ?? null,
          caption: optionalString(args, 'caption'),
          provenance: 'vision',
          hash: null,
        }
        source.blocks.push(block)
        source.blocks.sort((a, b) => {
          if ((a.page ?? 0) !== (b.page ?? 0)) return (a.page ?? 0) - (b.page ?? 0)
          return String(a.id).localeCompare(String(b.id))
        })
        source.warnings = Array.isArray(source.warnings) ? source.warnings : []
        if (!source.lowTextPages.includes(page)) source.warnings.push(`第 ${page} 页不在低文本页列表中，attach-ocr 仍已追加`)
        saveSource(root, source)
        const ledgerUpdate = args.reviewed === true
        return ok(
          `已追加 OCR 块 ${blockId}（${text.length} 字）。\n` +
            '下一步：在讲义正文引用该页内容并保留 [S01, p.' +
            page +
            '] 标记，然后 lecture_ledger claim-batch 把该块登记到章节（kinds 至少包含 exposition）。' +
            (ledgerUpdate ? '并 lecture_ledger action=reviewed 标记已复核。' : '再 lecture_ledger action=reviewed 标记已复核。'),
          { blockId, page, reviewed: false },
        )
      }

      if (action !== 'source') return fail('UNKNOWN_ACTION', `未知 action：${action}`, '可用：source / attach-ocr')

      const rawSource = optionalString(args, 'source', { max: 4096 })
      if (!rawSource) return fail('MISSING_ARGUMENT', 'source 必填（文件路径或 URL）')
      const isUrl = /^https?:\/\//i.test(rawSource)
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
      let file = null
      let kind = optionalString(args, 'kind')
      if (isUrl) {
        file = rawSource
        kind = 'url'
      } else {
        file = resolveInputPath(cwd, rawSource)
        if (!exists(file)) return fail('FILE_NOT_FOUND', `找不到文件：${file}`)
        kind = kind ?? kindFromPath(file)
        if (!kind) return fail('UNKNOWN_KIND', `无法判断文件类型：${path.basename(file)}`, `请用 kind 指定：${KIND_ENUM.join(' / ')}`)
        const size = (await stat(file)).size
        if (size > config.maxFileBytes) {
          return fail('FILE_TOO_LARGE', `文件 ${formatBytes(size)} 超过上限 ${formatBytes(config.maxFileBytes)}`, '调整插件配置 maxFileBytes 或拆分素材')
        }
      }
      if (!KIND_ENUM.includes(kind)) return fail('UNKNOWN_KIND', `不支持的类型：${kind}`)

      const sources = loadSources(root)
      let digest = null
      if (!isUrl) digest = await sha256File(file)
      if (digest && !args.force) {
        const dup = sources.find((s) => s.origin?.sha256 === digest)
        if (dup) {
          return ok(
            withWarnings(`该文件已摄取为 ${dup.sourceId}「${dup.label}」，本次未重复登记。`, [
              '如需再登记一份（例如换一个 sourceId），传 force:true',
            ]),
            { duplicate: true, sourceId: dup.sourceId, blocks: dup.blocks.length, sources: sources.map((s) => s.sourceId) },
          )
        }
      }
      const sourceId = nextSourceId(sources.map((s) => s.sourceId))
      const labelArg = optionalString(args, 'label', { max: 200 })
      const label = labelArg ?? (isUrl ? new URL(file).hostname + new URL(file).pathname : path.basename(file))

      let storedPath = null
      let storedPathAbs = null
      if (!isUrl && config.keepRawSources) {
        const rawDir = path.join(root, '.lecture', 'raw')
        ensureDir(rawDir)
        storedPathAbs = path.join(rawDir, `${sourceId}-${path.basename(file).replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')}`)
        await copyFileTo(file, storedPathAbs)
        storedPath = relPosix(root, storedPathAbs)
      }

      const warnings = []
      let result
      try {
        result = await ingestPath({
          file: isUrl ? file : storedPathAbs ?? file,
          originalFile: file,
          sourceId,
          kindHint: kind,
          config,
          runtime,
          signal: exec?.signal,
        })
      } catch (error) {
        if (error instanceof LectureError) throw error
        throw new LectureError('INGEST_FAILED', `摄取失败：${error?.message ?? error}`, '检查文件是否损坏/受密码保护，或换一种格式')
      }
      if (!result || !Array.isArray(result.blocks) || !result.blocks.length) {
        throw new LectureError('EMPTY_DOCUMENT', '素材没有解析出任何内容', result?.warnings?.join('；') || '扫描版可先转成图片/PDF 再试')
      }

      const blocks = result.blocks
        .filter((b) => b && typeof b === 'object' && typeof b.id === 'string')
        .map((b, index) => ({
          id: String(b.id),
          page: Number.isInteger(b.page) ? b.page : null,
          section: b.section ?? null,
          kind: b.kind ?? 'text',
          text: String(b.text ?? ''),
          chars: Number.isInteger(b.chars) ? b.chars : String(b.text ?? '').length,
          confidence: b.confidence ?? 'high',
          needsVision: Boolean(b.needsVision),
          imageAssetId: b.imageAssetId ?? null,
          caption: b.caption ?? null,
          bbox: b.bbox ?? null,
          provenance: b.provenance ?? 'textlayer',
          hash: b.hash ?? null,
          index,
        }))
      const seen = new Set()
      for (const block of blocks) {
        if (seen.has(block.id)) throw new LectureError('DUPLICATE_BLOCK_ID', `摄取结果出现重复块 id：${block.id}`)
        seen.add(block.id)
      }

      const figures = []
      for (const figure of result.figures ?? []) {
        if (!figure?.data) {
          warnings.push(`第 ${figure?.page ?? '?'} 页的一张图没有字节内容，已跳过`)
          continue
        }
        try {
          const record = await registerAsset(root, {
            data: figure.data,
            type: figure.type,
            kind: 'extracted',
            caption: figure.caption ?? `取自 ${label} 第 ${figure.page ?? '?'} 页`,
            source: { sourceId, page: figure.page ?? null, imageIndex: figure.imageIndex ?? null },
          })
          figures.push(record)
        } catch (error) {
          warnings.push(`图片登记失败（第 ${figure.page ?? '?'} 页）：${error?.message ?? error}`)
        }
      }
      for (const block of blocks) {
        if (!block.imageAssetId && block.kind === 'figure') {
          const match = figures.find((f) => f.source?.page === block.page)
          if (match) block.imageAssetId = match.assetId
        }
      }

      const source = {
        schemaVersion: 1,
        sourceId,
        label,
        kind: result.kind ?? kind,
        origin: isUrl
          ? { url: file, path: null, storedPath: null, sha256: null, bytes: null, fetchedAt: new Date().toISOString() }
          : {
              path: file,
              storedPath,
              sha256: digest,
              bytes: result.bytes ?? null,
              mtime: null,
              fetchedAt: null,
            },
        structure: result.structure ?? {},
        blocks,
        lowTextPages: Array.isArray(result.lowTextPages) ? result.lowTextPages : [],
        figures: figures.map((f) => ({ assetId: f.assetId, file: f.file, page: f.source?.page ?? null })),
        metadata: result.metadata ?? {},
        warnings: [...(result.warnings ?? []), ...warnings],
        createdAt: new Date().toISOString(),
      }
      // 记录原始绝对路径，供视觉兜底栅格化使用（不写入 project.json）
      source.origin.storedPathAbs = isUrl ? null : storedPathAbs ?? file
      saveSource(root, source)

      const vision = await buildVisionQueue(config, runtime, root, source, exec?.signal)
      source.warnings.push(...vision.warnings)
      if (vision.queue.length) source.visionQueue = vision.queue
      saveSource(root, source)

      const allSources = loadSources(root)
      const coverage = computeCoverage(project, allSources, loadLedger(root))
      const byKind = summarizeBlocks(source)
      const lines = [
        `已摄取 ${sourceId}「${label}」（${source.kind}）：${blocks.length} 块`,
        `结构：${JSON.stringify(source.structure)}`,
        `块构成：${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join('，')}`,
        `图片：登记 ${figures.length} 张${figures.length ? `（${figures.slice(0, 6).map((f) => f.assetId).join(', ')}${figures.length > 6 ? ' …' : ''}）` : ''}`,
      ]
      if (source.lowTextPages.length) {
        lines.push(
          '',
          `⚠ 低文本页（可能是扫描页/公式图）：${source.lowTextPages.join(', ')}`,
          '这些页需要视觉兜底：先 read_image 看页图，再用 modlens_read_image 转写，最后 lecture_ingest action=attach-ocr 逐页回填（含公式）。',
        )
        if (vision.queue.length) {
          lines.push('页图：', ...vision.queue.map((q) => `- p.${q.page}: ${q.image}`))
        }
      }
      if (source.warnings.length) lines.push('', '警告：', ...source.warnings.slice(0, 8).map((w) => `- ${w}`))
      lines.push(
        '',
        `全部来源：${allSources.map((s) => `${s.sourceId}(${s.blocks.length})`).join('，')}｜累计 ${coverage.total} 块，已覆盖 ${coverage.covered + coverage.merged}`,
        '下一步：lecture_ledger action=next 取块 → 规划章节并写 lecture.md → claim-batch 回填。',
      )
      return ok(withWarnings(lines.join('\n'), vision.warnings), {
        sourceId,
        label,
        kind: source.kind,
        blockCount: blocks.length,
        blocks: blocks.length,
        structure: source.structure,
        lowTextPages: source.lowTextPages,
        visionQueue: vision.queue,
        figures: figures.map((f) => ({ assetId: f.assetId, file: f.file, page: f.source?.page ?? null })),
        warnings: source.warnings,
        coverage,
        sources: allSources.map((s) => ({ sourceId: s.sourceId, label: s.label, kind: s.kind, blocks: s.blocks.length })),
      })
    }),
  }
}

