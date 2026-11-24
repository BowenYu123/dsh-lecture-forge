// LectureForge — 素材摄取统一入口：探测类型、分派解析、生成可追溯 blocks。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS } from '../config.mjs'
import { LectureError } from '../projects.mjs'
import { detectKind, sniffImage } from './detect.mjs'
import { parseDocx } from './docx.mjs'
import { parseHtml } from './html.mjs'
import { parseMarkdown } from './md.mjs'
import { parsePdf } from './pdf.mjs'
import { parsePptx } from './pptx.mjs'
import { parseUrl } from './url.mjs'

const TEXT_TARGET = 2000
const TEXT_MIN = 60
const TEXT_HARD = 4000
const FIGURE_MIN_BYTES = 4096
const FIGURE_MAX_BYTES = 20 * 1024 * 1024
const FIGURE_MIN_SIDE = 80
const FIGURE_LIMIT = 80

/**
 * 摄取一个本地文件或网页，返回结构化素材（不写磁盘登记）。
 * @param {{file:string, sourceId:string, kindHint?:string|null, config?:object,
 *   runtime?:object|null, signal?:AbortSignal|null}} input
 */
export async function ingestPath({
  file,
  sourceId,
  kindHint = null,
  config = {},
  runtime = null,
  signal = null,
} = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const prefix = normalizeSourceId(sourceId)
  const rawFile = String(file ?? '').trim()
  if (!rawFile) {
    throw new LectureError('FILE_REQUIRED', '没有提供要摄取的素材路径。')
  }
  if (signal?.aborted) throw new LectureError('ABORTED', '素材摄取已取消。')

  const warnings = []
  let parsed
  let kind
  let label

  if (/^https?:\/\//i.test(rawFile)) {
    kind = 'url'
    label = labelForUrl(rawFile)
    parsed = await parseUrl({ url: rawFile, config: cfg, warnings, signal })
  } else {
    const buffer = await readLocalFile(rawFile, cfg)
    kind = detectKind({ file: rawFile, buffer, kindHint })
    label = path.basename(rawFile)
    const baseDir = path.dirname(path.resolve(rawFile))
    try {
      if (kind === 'pdf') {
        parsed = await parsePdf({ file: rawFile, config: cfg, runtime, signal, warnings })
      } else if (kind === 'docx') {
        parsed = parseDocx({ buffer, file: rawFile, warnings })
      } else if (kind === 'pptx') {
        parsed = parsePptx({ buffer, file: rawFile, warnings })
      } else if (kind === 'html') {
        parsed = await parseHtml({
          html: buffer.toString('utf8'),
          file: rawFile,
          baseDir,
          baseUrl: null,
          warnings,
          signal,
        })
      } else if (kind === 'md' || kind === 'txt') {
        parsed = parseMarkdown({ buffer, file: rawFile, kind, warnings })
      } else {
        throw new LectureError('UNSUPPORTED_FORMAT', `暂不支持的素材类型：${kind}`)
      }
    } catch (error) {
      if (error instanceof LectureError) throw error
      throw new LectureError(
        'PARSE_FAILED',
        `${kind.toUpperCase()} 解析失败：${String(error?.message ?? error)}`,
        '请确认文件未损坏；也可以尝试另存或转换格式后重试。',
      )
    }
  }

  if (signal?.aborted) throw new LectureError('ABORTED', '素材摄取已取消。')

  const figures = finalizeFigures(parsed.figures, warnings)
  const units = Array.isArray(parsed.units) ? [...parsed.units] : []

  if (kind === 'pdf') {
    for (const figure of figures) {
      if (figure.page === null) continue
      units.push({
        page: figure.page,
        section: null,
        kind: 'figure',
        text: figure.caption || `[图 ${figure.imageIndex + 1}]`,
      })
    }
    units.sort((a, b) => (a.page ?? 0) - (b.page ?? 0))
  }

  const lowTextPages = Array.isArray(parsed.lowTextPages)
    ? [...new Set(parsed.lowTextPages.filter((page) => Number.isFinite(page)))].sort((a, b) => a - b)
    : []
  const lowSet = new Set(lowTextPages)
  const blocks = buildBlocks({ units, prefix, kind, lowSet })
  const structure = normalizeStructure(kind, parsed, blocks)
  const metadata = normalizeMetadata(parsed.metadata, structure)

  if (blocks.length === 0 && figures.length === 0 && !hasScanWarning(warnings)) {
    warnings.push('未从素材中提取到可用的文本或图片内容。')
  }

  return {
    kind,
    label,
    structure,
    blocks,
    figures,
    lowTextPages,
    metadata,
    warnings: [...new Set(warnings)],
  }
}

async function readLocalFile(file, cfg) {
  const absolute = path.resolve(file)
  let stat
  try {
    stat = await fs.promises.stat(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new LectureError('FILE_NOT_FOUND', `找不到素材文件：${file}`, '请确认路径是否正确。')
    }
    throw new LectureError(
      'FILE_UNREADABLE',
      `无法读取素材文件：${file}（${String(error?.message ?? error)}）`,
      '请检查文件权限后重试。',
    )
  }
  if (!stat.isFile()) {
    throw new LectureError('NOT_A_FILE', `素材路径不是文件：${file}`, '请选择单个文件，而不是目录。')
  }
  const limit = Number.isFinite(cfg.maxFileBytes) ? cfg.maxFileBytes : DEFAULTS.maxFileBytes
  if (stat.size > limit) {
    throw new LectureError(
      'FILE_TOO_LARGE',
      `素材文件超过大小上限（${formatMegabytes(limit)}）：${file}`,
      '请压缩或拆分文件后重试，或在配置里调大 maxFileBytes。',
    )
  }
  try {
    return await fs.promises.readFile(absolute)
  } catch (error) {
    throw new LectureError(
      'FILE_UNREADABLE',
      `无法读取素材文件：${file}（${String(error?.message ?? error)}）`,
      '请检查文件权限后重试。',
    )
  }
}

function normalizeSourceId(sourceId) {
  const value = String(sourceId ?? '').trim()
  if (!value) {
    throw new LectureError('SOURCE_ID_REQUIRED', '缺少来源编号 sourceId。')
  }
  const match = /^S(\d+)$/i.exec(value)
  if (match) return `S${match[1].padStart(2, '0')}`
  return value
}

function labelForUrl(value) {
  try {
    const url = new URL(value)
    const last = url.pathname.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
    return url.hostname || value
  } catch {
    return value
  }
}

function normalizeMetadata(metadata, structure) {
  const result = { ...(metadata ?? {}) }
  if (structure.pages !== undefined) result.pages = structure.pages
  if (structure.slides !== undefined) result.slides = structure.slides
  return result
}

function normalizeStructure(kind, parsed, blocks) {
  const source = parsed.structure ?? {}
  const maxSection = blocks.reduce(
    (max, block) => (block.section !== null ? Math.max(max, block.section) : max),
    0,
  )
  if (kind === 'pdf') {
    return { pages: Number.isFinite(source.pages) ? source.pages : countPages(blocks) }
  }
  if (kind === 'pptx') {
    const slides = Number.isFinite(source.slides) ? source.slides : maxSection
    return { slides, sections: slides }
  }
  const sections = Math.max(
    Number.isFinite(source.sections) ? source.sections : 0,
    maxSection,
    blocks.length > 0 ? 1 : 0,
  )
  return { sections }
}

function countPages(blocks) {
  const pages = new Set()
  for (const block of blocks) if (block.page !== null) pages.add(block.page)
  return pages.size
}

function hasScanWarning(warnings) {
  return warnings.some((warning) => /疑似扫描件|视觉兜底/.test(warning))
}

function finalizeFigures(rawFigures, warnings) {
  const figures = []
  const seen = new Set()
  let unreadable = 0
  let capped = false
  for (const raw of Array.isArray(rawFigures) ? rawFigures : []) {
    if (!raw || !raw.data) continue
    const data = Buffer.isBuffer(raw.data) ? raw.data : Buffer.from(raw.data)
    if (data.length < FIGURE_MIN_BYTES) continue
    if (data.length > FIGURE_MAX_BYTES) {
      warnings.push('有一张内嵌图片超过 20MB，已跳过。')
      continue
    }
    const info = sniffImage(data)
    if (!info.type) {
      unreadable += 1
      continue
    }
    const width = Number.isFinite(raw.width) ? raw.width : info.width
    const height = Number.isFinite(raw.height) ? raw.height : info.height
    if ((width !== null && width < FIGURE_MIN_SIDE) || (height !== null && height < FIGURE_MIN_SIDE)) {
      continue
    }
    const digest = crypto.createHash('sha256').update(data).digest('hex')
    if (seen.has(digest)) continue
    seen.add(digest)
    if (figures.length >= FIGURE_LIMIT) {
      capped = true
      break
    }
    const caption = typeof raw.caption === 'string' ? raw.caption.trim() : ''
    figures.push({
      page: Number.isFinite(raw.page) ? raw.page : null,
      imageIndex: figures.length,
      type: info.type,
      data,
      width,
      height,
      ...(caption ? { caption } : {}),
    })
  }
  if (unreadable > 0) warnings.push(`有 ${unreadable} 张图片格式无法识别，已跳过。`)
  if (capped) warnings.push(`内嵌图片超过 ${FIGURE_LIMIT} 张，其余已跳过。`)
  return figures
}

function buildBlocks({ units, prefix, kind, lowSet }) {
  const blocks = []
  let blockNumber = 0
  let pending = []
  let pendingContext = null
  let currentContext = null

  const flush = () => {
    if (pending.length === 0) return
    const merged = mergeTextUnits(pending)
    for (const text of merged) {
      pushBlock('text', text, pendingContext)
    }
    pending = []
    pendingContext = null
  }

  const pushBlock = (blockKind, text, context) => {
    const chunks = blockKind === 'text' ? [text] : splitLongText(text, TEXT_HARD)
    for (const chunk of chunks) {
      const value = String(chunk ?? '').trim()
      if (!value) continue
      blockNumber += 1
      const page = context?.page ?? null
      const section = page === null ? context?.section ?? 1 : null
      const location =
        page !== null
          ? `p${String(page).padStart(3, '0')}`
          : `s${String(section).padStart(2, '0')}`
      const low = page !== null && lowSet.has(page)
      blocks.push({
        id: `${prefix}#${location}-b${String(blockNumber).padStart(2, '0')}`,
        page,
        section,
        kind: blockKind,
        text: value,
        chars: value.length,
        confidence: low ? 'low' : 'high',
        needsVision: low,
        provenance: kind === 'pdf' ? 'textlayer' : 'native',
        imageAssetId: null,
      })
    }
  }

  for (const unit of units) {
    if (!unit || unit.text === undefined || unit.text === null) continue
    const text = String(unit.text)
    if (!text.trim()) continue
    const page = Number.isFinite(unit.page) ? unit.page : null
    const section = page === null ? (Number.isFinite(unit.section) ? unit.section : 1) : null
    const contextKey = page !== null ? `p:${page}` : `s:${section}`
    if (contextKey !== currentContext) {
      flush()
      currentContext = contextKey
    }
    const blockKind = normalizeBlockKind(unit.kind)
    if (blockKind === 'text') {
      if (!pendingContext) pendingContext = { page, section }
      pending.push(text)
    } else {
      flush()
      pushBlock(blockKind, text, { page, section })
    }
  }
  flush()
  return blocks
}

function normalizeBlockKind(kind) {
  const allowed = new Set(['text', 'heading', 'formula', 'figure', 'table', 'code', 'caption'])
  return allowed.has(kind) ? kind : 'text'
}

function mergeTextUnits(texts) {
  const pieces = []
  for (const text of texts) {
    for (const chunk of splitLongText(text, TEXT_TARGET)) pieces.push(chunk)
  }
  const merged = []
  let current = ''
  for (const piece of pieces) {
    if (!current) {
      current = piece
      continue
    }
    const joined = `${current}\n\n${piece}`
    if (joined.length <= TEXT_TARGET) {
      current = joined
      continue
    }
    if ((current.length < TEXT_MIN || piece.length < TEXT_MIN) && joined.length <= TEXT_HARD) {
      current = joined
      continue
    }
    merged.push(current)
    current = piece
  }
  if (current) merged.push(current)
  return merged
}

function splitLongText(text, limit) {
  const source = String(text ?? '').trim()
  if (!source) return []
  const chunks = []
  let rest = source
  while (rest.length > limit) {
    let cut = limit
    const newline = rest.lastIndexOf('\n', limit)
    if (newline > Math.floor(limit * 0.6)) cut = newline
    else {
      const space = rest.lastIndexOf(' ', limit)
      if (space > Math.floor(limit * 0.6)) cut = space
    }
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks.filter(Boolean)
}

function formatMegabytes(bytes) {
  return `${Math.round(bytes / 1024 / 1024)}MB`
}
