// LectureForge — 确定性审计：覆盖、来源标记、澄清标注、图、公式、引用、notebook、QA。
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { readJson, exists } from './paths.mjs'
import { imageSize } from './assets.mjs'

const CALL_KINDS = ['note', 'warn', 'clarify', 'derive', 'example', 'check', 'tip', 'key']

function pushError(ctx, code, message, extra = {}) {
  if (ctx.errors.length >= 500) {
    ctx.truncated = true
    return
  }
  ctx.errors.push({ code, message, ...extra })
}

function pushWarning(ctx, code, message, extra = {}) {
  if (ctx.warnings.length >= 300) return
  ctx.warnings.push({ code, message, ...extra })
}

function normalizeId(value) {
  return String(value ?? '')
    .trim()
    .replace(/^#/, '')
}

function buildSectionIndex(analysis) {
  const sections = (analysis?.sections ?? []).filter((s) => s && typeof s === 'object')
  const byId = new Map()
  for (const section of sections) {
    if (section.id) byId.set(normalizeId(section.id), section)
  }
  return { sections, byId }
}

function sectionRange(sections, index) {
  const start = sections[index]?.line ?? 0
  const end = sections[index + 1]?.line ?? Number.POSITIVE_INFINITY
  return { start, end }
}

function resolveSectionIds(analysis, refs, ctx, where) {
  const { sections, byId } = buildSectionIndex(analysis)
  const out = []
  for (const ref of refs ?? []) {
    const id = normalizeId(ref)
    if (!id) continue
    if (byId.has(id)) {
      out.push(normalizeId(byId.get(id).id))
      continue
    }
    const byTitle = sections.find((s) => String(s.title ?? '').trim() === String(ref).trim())
    if (byTitle?.id) {
      out.push(normalizeId(byTitle.id))
      continue
    }
    pushError(ctx, 'UNKNOWN_SECTION', `${where}: 章节不存在：${ref}`, { section: ref })
  }
  return [...new Set(out)]
}

function markerMatchesBlock(marker, sourceId, block) {
  if (!marker || marker.sourceId !== sourceId) return false
  if (block.page != null) return marker.kind === 'page' && Number(marker.page) === Number(block.page)
  if (block.section != null) return marker.kind === 'section' && String(marker.section) === String(block.section)
  return marker.kind === 'page' || marker.kind === 'section'
}

function markerInSection(marker, range) {
  return typeof marker.line === 'number' && marker.line >= range.start && marker.line < range.end
}

function calloutInSection(callout, range) {
  return typeof callout.line === 'number' && callout.line >= range.start && callout.line < range.end
}

function calloutMarkers(callout) {
  const list = []
  for (const marker of callout?.markers ?? []) {
    if (typeof marker === 'string') {
      const m = /\[([A-Z]\d+)\s*,\s*(?:p\.|p|§)\s*([^\]]+)\]/i.exec(marker)
      if (m) list.push({ sourceId: m[1].toUpperCase(), raw: m[0], page: null, section: null })
      continue
    }
    list.push(marker)
  }
  return list
}

function auditCoverage(ctx) {
  const { project, sources, ledger } = ctx
  const ledgerBlocks = ledger?.blocks ?? {}
  for (const source of sources) {
    for (const block of source.blocks ?? []) {
      const record = ledgerBlocks[block.id]
      if (!record || !record.status || record.status === 'pending') {
        pushError(ctx, 'UNMAPPED_BLOCK', `素材块未映射到讲义：${block.id}（${source.sourceId}）`, {
          blockId: block.id,
          sourceId: source.sourceId,
          page: block.page ?? null,
        })
      }
    }
  }
  for (const [blockId, record] of Object.entries(ledgerBlocks)) {
    if (!ctx.blockIndex.has(blockId)) {
      pushError(ctx, 'UNKNOWN_LEDGER_BLOCK', `账本里有素材中不存在的块：${blockId}`, { blockId })
    }
    if (!record) continue
    if (record.status === 'merged') {
      const targetId = record.mergeInto
      if (!targetId) {
        pushError(ctx, 'MISSING_MERGE_TARGET', `merged 块缺少 mergeInto：${blockId}`, { blockId })
      } else if (targetId === blockId) {
        pushError(ctx, 'SELF_MERGE', `块不能 merged 到自己：${blockId}`, { blockId })
      } else {
        const target = ledgerBlocks[targetId]
        if (!target || target.status !== 'covered') {
          pushError(ctx, 'MERGE_TARGET_NOT_COVERED', `merged 目标未覆盖：${blockId} → ${targetId}`, { blockId })
        } else if (!(record.sections ?? []).some((s) => (target.sections ?? []).includes(s))) {
          pushError(ctx, 'MERGE_TARGET_SECTION', `merged 块与目标的章节不一致：${blockId} → ${targetId}`, { blockId })
        }
      }
    }
    if (record.status === 'blocked' && !String(record.reason ?? '').trim()) {
      pushError(ctx, 'BLOCKED_WITHOUT_REASON', `blocked 块缺少原因：${blockId}`, { blockId })
    }
  }
}

function auditSectionsAndMarkers(ctx) {
  const { analysis, sources } = ctx
  const sections = analysis?.sections ?? []
  const seen = new Set()
  for (const section of sections) {
    const id = normalizeId(section.id)
    if (!id) {
      pushError(ctx, 'MISSING_SECTION_ID', `章节「${section.title}」缺少 {#sec-id}`, { line: section.line })
      continue
    }
    if (seen.has(id)) pushError(ctx, 'DUPLICATE_SECTION_ID', `章节 id 重复：${id}`, { section: id })
    seen.add(id)
    if (section.level !== undefined && section.level !== null && section.level < 1) {
      pushWarning(ctx, 'SECTION_LEVEL', `章节层级异常：${id}`)
    }
  }
  if (!sections.length) pushError(ctx, 'NO_SECTIONS', '.lecture/lecture.md 里没有可识别的章节标题')

  const sourceMap = new Map(sources.map((s) => [s.sourceId, s]))
  for (const marker of analysis?.markers ?? []) {
    const sourceId = marker?.sourceId
    if (!sourceId) continue
    const source = sourceMap.get(sourceId)
    if (!source) {
      pushError(ctx, 'UNKNOWN_SOURCE_MARKER', `来源标记引用了不存在的来源：${marker.raw ?? sourceId}`, {
        sourceId,
        line: marker.line,
      })
      continue
    }
    if (marker.kind === 'page') {
      const pages = source.structure?.pages ?? Math.max(0, ...(source.blocks ?? []).map((b) => b.page ?? 0))
      if (!Number.isInteger(Number(marker.page)) || Number(marker.page) < 1) {
        pushError(ctx, 'INVALID_PAGE_MARKER', `页码标记非法：${marker.raw}`, { sourceId, line: marker.line })
      } else if (pages && Number(marker.page) > pages) {
        pushError(ctx, 'PAGE_OUT_OF_RANGE', `页码超出范围：${marker.raw}（共 ${pages} 页）`, {
          sourceId,
          page: marker.page,
          line: marker.line,
        })
      }
    } else if (marker.kind === 'section') {
      const known = source.structure?.sections
      if (Array.isArray(known) && known.length) {
        const ids = new Set(known.map((s) => String(s?.id ?? s?.number ?? s).trim()))
        if (!ids.has(String(marker.section).trim())) {
          pushWarning(ctx, 'SECTION_MARKER_UNKNOWN', `章节标记可能超出范围：${marker.raw}`, { sourceId, line: marker.line })
        }
      }
    } else if (marker.kind === 'time') {
      pushError(ctx, 'UNSUPPORTED_TIME_MARKER', `本版本不支持视频时间标记：${marker.raw}`, { sourceId, line: marker.line })
    } else {
      pushError(ctx, 'INVALID_MARKER', `来源标记格式不合法：${marker.raw}`, { sourceId, line: marker.line })
    }
  }
}

function auditBlockClaims(ctx) {
  const { analysis, ledger } = ctx
  const sections = analysis?.sections ?? []
  const { byId } = buildSectionIndex(analysis)
  const sectionPos = new Map(sections.map((s, i) => [normalizeId(s.id), i]))
  const markers = analysis?.markers ?? []
  for (const [blockId, record] of Object.entries(ledger?.blocks ?? {})) {
    if (!record || !record.status || record.status === 'pending') continue
    const entry = ctx.blockIndex.get(blockId)
    if (!entry) continue
    const { source, block } = entry
    const sectionIds = resolveSectionIds(analysis, record.sections, ctx, `块 ${blockId}`)
    if (record.status === 'covered' && sectionIds.length === 0) {
      pushError(ctx, 'COVERED_WITHOUT_SECTION', `covered 块没有有效章节：${blockId}`, { blockId })
      continue
    }
    if (record.status !== 'covered') continue
    // 每个 covered 块在同章节范围内必须有指向该来源该页的标记
    const ranges = sectionIds
      .map((id) => sectionPos.get(id))
      .filter((i) => i !== undefined)
      .map((i) => sectionRange(sections, i))
    const okMarker = markers.some((marker) => markerMatchesBlock(marker, source.sourceId, block) && ranges.some((r) => markerInSection(marker, r)))
    if (!okMarker) {
      const where = block.page != null ? `[${source.sourceId}, p.${block.page}]` : `[${source.sourceId}, §${block.section ?? '?'}]`
      pushError(ctx, 'MISSING_SOURCE_MARKER', `块 ${blockId} 声明已覆盖，但对应章节里没有来源标记 ${where}`, {
        blockId,
        sourceId: source.sourceId,
        page: block.page ?? null,
        hint: `在相关段落末尾加上 ${where}`,
      })
    }
  }
}

function auditClarifications(ctx) {
  const { analysis, ledger } = ctx
  const sections = analysis?.sections ?? []
  const callouts = (analysis?.callouts ?? []).filter((c) => CALL_KINDS.includes(String(c.kind ?? '').toLowerCase()))
  const clarifyCallouts = callouts.filter((c) => String(c.kind).toLowerCase() === 'clarify')
  const sectionPos = new Map(sections.map((s, i) => [normalizeId(s.id), i]))
  const claimsBySection = new Map()
  for (const [blockId, record] of Object.entries(ledger?.blocks ?? {})) {
    if (!record || record.status !== 'covered') continue
    if (!(record.kinds ?? []).includes('clarification')) continue
    for (const section of record.sections ?? []) {
      const key = normalizeId(section)
      if (!claimsBySection.has(key)) claimsBySection.set(key, [])
      claimsBySection.get(key).push({ blockId, sourceId: ctx.blockIndex.get(blockId)?.source.sourceId, block: ctx.blockIndex.get(blockId)?.block })
    }
  }
  // 正向：clarification 块所在章节必须有 CLARIFY 标注，且标注内带同来源同页标记
  for (const [sectionId, claims] of claimsBySection) {
    const pos = sectionPos.get(sectionId)
    if (pos === undefined) continue
    const range = sectionRange(sections, pos)
    for (const claim of claims) {
      const inSection = clarifyCallouts.filter((c) => calloutInSection(c, range))
      const matched = inSection.some((callout) =>
        calloutMarkers(callout).some((marker) => {
          if (marker.sourceId !== claim.sourceId) return false
          if (claim.block?.page != null) return Number(marker.page) === Number(claim.block.page)
          return true
        }),
      )
      if (!matched) {
        pushError(
          ctx,
          'CLARIFY_CALLOUT_MISSING',
          `块 ${claim.blockId} 标为 clarification，但章节 ${sectionId} 里没有带该来源页码标记的 [!CLARIFY] 解释块`,
          { blockId: claim.blockId, section: sectionId },
        )
      }
    }
  }
  // 反向：每个 CLARIFY 标注必须对应一个 clarification 块
  for (const callout of clarifyCallouts) {
    const pos = sections.findIndex((_s, i) => calloutInSection(callout, sectionRange(sections, i)))
    const sectionId = pos >= 0 ? normalizeId(sections[pos].id) : null
    const claims = sectionId ? claimsBySection.get(sectionId) ?? [] : []
    const markers = calloutMarkers(callout)
    const matched = claims.some((claim) =>
      markers.some((marker) => {
        if (marker.sourceId !== claim.sourceId) return false
        if (claim.block?.page != null) return Number(marker.page) === Number(claim.block.page)
        return true
      }),
    )
    if (!matched) {
      pushError(ctx, 'CLARIFY_WITHOUT_BLOCK', `[!CLARIFY] 解释块（第 ${callout.line} 行）没有对应的 clarification 素材块`, {
        line: callout.line,
        section: sectionId,
      })
    }
  }
}

function auditSupplements(ctx) {
  const buckets = ctx.project?.brief?.supplementary ?? []
  if (!buckets.length) return
  const text = String(ctx.mdText ?? '').toLowerCase()
  for (const bucket of buckets) {
    const needle = String(bucket).trim().toLowerCase()
    if (!needle) continue
    if (!text.includes(needle)) {
      pushError(ctx, 'SUPPLEMENT_MISSING', `brief 要求补充的内容没有出现：「${bucket}」`, {
        supplement: bucket,
        hint: `在正文写一个标注块，如 > [!NOTE] 补充：${bucket}，并在其中给出具体内容`,
      })
    }
  }
}

function figureProvenanceError(figure, config) {
  if (!figure.source || typeof figure.source !== 'object') return '缺少来源信息'
  if (figure.kind === 'extracted') {
    if (!figure.source.sourceId || figure.source.page == null) return '抽取图缺少 sourceId/page'
    return null
  }
  if (figure.kind === 'web') {
    if (!figure.source.url) return '外部图缺少 url'
    if (config.strictLicensing) {
      if (!figure.source.license) return '外部图缺少 license（strictLicensing=true）'
      if (!figure.source.author) return '外部图缺少 author（strictLicensing=true）'
    }
    return null
  }
  if (figure.kind === 'plot') {
    if (!figure.source.spec) return '代码图缺少 spec（无法复现）'
    return null
  }
  if (figure.kind === 'svg') {
    if (!figure.source.agentAuthored) return '示意图缺少 agentAuthored 标记'
    return null
  }
  return `未知图类型：${figure.kind}`
}

function auditFigures(ctx) {
  const { analysis, figuresData, projectDir } = ctx
  const assets = new Map((figuresData?.assets ?? []).map((a) => [a.assetId, a]))
  const referenced = new Set()
  for (const figure of analysis?.figures ?? []) {
    const assetId = normalizeId(figure.assetId ?? figure.id)
    if (!assetId) continue
    referenced.add(assetId)
    const record = assets.get(assetId)
    if (!record) {
      pushError(ctx, 'FIGURE_UNREGISTERED', `正文引用了未登记的图片：${assetId}`, { assetId, line: figure.line })
      continue
    }
    const abs = path.join(projectDir, '.lecture', record.file)
    if (!exists(abs)) {
      pushError(ctx, 'FIGURE_FILE_MISSING', `图片文件不存在：${record.file}`, { assetId })
      continue
    }
    const reason = figureProvenanceError(record, ctx.config)
    if (reason) pushError(ctx, 'FIGURE_PROVENANCE', `${assetId}：${reason}`, { assetId })
    if (record.width && record.height) {
      try {
        imageSize(readBytes(abs), record.type)
      } catch (error) {
        pushWarning(ctx, 'FIGURE_IMAGE_INVALID', `${assetId} 图片头解析失败：${error?.message ?? error}`, { assetId })
      }
    }
  }
  for (const record of figuresData?.assets ?? []) {
    if (!referenced.has(record.assetId)) {
      pushWarning(ctx, 'FIGURE_UNUSED', `图片 ${record.assetId} 已登记但正文未引用`, { assetId: record.assetId })
    }
  }
}

function readBytes(file) {
  return exists(file) ? readFileSync(file) : Buffer.alloc(0)
}

function inferRefKind(target) {
  if (target.startsWith('fig-')) return 'figure'
  if (target.startsWith('sec-')) return 'section'
  if (target.startsWith('eq-')) return 'equation'
  return ''
}

function auditRefs(ctx) {
  const { analysis } = ctx
  const sectionIds = new Set((analysis?.sections ?? []).map((s) => normalizeId(s.id)).filter(Boolean))
  const figureIds = new Set(
    (analysis?.figures ?? [])
      .flatMap((f) => [normalizeId(f.assetId), normalizeId(f.id)])
      .filter(Boolean),
  )
  const equationIds = new Set((analysis?.equations ?? []).map((e) => normalizeId(e.id)).filter(Boolean))
  for (const ref of analysis?.refs ?? []) {
    const target = normalizeId(ref.target ?? ref.assetId ?? ref.id)
    const raw = ref.raw ?? `[@${target}]`
    if (!target) continue
    // markdown.mjs 的 refs 只带 target/line，按目标前缀推断类型。
    const kind = String(ref.kind ?? inferRefKind(target)).toLowerCase()
    if (kind === 'fig' || kind === 'figure') {
      if (!figureIds.has(target)) pushError(ctx, 'BROKEN_REF', `图片引用无法解析：${raw}`, { line: ref.line })
    } else if (kind === 'sec' || kind === 'section') {
      if (!sectionIds.has(target)) pushError(ctx, 'BROKEN_REF', `章节引用无法解析：${raw}`, { line: ref.line })
    } else if (kind === 'eq' || kind === 'equation') {
      if (!equationIds.has(target)) pushError(ctx, 'BROKEN_REF', `公式引用无法解析：${raw}`, { line: ref.line })
    } else {
      pushWarning(ctx, 'UNKNOWN_REF', `未知交叉引用类型：${raw}`, { line: ref.line })
    }
  }
}

function auditMathErrors(ctx) {
  for (const error of ctx.mathErrors ?? []) {
    pushError(ctx, 'MATH_ERROR', `公式解析失败（第 ${error.line ?? '?'} 行）：${error.message}`, {
      tex: String(error.tex ?? '').slice(0, 400),
      line: error.line,
    })
  }
}

function auditVision(ctx) {
  const { sources, ledger } = ctx
  const pending = []
  for (const source of sources) {
    for (const page of source.lowTextPages ?? []) {
      const ocrBlocks = (source.blocks ?? []).filter((b) => b.page === page && (b.kind === 'ocr' || b.provenance === 'vision'))
      if (!ocrBlocks.length) {
        pending.push(`${source.sourceId}#p${page}（缺 OCR 块）`)
        continue
      }
      const reviewed = ocrBlocks.some((block) => {
        const record = ledger?.blocks?.[block.id]
        return record && record.status !== 'pending' && record.reviewed === true
      })
      if (!reviewed) pending.push(`${source.sourceId}#p${page}（OCR 未复核/未映射）`)
    }
  }
  for (const item of pending) {
    pushError(ctx, 'VISION_UNREVIEWED', `低文本页需要视觉兜底并复核：${item.split('（')[0]}`, { detail: item })
  }
}

function auditNotebook(ctx) {
  if (!ctx.formats.includes('ipynb')) return
  const report = ctx.buildReport
  const nb = report?.notebook
  if (!nb) {
    pushError(ctx, 'NOTEBOOK_NOT_BUILT', '要求 ipynb 但没有构建记录', { hint: 'lecture_build formats 里加 ipynb 并确保执行成功' })
    return
  }
  if (nb.failed > 0 || nb.executed !== nb.codeCells) {
    pushError(ctx, 'NOTEBOOK_FAILED', `Notebook 未全部执行成功：${nb.executed}/${nb.codeCells}，失败 ${nb.failed}`, {
      executed: nb.executed,
      codeCells: nb.codeCells,
      failed: nb.failed,
    })
  }
  const abs = path.join(ctx.projectDir, 'out', 'lecture.ipynb')
  if (!exists(abs)) pushError(ctx, 'NOTEBOOK_MISSING', 'out/lecture.ipynb 不存在')
}

function auditPdf(ctx) {
  if (!ctx.formats.includes('pdf')) return
  const report = ctx.buildReport
  if (!report?.pdf?.file) {
    pushError(ctx, 'PDF_NOT_BUILT', '要求 pdf 但没有构建记录', { hint: 'lecture_build formats 里加 pdf' })
    return
  }
  const abs = path.join(ctx.projectDir, report.pdf.file)
  if (!exists(abs)) {
    pushError(ctx, 'PDF_MISSING', `PDF 不存在：${report.pdf.file}`)
    return
  }
  if (!report.pdf.pageCount || report.pdf.pageCount < 1) {
    pushError(ctx, 'PDF_EMPTY', 'PDF 页数为 0')
  }
  const qa = report.qa?.pages ?? []
  if (!qa.length) {
    pushError(ctx, 'QA_MISSING', '没有生成 QA 页面图（无法做视觉检查）', {
      hint: '确认 DSH 内置运行时含 node 与 LibreOffice 引擎，或配置 libreOfficeKitCli；再看 out/build-report.json 的 warnings。',
    })
  } else {
    for (const page of qa) {
      if (!exists(path.join(ctx.projectDir, page.file ?? ''))) {
        pushError(ctx, 'QA_PAGE_MISSING', `QA 页图不存在：${page.file}`)
        break
      }
    }
  }
}

function auditReview(ctx) {
  const review = readJson(path.join(ctx.projectDir, '.lecture', 'review.json'), null)
  if (!review || !String(review.notes ?? '').trim()) {
    pushError(ctx, 'REVIEW_REQUIRED', '缺少独立语义复核记录 .lecture/review.json', {
      hint: '让另一个 subagent 审阅讲义并调用 lecture_audit action=record-review 记录结论',
    })
  }
}

/** 结构 + 语义前置审计；level=full 时再检查构建物与复核记录。 */
export function runAudit(input) {
  const ctx = {
    ...input,
    formats: Array.isArray(input.formats) && input.formats.length ? input.formats : input.project?.formats ?? ['pdf'],
    errors: [],
    warnings: [],
    truncated: false,
    blockIndex: input.blockIndex ?? new Map(),
  }
  auditCoverage(ctx)
  auditSectionsAndMarkers(ctx)
  auditBlockClaims(ctx)
  auditClarifications(ctx)
  auditSupplements(ctx)
  auditFigures(ctx)
  auditRefs(ctx)
  auditMathErrors(ctx)
  auditVision(ctx)
  if (String(input.level ?? 'structure') === 'full') {
    auditNotebook(ctx)
    auditPdf(ctx)
    auditReview(ctx)
  }
  const stats = {
    blocks: ctx.blockIndex.size,
    sections: (ctx.analysis?.sections ?? []).length,
    markers: (ctx.analysis?.markers ?? []).length,
    callouts: (ctx.analysis?.callouts ?? []).length,
    figures: (ctx.figuresData?.assets ?? []).length,
    referencedFigures: (ctx.analysis?.figures ?? []).length,
    equations: (ctx.analysis?.equations ?? []).length,
    level: input.level ?? 'structure',
  }
  return {
    ok: ctx.errors.length === 0,
    errors: ctx.errors.slice(0, 300),
    warnings: ctx.warnings.slice(0, 200),
    errorCount: ctx.errors.length + (ctx.truncated ? 1 : 0),
    warningCount: ctx.warnings.length,
    truncated: ctx.truncated,
    stats,
  }
}
