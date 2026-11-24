// LectureForge — Markdown / 纯文本解析（标题、代码、公式、表格、图片）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEntities, sniffImage } from './detect.mjs'

const IMAGE_LIMIT = 20 * 1024 * 1024
const IMAGE_MIN_BYTES = 4096
const IMAGE_MIN_SIDE = 80

/**
 * @param {{buffer:Buffer, file:string, kind?:'md'|'txt', warnings?:string[]}} input
 */
export function parseMarkdown({ buffer, file, kind = 'md', warnings = [] } = {}) {
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const units = []
  const figures = []
  let section = 0
  let title = null

  const sectionForContent = () => section || 1
  const pushUnit = (unit) => {
    if (unit.text && unit.text.trim()) units.push({ ...unit, text: unit.text.trim() })
  }

  const addImage = (src, alt) => {
    const resolved = resolveImageSource(src, file)
    if (!resolved) {
      warnings.push(`Markdown 中的远程图片未下载（请先在本地保存）：${src}`)
      return
    }
    if (!resolved.ok) {
      warnings.push(`无法读取图片 ${src}：${resolved.reason}`)
      return
    }
    const data = resolved.data
    if (data.length < IMAGE_MIN_BYTES) return
    if (data.length > IMAGE_LIMIT) {
      warnings.push(`图片超过 20MB，已跳过：${src}`)
      return
    }
    const info = sniffImage(data)
    if (!info.type) {
      warnings.push(`无法识别图片格式，已跳过：${src}`)
      return
    }
    if (
      (info.width !== null && info.width < IMAGE_MIN_SIDE) ||
      (info.height !== null && info.height < IMAGE_MIN_SIDE)
    ) {
      return
    }
    const imageIndex = figures.length
    figures.push({
      page: null,
      imageIndex,
      type: info.type,
      data,
      width: info.width,
      height: info.height,
      ...(alt ? { caption: alt } : {}),
    })
    pushUnit({
      page: null,
      section: sectionForContent(),
      kind: 'figure',
      text: alt || `[图片 ${path.basename(resolved.name || src)}]`,
    })
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      i += 1
      continue
    }

    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      const marker = fence[1]
      const body = []
      i += 1
      let closed = false
      while (i < lines.length) {
        if (lines[i].trim().startsWith(marker)) {
          closed = true
          i += 1
          break
        }
        body.push(lines[i])
        i += 1
      }
      if (!closed) warnings.push('Markdown 代码块缺少结束围栏，已解析到文件末尾。')
      if (body.length) {
        pushUnit({
          page: null,
          section: sectionForContent(),
          kind: 'code',
          text: body.join('\n').replace(/^\n+|\n+$/g, ''),
        })
      }
      continue
    }

    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line)
    if (heading) {
      section += 1
      const headingText = cleanInline(heading[2].replace(/\s+#+\s*$/, ''))
      if (!title) title = headingText
      pushUnit({ page: null, section, kind: 'heading', text: headingText })
      i += 1
      continue
    }

    if (/^\s*\$\$/.test(line)) {
      const body = []
      let rest = line.trim().slice(2)
      let closed = false
      if (rest.includes('$$')) {
        body.push(rest.slice(0, rest.indexOf('$$')))
        closed = true
        i += 1
      } else {
        if (rest.trim()) body.push(rest.trim())
        i += 1
        while (i < lines.length) {
          const current = lines[i]
          const end = current.indexOf('$$')
          if (end >= 0) {
            const before = current.slice(0, end).trim()
            if (before) body.push(before)
            closed = true
            i += 1
            break
          }
          body.push(current)
          i += 1
        }
      }
      if (!closed) warnings.push('Markdown 公式块缺少结束 $$，已解析到文件末尾。')
      if (body.join('\n').trim()) {
        pushUnit({
          page: null,
          section: sectionForContent(),
          kind: 'formula',
          text: body.join('\n').trim(),
        })
      }
      continue
    }

    if (isTableStart(lines, i)) {
      const rows = []
      i += 1 // 跳过分隔行
      while (i < lines.length) {
        const current = lines[i]
        if (!current.trim() || !current.includes('|')) break
        const cells = splitTableRow(current)
        if (!isTableSeparator(cells)) rows.push(cells)
        i += 1
      }
      if (rows.length) {
        pushUnit({
          page: null,
          section: sectionForContent(),
          kind: 'table',
          text: rows.map((cells) => cells.join(' | ')).join('\n'),
        })
      }
      continue
    }

    const image = /^\s*!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)\s*$/.exec(line)
    if (image) {
      addImage(image[2], cleanInline(image[1]))
      i += 1
      continue
    }

    // 普通段落：连续非空行，直到遇到新的结构块。
    const paragraph = []
    while (i < lines.length) {
      const current = lines[i]
      if (!current.trim()) break
      if (paragraph.length > 0 && isStructuralStart(lines, i)) break
      paragraph.push(current.replace(/^\s*>\s?/, ''))
      i += 1
    }
    const raw = paragraph.join('\n').trim()
    if (raw) {
      pushUnit({
        page: null,
        section: sectionForContent(),
        kind: 'text',
        text: cleanInlineBlock(raw),
      })
    }
  }

  return {
    units,
    figures,
    metadata: title ? { title } : {},
    structure: { sections: section },
    warnings,
    kind,
  }
}

/**
 * 解析 Markdown 图片目标：支持 data URI、file:// 和相对/绝对本地路径。
 * @returns {{ok:true,name:string,data:Buffer}|{ok:false,reason:string}|null}
 */
function resolveImageSource(src, markdownFile) {
  const value = String(src ?? '').trim()
  if (!value) return { ok: false, reason: '空路径' }
  if (/^https?:\/\//i.test(value) || /^\/\//.test(value)) return null
  try {
    if (value.startsWith('data:')) {
      const comma = value.indexOf(',')
      if (comma < 0) return { ok: false, reason: 'data URI 缺少内容' }
      const meta = value.slice(0, comma)
      const payload = value.slice(comma + 1)
      if (!/;base64/i.test(meta)) return { ok: false, reason: '仅支持 base64 data URI' }
      return { ok: true, name: 'inline-data', data: Buffer.from(payload, 'base64') }
    }
    let target = null
    if (value.startsWith('file://')) {
      target = fileURLToPath(new URL(value))
    } else {
      target = path.resolve(path.dirname(markdownFile), decodeURIComponent(value))
    }
    if (!fs.existsSync(target)) return { ok: false, reason: '文件不存在' }
    const stat = fs.statSync(target)
    if (!stat.isFile()) return { ok: false, reason: '不是文件' }
    if (stat.size > IMAGE_LIMIT) return { ok: false, reason: '文件超过 20MB' }
    return { ok: true, name: target, data: fs.readFileSync(target) }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

function isTableStart(lines, index) {
  const current = lines[index]
  const next = lines[index + 1]
  if (!current || !next) return false
  if (!current.includes('|') || !next.includes('|')) return false
  return isTableSeparator(splitTableRow(next))
}

function splitTableRow(line) {
  return String(line)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cleanInline(cell))
}

function isTableSeparator(cells) {
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{2,}:?$/.test(String(cell).trim()))
  )
}

function isStructuralStart(lines, index) {
  const line = lines[index]
  if (!line) return true
  if (/^\s*(`{3,}|~{3,})/.test(line)) return true
  if (/^#{1,6}\s+/.test(line)) return true
  if (/^\s*\$\$/.test(line)) return true
  if (/^\s*!\[[^\]]*\]\(/.test(line)) return true
  return isTableStart(lines, index)
}

function cleanInline(value) {
  let text = String(value ?? '')
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  text = text.replace(/`([^`\n]+)`/g, '$1')
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  text = text.replace(/__([^_\n]+)__/g, '$1')
  text = text.replace(/(^|[\s(（])\*([^*\n]+)\*(?=[\s).,，。！？;；:：]|$)/g, '$1$2')
  text = text.replace(/(^|[\s(（])_([^_\n]+)_(?=[\s).,，。！？;；:：]|$)/g, '$1$2')
  text = text.replace(/~~([^~\n]+)~~/g, '$1')
  text = text.replace(/<[^>]+>/g, '')
  return decodeEntities(text).replace(/[ \t]+/g, ' ').trim()
}

function cleanInlineBlock(value) {
  return String(value ?? '')
    .split('\n')
    .map((line) => cleanInline(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
