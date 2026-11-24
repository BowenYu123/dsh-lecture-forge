// LectureForge — DOCX 解析（自实现 zip 读取，不依赖外部库）。
import path from 'node:path'
import { LectureError } from '../projects.mjs'
import { decodeEntities, readZipEntries, sniffImage } from './detect.mjs'

const IMAGE_MIN_BYTES = 4096
const IMAGE_MAX_BYTES = 20 * 1024 * 1024

/**
 * @param {{buffer:Buffer, file?:string|null, warnings?:string[]}} input
 */
export function parseDocx({ buffer, file = null, warnings = [] } = {}) {
  let entries
  try {
    entries = readZipEntries(buffer)
  } catch (error) {
    throw new LectureError(
      'DOCX_INVALID',
      `无法解析 DOCX（zip 结构损坏）：${String(error?.message ?? error)}`,
      '请确认文件是有效的 .docx，而不是改过扩展名的旧版 .doc 或损坏文件。',
    )
  }
  const documentEntry = entries.get('word/document.xml')
  if (!documentEntry) {
    throw new LectureError(
      'DOCX_INVALID',
      'DOCX 缺少 word/document.xml，可能不是有效的 Word 文档。',
      '请用 Word/WPS 重新另存为 .docx 后再试。',
    )
  }
  const xml = documentEntry.toString('utf8')
  const bodyMatch = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/i.exec(xml)
  const body = bodyMatch ? bodyMatch[1] : xml

  const units = []
  const figures = []
  let section = 0
  let lastSection = 1

  const relTargets = docxRelations(entries)
  const usedMedia = new Set()

  const addFigure = (mediaName, caption, activeSection) => {
    const entry = entries.get(mediaName)
    if (!entry) {
      warnings.push(`DOCX 引用的图片不存在：${mediaName}`)
      return
    }
    if (usedMedia.has(mediaName)) return
    usedMedia.add(mediaName)
    if (entry.length < IMAGE_MIN_BYTES) return
    if (entry.length > IMAGE_MAX_BYTES) {
      warnings.push(`DOCX 图片超过 20MB，已跳过：${mediaName}`)
      return
    }
    const info = sniffImage(entry)
    if (!info.type) {
      warnings.push(`DOCX 图片格式不受支持，已跳过：${mediaName}`)
      return
    }
    const imageIndex = figures.length
    figures.push({
      page: null,
      imageIndex,
      type: info.type,
      data: entry,
      width: info.width,
      height: info.height,
      ...(caption ? { caption } : {}),
    })
    units.push({
      page: null,
      section: activeSection,
      kind: 'figure',
      text: caption || `[图片 ${path.basename(mediaName)}]`,
    })
  }

  const tokenRe = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl\s*>|<w:p\b[^>]*>[\s\S]*?<\/w:p\s*>|<w:p\b[^>]*\/>/gi
  let token
  while ((token = tokenRe.exec(body)) !== null) {
    const chunk = token[0]
    if (/^<w:tbl/i.test(chunk)) {
      const tableText = docxTableText(chunk)
      if (tableText) {
        units.push({
          page: null,
          section: lastSection,
          kind: 'table',
          text: tableText,
        })
      }
      continue
    }

    const text = docxParagraphText(chunk)
    const style = /<w:pStyle\b[^>]*w:val\s*=\s*["']([^"']+)["']/i.exec(chunk)?.[1] ?? null
    const outline = /<w:outlineLvl\b[^>]*w:val\s*=\s*["'](\d+)["']/i.exec(chunk)?.[1]
    const isHeading =
      (style && /^heading/i.test(style)) || (outline !== undefined && Number.parseInt(outline, 10) < 9)
    const refs = docxImageRefs(chunk, relTargets)
    if (text) {
      if (isHeading) {
        section += 1
        lastSection = section
        units.push({ page: null, section, kind: 'heading', text })
      } else {
        units.push({ page: null, section: lastSection, kind: 'text', text })
      }
    }
    const caption = docxImageCaption(chunk)
    for (const mediaName of refs) addFigure(mediaName, caption, lastSection)
  }

  // 未被正文引用的图片：追加到最后一节。
  for (const name of entries.keys()) {
    if (!name.startsWith('word/media/')) continue
    if (usedMedia.has(name)) continue
    addFigure(name, undefined, lastSection || 1)
  }

  const metadata = docxMetadata(entries)
  const sections = Math.max(section, units.length > 0 ? 1 : 0)
  return {
    units,
    figures,
    metadata,
    structure: { sections },
    warnings,
    kind: 'docx',
  }
}

function docxMetadata(entries) {
  const metadata = {}
  const core = entries.get('docProps/core.xml')
  if (core) {
    const xml = core.toString('utf8')
    const title = /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(xml)?.[1]
    const creator = /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(xml)?.[1]
    if (title?.trim()) metadata.title = decodeEntities(title.trim())
    if (creator?.trim()) metadata.author = decodeEntities(creator.trim())
  }
  return metadata
}

function docxRelations(entries) {
  const map = new Map()
  const rels = entries.get('word/_rels/document.xml.rels')
  if (!rels) return map
  const xml = rels.toString('utf8')
  const re = /<Relationship\b([^>]*)\/?>/gi
  let match
  while ((match = re.exec(xml)) !== null) {
    const attrs = parseXmlAttributes(match[1])
    if (!attrs.Id || !attrs.Target) continue
    if (/^external$/i.test(attrs.TargetMode ?? '')) continue
    let target = attrs.Target.replace(/\\/g, '/')
    if (target.startsWith('/')) target = target.slice(1)
    else target = `word/${target}`
    target = path.posix.normalize(target)
    map.set(attrs.Id, target)
  }
  return map
}

function docxImageRefs(paragraphXml, relTargets) {
  const refs = []
  const re = /<a:blip\b[^>]*r:embed\s*=\s*["']([^"']+)["']/gi
  let match
  while ((match = re.exec(paragraphXml)) !== null) {
    const target = relTargets.get(match[1])
    if (target) refs.push(target)
  }
  return refs
}

function docxImageCaption(paragraphXml) {
  const docPr = /<wp:docPr\b([^>]*)>/i.exec(paragraphXml)
  if (!docPr) return ''
  const attrs = parseXmlAttributes(docPr[1])
  const value = attrs.descr || attrs.title || ''
  return decodeEntities(String(value)).trim()
}

function docxParagraphText(paragraphXml) {
  let out = ''
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/gi
  let match
  while ((match = re.exec(paragraphXml)) !== null) {
    if (match[1] !== undefined) out += decodeEntities(match[1])
    else if (/^<w:tab/i.test(match[0])) out += '\t'
    else out += '\n'
  }
  return out.replace(/\u00a0/g, ' ').trim()
}

function docxTableText(tableXml) {
  const rows = []
  const rowRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr\s*>/gi
  let rowMatch
  while ((rowMatch = rowRe.exec(tableXml)) !== null) {
    const cells = []
    const cellRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc\s*>/gi
    let cellMatch
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const paragraphs = []
      const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p\s*>/gi
      let pMatch
      while ((pMatch = pRe.exec(cellMatch[1])) !== null) {
        const text = docxParagraphText(pMatch[0])
        if (text) paragraphs.push(text)
      }
      cells.push(paragraphs.join(' ').trim())
    }
    if (cells.some(Boolean)) rows.push(cells)
  }
  return rows.map((cells) => cells.join(' | ')).join('\n')
}

function parseXmlAttributes(source) {
  const attrs = {}
  const re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g
  let match
  while ((match = re.exec(source)) !== null) {
    const key = match[1] ?? match[3]
    attrs[key] = match[2] ?? match[4]
  }
  return attrs
}
