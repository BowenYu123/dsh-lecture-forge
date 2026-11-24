// LectureForge — PPTX 解析（按 slide 序号分节，文字与内嵌图片）。
import path from 'node:path'
import { LectureError } from '../projects.mjs'
import { decodeEntities, readZipEntries, sniffImage } from './detect.mjs'

const IMAGE_MIN_BYTES = 4096
const IMAGE_MAX_BYTES = 20 * 1024 * 1024

/**
 * @param {{buffer:Buffer, file?:string|null, warnings?:string[]}} input
 */
export function parsePptx({ buffer, file = null, warnings = [] } = {}) {
  let entries
  try {
    entries = readZipEntries(buffer)
  } catch (error) {
    throw new LectureError(
      'PPTX_INVALID',
      `无法解析 PPTX（zip 结构损坏）：${String(error?.message ?? error)}`,
      '请确认文件是有效的 .pptx，而不是改过扩展名的旧版 .ppt 或损坏文件。',
    )
  }

  const slides = []
  for (const name of entries.keys()) {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name)
    if (match) slides.push({ name, number: Number.parseInt(match[1], 10) })
  }
  if (slides.length === 0) {
    throw new LectureError(
      'PPTX_INVALID',
      'PPTX 中没有找到任何幻灯片（ppt/slides/slideN.xml）。',
      '请用 PowerPoint/WPS 重新另存为 .pptx 后再试。',
    )
  }
  slides.sort((a, b) => a.number - b.number)

  const units = []
  const figures = []
  const usedMedia = new Set()
  let imageIndex = 0

  const addFigure = (mediaName, caption, slideNumber) => {
    if (usedMedia.has(mediaName)) return
    usedMedia.add(mediaName)
    const entry = entries.get(mediaName)
    if (!entry) {
      warnings.push(`PPTX 引用的图片不存在：${mediaName}`)
      return
    }
    if (entry.length < IMAGE_MIN_BYTES) return
    if (entry.length > IMAGE_MAX_BYTES) {
      warnings.push(`PPTX 图片超过 20MB，已跳过：${mediaName}`)
      return
    }
    const info = sniffImage(entry)
    if (!info.type) {
      warnings.push(`PPTX 图片格式不受支持，已跳过：${mediaName}`)
      return
    }
    figures.push({
      page: null,
      imageIndex,
      type: info.type,
      data: entry,
      width: info.width,
      height: info.height,
      ...(caption ? { caption } : {}),
    })
    imageIndex += 1
    units.push({
      page: null,
      section: slideNumber,
      kind: 'figure',
      text: caption || `[图片 ${path.basename(mediaName)}]`,
    })
  }

  let documentTitle = null
  for (const slide of slides) {
    const xml = entries.get(slide.name).toString('utf8')
    const rels = slideRelations(entries, slide.name)
    const shapes = []
    const shapeRe = /<p:sp\b[^>]*>[\s\S]*?<\/p:sp\s*>/gi
    let shapeMatch
    while ((shapeMatch = shapeRe.exec(xml)) !== null) shapes.push(shapeMatch[0])
    if (shapes.length === 0) {
      const text = slideShapeText(xml)
      if (text) units.push({ page: null, section: slide.number, kind: 'text', text })
    } else {
      for (const shape of shapes) {
        const text = slideShapeText(shape)
        if (!text) continue
        const isTitle = /<p:ph\b[^>]*\btype\s*=\s*["'](?:title|ctrTitle)["']/i.test(shape)
        if (isTitle) {
          units.push({ page: null, section: slide.number, kind: 'heading', text })
          if (!documentTitle) documentTitle = text
        } else {
          units.push({ page: null, section: slide.number, kind: 'text', text })
        }
      }
    }

    // 按图片在 slide 中出现的顺序收集。
    const picRe = /<p:pic\b[^>]*>[\s\S]*?<\/p:pic\s*>/gi
    let picMatch
    while ((picMatch = picRe.exec(xml)) !== null) {
      const pic = picMatch[0]
      const embed = /<a:blip\b[^>]*r:embed\s*=\s*["']([^"']+)["']/i.exec(pic)?.[1]
      if (!embed) continue
      const mediaName = rels.get(embed)
      if (!mediaName) continue
      addFigure(mediaName, pptxPictureCaption(pic), slide.number)
    }
  }

  // 未被 slide 引用的媒体（例如版式图片）附到最后一张 slide。
  const lastSlide = slides[slides.length - 1].number
  for (const name of entries.keys()) {
    if (!name.startsWith('ppt/media/')) continue
    if (usedMedia.has(name)) continue
    addFigure(name, undefined, lastSlide)
  }

  const metadata = pptxMetadata(entries, documentTitle)
  return {
    units,
    figures,
    metadata,
    structure: { slides: slides.length, sections: slides.length },
    warnings,
    kind: 'pptx',
  }
}

function slideRelations(entries, slideName) {
  const map = new Map()
  const relName = slideName.replace(/slides\/(slide\d+\.xml)$/i, 'slides/_rels/$1.rels')
  const rels = entries.get(relName)
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
    else target = `ppt/slides/${target}`
    map.set(attrs.Id, path.posix.normalize(target))
  }
  return map
}

function slideShapeText(shapeXml) {
  const paragraphs = []
  const pRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p\s*>/gi
  let pMatch
  while ((pMatch = pRe.exec(shapeXml)) !== null) {
    let text = ''
    const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/gi
    let tMatch
    while ((tMatch = tRe.exec(pMatch[1])) !== null) {
      if (tMatch[1] !== undefined) text += decodeEntities(tMatch[1])
      else text += '\n'
    }
    const clean = text.replace(/\u00a0/g, ' ').trim()
    if (clean) paragraphs.push(clean)
  }
  if (paragraphs.length === 0) {
    const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi
    let tMatch
    while ((tMatch = tRe.exec(shapeXml)) !== null) {
      const clean = decodeEntities(tMatch[1]).trim()
      if (clean) paragraphs.push(clean)
    }
  }
  return paragraphs.join('\n')
}

function pptxPictureCaption(picXml) {
  const cNvPr = /<p:cNvPr\b([^>]*)>/i.exec(picXml)
  if (!cNvPr) return ''
  const attrs = parseXmlAttributes(cNvPr[1])
  const value = attrs.descr || attrs.title || ''
  return decodeEntities(String(value)).trim()
}

function pptxMetadata(entries, fallbackTitle) {
  const metadata = {}
  const core = entries.get('docProps/core.xml')
  if (core) {
    const xml = core.toString('utf8')
    const title = /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(xml)?.[1]
    const creator = /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(xml)?.[1]
    if (title?.trim()) metadata.title = decodeEntities(title.trim())
    if (creator?.trim()) metadata.author = decodeEntities(creator.trim())
  }
  if (!metadata.title && fallbackTitle) metadata.title = fallbackTitle
  return metadata
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
