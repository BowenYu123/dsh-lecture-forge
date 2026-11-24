// LectureForge — 素材类型探测与通用二进制工具（ZIP / 图片签名 / 文本启发式）。
import path from 'node:path'
import zlib from 'node:zlib'
import { LectureError } from '../projects.mjs'

export const INGEST_KINDS = ['pdf', 'docx', 'pptx', 'md', 'html', 'url', 'txt']
export const IMAGE_TYPES = ['png', 'jpg', 'webp', 'gif']

const ZIP_SIG = 0x04034b50
const ZIP_CENTRAL_SIG = 0x02014b50
const ZIP_EOCD_SIG = 0x06054b50

/**
 * 读取 ZIP 的全部文件条目（中央目录 + local header），只依赖 Node 内置 zlib。
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
export function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('不是有效的 ZIP 数据')
  }
  let eocd = -1
  const floor = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 中央目录')
  const count = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset >= buffer.length) throw new Error('ZIP 中央目录偏移越界')

  const entries = new Map()
  let pos = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== ZIP_CENTRAL_SIG) {
      throw new Error('ZIP 中央目录条目损坏')
    }
    const flags = buffer.readUInt16LE(pos + 8)
    const method = buffer.readUInt16LE(pos + 10)
    const compressedSize = buffer.readUInt32LE(pos + 20)
    const nameLength = buffer.readUInt16LE(pos + 28)
    const extraLength = buffer.readUInt16LE(pos + 30)
    const commentLength = buffer.readUInt16LE(pos + 32)
    const localOffset = buffer.readUInt32LE(pos + 42)
    if (pos + 46 + nameLength > buffer.length) throw new Error('ZIP 文件名越界')
    let name = buffer.subarray(pos + 46, pos + 46 + nameLength).toString('utf8')
    if (flags & 0x800 && name.includes('\uFFFD')) {
      name = buffer.subarray(pos + 46, pos + 46 + nameLength).toString('latin1')
    }
    pos += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/') || name.endsWith('\\')) continue

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== ZIP_SIG) {
      throw new Error(`ZIP 条目 ${name} 的 local header 损坏`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > buffer.length) {
      throw new Error(`ZIP 条目 ${name} 的数据越界`)
    }
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    let data
    if (method === 0) {
      data = Buffer.from(raw)
    } else if (method === 8) {
      data = zlib.inflateRawSync(raw)
    } else {
      throw new Error(`不支持的 ZIP 压缩方式 ${method}（${name}）`)
    }
    entries.set(name.replace(/\\/g, '/'), data)
  }
  return entries
}

/** 通过文件签名判断图片格式与像素尺寸。 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return { type: null, width: null, height: null }
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { type: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2
    while (i + 9 < buffer.length) {
      if (buffer[i] !== 0xff) {
        i += 1
        continue
      }
      const marker = buffer[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      if (marker === 0xd9 || marker === 0xda) break
      const length = buffer.readUInt16BE(i + 2)
      if (length < 2) break
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
      if (isSof) {
        return { type: 'jpg', height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) }
      }
      i += 2 + length
    }
    return { type: 'jpg', width: null, height: null }
  }
  if (buffer.length >= 10 && buffer.toString('latin1', 0, 3) === 'GIF') {
    return { type: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  if (
    buffer.length >= 30 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    const chunk = buffer.toString('latin1', 12, 16)
    if (chunk === 'VP8X') {
      return {
        type: 'webp',
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      }
    }
    if (chunk === 'VP8 ') {
      const start = buffer.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20)
      if (start > 0 && start + 7 < buffer.length) {
        return {
          type: 'webp',
          width: buffer.readUInt16LE(start + 3) & 0x3fff,
          height: buffer.readUInt16LE(start + 5) & 0x3fff,
        }
      }
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21)
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return { type: 'webp', width: null, height: null }
  }
  return { type: null, width: null, height: null }
}

/** XML / HTML 命名实体与数字实体的基本反转义。 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => safeCodePoint(Number.parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec) => safeCodePoint(Number.parseInt(dec, 10), m))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rsquo;/gi, '’')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&copy;/gi, '©')
    .replace(/&reg;/gi, '®')
    .replace(/&trade;/gi, '™')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function safeCodePoint(code, fallback) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

/** HTML 片段转纯文本（保留换行，折叠空白）。 */
export function htmlToText(html) {
  const withBreaks = String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  return decodeEntities(withBreaks)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 解析 `<tag ...>` 的属性表。 */
export function parseAttributes(source) {
  const attrs = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  let match
  while ((match = re.exec(String(source ?? ''))) !== null) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '')
  }
  return attrs
}

function looksLikeMarkdown(text) {
  const sample = String(text ?? '').slice(0, 30000)
  if (!sample.trim()) return false
  let score = 0
  if (/(^|\n)#{1,6}\s+\S/.test(sample)) score += 2
  if (/```|~~~/.test(sample)) score += 1
  if (/(^|\n)\s*[-*+]\s+\S/.test(sample)) score += 1
  if (/\[[^\]]+\]\([^)]+\)/.test(sample)) score += 1
  if (/(^|\n)\|.*\|/.test(sample) && /(^|\n)\s*\|?[\s:|-]+\|/.test(sample)) score += 1
  if (/\*\*[^*\n]+\*\*/.test(sample)) score += 1
  return score >= 2
}

function isProbablyText(buffer) {
  const sample = buffer.subarray(0, 4096)
  if (sample.length === 0) return true
  if (sample.includes(0)) return false
  let bad = 0
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte < 0x20) bad += 1
  }
  return bad / sample.length < 0.02
}

/**
 * 判定素材类型：kindHint 优先，其次 magic，最后扩展名/内容启发。
 * @param {{file?:string, buffer?:Buffer, kindHint?:string|null}} input
 * @returns {'pdf'|'docx'|'pptx'|'md'|'html'|'url'|'txt'}
 */
export function detectKind({ file = null, buffer = null, kindHint = null } = {}) {
  if (kindHint !== null && kindHint !== undefined && kindHint !== '') {
    const hint = String(kindHint).trim().toLowerCase().replace(/^\./, '')
    if (!INGEST_KINDS.includes(hint)) {
      throw new LectureError(
        'INVALID_KIND',
        `不支持的素材类型 "${kindHint}"`,
        `可用类型：${INGEST_KINDS.join(' / ')}`,
      )
    }
    return hint
  }
  if (typeof file === 'string' && /^https?:\/\//i.test(file.trim())) return 'url'
  if (!Buffer.isBuffer(buffer)) {
    throw new LectureError('UNSUPPORTED_FORMAT', '无法读取素材内容', '请确认文件存在且具有读取权限。')
  }

  const ext = path.extname(typeof file === 'string' ? file : '').toLowerCase()
  const head = buffer.subarray(0, 2048)
  const headAscii = head.toString('latin1')

  if (headAscii.includes('%PDF-')) return 'pdf'

  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) {
    try {
      const entries = readZipEntries(buffer)
      if (entries.has('[Content_Types].xml')) {
        if (entries.has('word/document.xml')) return 'docx'
        if ([...entries.keys()].some((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))) {
          return 'pptx'
        }
      }
    } catch {
      /* 坏 zip 交给后续扩展名/格式错误处理 */
    }
  }

  const textHead = head.toString('utf8').replace(/^\uFEFF/, '').trimStart()
  if (/^<!doctype\s+html\b/i.test(textHead) || /^<html\b/i.test(textHead)) return 'html'
  if (/^<head\b/i.test(textHead) || /^<body\b/i.test(textHead)) return 'html'

  if (ext === '.md' || ext === '.markdown' || ext === '.mdown' || ext === '.mkd') return 'md'
  if (ext === '.html' || ext === '.htm' || ext === '.xhtml') return 'html'
  if (ext === '.txt' || ext === '.text' || ext === '.rst' || ext === '.csv') return 'txt'

  if (ext === '.pdf' || ext === '.docx' || ext === '.pptx') {
    throw new LectureError(
      'UNSUPPORTED_FORMAT',
      `文件扩展名为 ${ext}，但内容不符合该格式的签名：${file ?? '(内存数据)'}`,
      '请确认文件未损坏，或提供正确的 kindHint。',
    )
  }

  if (looksLikeMarkdown(textHead)) return 'md'
  if (isProbablyText(buffer)) return 'txt'

  throw new LectureError(
    'UNSUPPORTED_FORMAT',
    `无法识别素材格式：${file ?? '(内存数据)'}`,
    '支持 PDF / DOCX / PPTX / Markdown / HTML / URL / 纯文本。',
  )
}
