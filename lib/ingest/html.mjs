// LectureForge — HTML 解析（正则、无 DOM 依赖）与网页图片下载。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEntities, htmlToText, parseAttributes, sniffImage } from './detect.mjs'

export const IMAGE_LIMIT = 20 * 1024 * 1024
const IMAGE_MIN_BYTES = 4096
const IMAGE_MIN_SIDE = 80
const REMOTE_IMAGE_LIMIT = 10 * 1024 * 1024
const REMOTE_IMAGE_COUNT = 30

/**
 * 带超时与大小上限的 fetch，返回 Buffer。
 * @param {string} url
 * @param {{limit?:number, timeoutMs?:number, signal?:AbortSignal|null, accept?:string}} options
 */
export async function fetchBufferLimited(url, options = {}) {
  const { limit = 10 * 1024 * 1024, timeoutMs = 20000, signal = null, accept = '*/*' } = options
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch(url, {
    redirect: 'follow',
    signal: combined,
    headers: {
      'user-agent': 'LectureForge/0.1',
      accept,
    },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`内容超过大小上限（${Math.round(limit / 1024 / 1024)}MB）`)
  }
  let buffer
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let total = 0
    for await (const chunk of response.body) {
      const piece = Buffer.from(chunk)
      total += piece.length
      if (total > limit) {
        try {
          await response.body.cancel()
        } catch {
          /* 已读取的数据直接丢弃 */
        }
        throw new Error(`内容超过大小上限（${Math.round(limit / 1024 / 1024)}MB）`)
      }
      chunks.push(piece)
    }
    buffer = Buffer.concat(chunks)
  } else {
    buffer = Buffer.from(await response.arrayBuffer())
  }
  if (buffer.length > limit) {
    throw new Error(`内容超过大小上限（${Math.round(limit / 1024 / 1024)}MB）`)
  }
  return {
    buffer,
    contentType: response.headers.get('content-type') ?? '',
    finalUrl: response.url || url,
  }
}

/**
 * @param {{html:string, file?:string|null, baseDir?:string|null, baseUrl?:string|null,
 *   warnings?:string[], signal?:AbortSignal|null, fetchImages?:boolean}} input
 */
export async function parseHtml({
  html,
  file = null,
  baseDir = null,
  baseUrl = null,
  warnings = [],
  signal = null,
  fetchImages = true,
} = {}) {
  const raw = String(html ?? '')
  const metadata = {}
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw)
  if (title) {
    const clean = htmlToText(title[1])
    if (clean) metadata.title = clean
  }
  const lang = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(raw)
  if (lang) metadata.language = lang[1].trim()

  let doc = raw.replace(/<!--[\s\S]*?-->/g, ' ')
  doc = doc.replace(
    /<(script|style|nav|footer|aside|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ' ',
  )

  const units = []
  const figures = []
  const headingPositions = []
  let section = 0
  let consumedEnd = 0

  const sectionFor = (position) => {
    let value = 0
    for (const item of headingPositions) {
      if (item.position <= position) value = item.section
      else break
    }
    return value || 1
  }

  const blockRe = /<(h[1-6]|table|pre|code|li|p|blockquote|dt|dd)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi
  let match
  while ((match = blockRe.exec(doc)) !== null) {
    if (match.index < consumedEnd) continue
    consumedEnd = blockRe.lastIndex
    const tag = match[1].toLowerCase()
    const content = match[3]
    if (tag === 'table') {
      const tableText = tableToText(content)
      if (tableText) {
        units.push({
          page: null,
          section: section || 1,
          kind: 'table',
          text: tableText,
          position: match.index,
        })
      }
      continue
    }
    if (tag === 'pre' || tag === 'code') {
      const code = codeToText(content)
      if (code) {
        units.push({
          page: null,
          section: section || 1,
          kind: 'code',
          text: code,
          position: match.index,
        })
      }
      continue
    }
    if (/^h[1-6]$/.test(tag)) {
      section += 1
      headingPositions.push({ position: match.index, section })
      const text = htmlToText(content)
      if (text) {
        units.push({
          page: null,
          section,
          kind: 'heading',
          text,
          position: match.index,
        })
      }
      continue
    }
    const text = htmlToText(content)
    if (text) {
      units.push({
        page: null,
        section: section || 1,
        kind: 'text',
        text,
        position: match.index,
      })
    }
  }

  // 兜底：没有 p/li/table 等块标签的页面（例如只有 div + 文本）。
  if (units.length === 0) {
    const plain = htmlToText(doc)
    for (const paragraph of plain.split(/\n{2,}/)) {
      const clean = paragraph.trim()
      if (clean) {
        units.push({ page: null, section: 1, kind: 'text', text: clean, position: 0 })
      }
    }
  }

  if (fetchImages) {
    let remoteCount = 0
    let remoteLimitWarned = false
    const seen = new Set()
    const imageRe = /<img\b([^>]*?)\/?>/gi
    let imageMatch
    while ((imageMatch = imageRe.exec(doc)) !== null) {
      const attrs = parseAttributes(imageMatch[1])
      const src = attrs.src
      if (!src || seen.has(src)) continue
      seen.add(src)
      const alt = attrs.alt ? htmlToText(attrs.alt) : ''
      let caption = alt
      if (!caption) {
        const after = doc.slice(imageRe.lastIndex, imageRe.lastIndex + 800)
        const figcaption = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(after)
        if (figcaption) caption = htmlToText(figcaption[1])
      }
      if (/^https?:\/\//i.test(src) || /^\/\//.test(src)) {
        if (remoteCount >= REMOTE_IMAGE_COUNT) {
          if (!remoteLimitWarned) {
            warnings.push(`网页远程图片超过 ${REMOTE_IMAGE_COUNT} 张，其余已跳过。`)
            remoteLimitWarned = true
          }
          continue
        }
        remoteCount += 1
      }
      let loaded
      try {
        loaded = await loadImage(src, { baseDir, baseUrl, signal, fetchImages })
      } catch (error) {
        warnings.push(`网页图片下载/读取失败（${src}）：${String(error?.message ?? error)}`)
        continue
      }
      if (!loaded) {
        warnings.push(`无法解析网页图片路径：${src}`)
        continue
      }
      if (loaded.data.length < IMAGE_MIN_BYTES) continue
      if (loaded.data.length > IMAGE_LIMIT) {
        warnings.push(`网页图片超过 20MB，已跳过：${src}`)
        continue
      }
      const info = sniffImage(loaded.data)
      if (!info.type) {
        warnings.push(`无法识别网页图片格式，已跳过：${src}`)
        continue
      }
      const width = toPixel(attrs.width) ?? info.width
      const height = toPixel(attrs.height) ?? info.height
      if ((width !== null && width < IMAGE_MIN_SIDE) || (height !== null && height < IMAGE_MIN_SIDE)) {
        continue
      }
      const imageIndex = figures.length
      figures.push({
        page: null,
        imageIndex,
        type: info.type,
        data: loaded.data,
        width,
        height,
        ...(caption ? { caption } : {}),
      })
      units.push({
        page: null,
        section: sectionFor(imageMatch.index),
        kind: 'figure',
        text: caption || `[图片 ${path.basename(loaded.name || src)}]`,
        position: imageMatch.index,
      })
    }
  }

  units.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  for (const unit of units) delete unit.position

  return {
    units,
    figures,
    metadata,
    structure: { sections: section },
    warnings,
    kind: 'html',
  }
}

async function loadImage(src, { baseDir, baseUrl, signal, fetchImages }) {
  const value = String(src ?? '').trim()
  if (!value) return null
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',')
    if (comma < 0) throw new Error('data URI 缺少内容')
    const meta = value.slice(0, comma)
    const payload = value.slice(comma + 1)
    if (!/;base64/i.test(meta)) throw new Error('仅支持 base64 data URI')
    return { name: 'inline-data', data: Buffer.from(payload, 'base64') }
  }
  let target = null
  if (/^https?:\/\//i.test(value) || (baseUrl && /^\/\//.test(value))) {
    target = baseUrl ? new URL(value, baseUrl).href : value
  } else if (value.startsWith('file://')) {
    target = fileURLToPath(new URL(value))
  } else if (baseUrl) {
    target = new URL(value, baseUrl).href
  } else if (baseDir) {
    target = path.resolve(baseDir, decodeURIComponent(value))
  }
  if (!target) return null
  if (/^https?:\/\//i.test(target)) {
    if (!fetchImages) return null
    const result = await fetchBufferLimited(target, {
      limit: REMOTE_IMAGE_LIMIT,
      timeoutMs: 20000,
      signal,
      accept: 'image/*,*/*;q=0.8',
    })
    return { name: target, data: result.buffer }
  }
  const stat = fs.statSync(target)
  if (!stat.isFile()) throw new Error('不是文件')
  if (stat.size > IMAGE_LIMIT) throw new Error('文件超过 20MB')
  return { name: target, data: fs.readFileSync(target) }
}

function toPixel(value) {
  if (!value) return null
  const match = /^(\d+)(?:px)?$/i.exec(String(value).trim())
  if (!match) return null
  const n = Number.parseInt(match[1], 10)
  return Number.isFinite(n) ? n : null
}

function codeToText(content) {
  const withBreaks = String(content ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(withBreaks)
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+|\n+$/g, '')
}

function tableToText(tableHtml) {
  const rows = []
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi
  let rowMatch
  while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
    const cells = []
    const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi
    let cellMatch
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      cells.push(htmlToText(cellMatch[2]).replace(/\n+/g, ' ').trim())
    }
    if (cells.some(Boolean)) rows.push(cells)
  }
  if (rows.length === 0) return htmlToText(tableHtml)
  return rows.map((cells) => cells.join(' | ')).join('\n')
}
