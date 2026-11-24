// LectureForge — 图片资产登记（figures.json + assets/ 文件）。
import fs from 'node:fs'
import path from 'node:path'
import {
  ensureDir,
  exists,
  nowIso,
  projectPaths,
  readJson,
  sha256Buffer,
  writeJson,
} from './paths.mjs'
import { LectureError, loadFigures, saveFigures } from './projects.mjs'

export const FIGURE_KINDS = ['extracted', 'plot', 'svg', 'web']
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']

export function detectImageType(buffer) {
  if (!buffer || buffer.length < 8) return null
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp'
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif'
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').trimStart()
  if (head.startsWith('<?xml') || head.startsWith('<svg') || /<svg[\s>]/i.test(head)) {
    if (/<svg[\s>]/i.test(head.slice(0, 4096))) return 'svg'
  }
  return null
}

function u32be(buffer, offset) {
  return buffer.readUInt32BE(offset)
}

export function imageSize(buffer, type = detectImageType(buffer)) {
  try {
    if (type === 'png' && buffer.length >= 24) {
      return { width: u32be(buffer, 16), height: u32be(buffer, 20) }
    }
    if (type === 'jpg') {
      let i = 2
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) { i += 1; continue }
        const marker = buffer[i + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
        const len = buffer.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) }
        }
        i += 2 + len
      }
      return null
    }
    if (type === 'webp' && buffer.length >= 30) {
      const chunk = buffer.subarray(12, 16).toString('ascii')
      if (chunk === 'VP8X') {
        return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
      }
      if (chunk === 'VP8 ') {
        const w = buffer.readUInt16LE(26) & 0x3fff
        const h = buffer.readUInt16LE(28) & 0x3fff
        return { width: w, height: h }
      }
      if (chunk === 'VP8L') {
        const bits = buffer.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      return null
    }
    if (type === 'gif' && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
    }
    if (type === 'svg') {
      const text = buffer.toString('utf8').slice(0, 8192)
      const svgTag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? ''
      const widthAttr = /\bwidth\s*=\s*["']([\d.]+)(px)?["']/i.exec(svgTag)
      const heightAttr = /\bheight\s*=\s*["']([\d.]+)(px)?["']/i.exec(svgTag)
      const viewBox = /\bviewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*["']/i.exec(svgTag)
      let width = widthAttr ? Number.parseFloat(widthAttr[1]) : null
      let height = heightAttr ? Number.parseFloat(heightAttr[1]) : null
      if (viewBox) {
        if (!width) width = Number.parseFloat(viewBox[3])
        if (!height) height = Number.parseFloat(viewBox[4])
      }
      if (width && height) return { width: Math.round(width), height: Math.round(height) }
      return null
    }
  } catch {
    return null
  }
  return null
}

const DANGEROUS_SVG = [
  [/<script[\s\S]*?<\/script>/gi, ''],
  [/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ''],
  [/javascript:/gi, ''],
  [/<foreignObject[\s\S]*?<\/foreignObject>/gi, ''],
  [/<!ENTITY[\s\S]*?>/gi, ''],
]

export function sanitizeSvg(text) {
  let out = String(text)
  for (const [re, replacement] of DANGEROUS_SVG) out = out.replace(re, replacement)
  if (!/<svg[\s>]/i.test(out)) {
    throw new LectureError('INVALID_SVG', 'SVG 内容里没有 <svg> 根元素')
  }
  return out
}

export function assetFileName(assetId, ext) {
  return `${assetId}.${String(ext).toLowerCase()}`
}

export function assetRelativePath(record) {
  return `assets/${path.basename(record.file)}`
}

export function nextAssetId(data) {
  let max = 0
  for (const asset of data.assets ?? []) {
    const m = /^fig-(\d+)$/.exec(String(asset.assetId))
    if (m) max = Math.max(max, Number.parseInt(m[1], 10))
  }
  return `fig-${String(max + 1).padStart(3, '0')}`
}

export function registerAsset(projectDir, input) {
  const kind = input.kind ?? 'extracted'
  if (!FIGURE_KINDS.includes(kind)) {
    throw new LectureError('INVALID_FIGURE_KIND', `图片类型必须是 ${FIGURE_KINDS.join(' / ')}`)
  }
  let buffer = input.data
  if (!buffer && input.sourcePath) buffer = fs.readFileSync(input.sourcePath)
  if (!Buffer.isBuffer(buffer)) throw new LectureError('INVALID_IMAGE', '没有可写入的图片数据')
  if (buffer.length === 0) throw new LectureError('INVALID_IMAGE', '图片数据为空')
  if (buffer.length > 20 * 1024 * 1024) {
    throw new LectureError('IMAGE_TOO_LARGE', `图片超过 20MB（${buffer.length} 字节）`)
  }
  let type = input.type ?? detectImageType(buffer)
  if (!type) throw new LectureError('UNSUPPORTED_IMAGE', '无法识别图片格式（支持 png/jpg/webp/gif/svg）')
  if (type === 'jpeg') type = 'jpg'
  if (!IMAGE_EXTS.includes(type)) {
    throw new LectureError('UNSUPPORTED_IMAGE', `不支持的图片扩展名：${type}`)
  }
  if (type === 'svg') {
    buffer = Buffer.from(sanitizeSvg(buffer.toString('utf8')), 'utf8')
  }
  const data = loadFigures(projectDir)
  const assetId = nextAssetId(data)
  const file = assetFileName(assetId, type)
  const assetsDir = ensureDir(projectPaths(projectDir).assetsDir)
  const abs = path.join(assetsDir, file)
  fs.writeFileSync(abs, buffer)
  const size = imageSize(buffer, type)
  const record = {
    assetId,
    file: `assets/${file}`,
    kind,
    type,
    bytes: buffer.length,
    sha256: sha256Buffer(buffer),
    width: size?.width ?? null,
    height: size?.height ?? null,
    caption: String(input.caption ?? '').trim() || assetId,
    source: input.source ?? null,
    createdAt: nowIso(),
  }
  data.assets.push(record)
  saveFigures(projectDir, data)
  return record
}

export function findAsset(projectDir, assetId) {
  const data = loadFigures(projectDir)
  return data.assets.find((a) => a.assetId === assetId) ?? null
}

export function assetMarkdown(record, { width = 80, id = record.assetId } = {}) {
  const caption = String(record.caption ?? '').replace(/]/g, '\\]')
  return `![${caption}](${assetRelativePath(record)}){#${id} width=${width}%}`
}

export function readAssetBytes(projectDir, record) {
  const abs = path.join(projectDir, '.lecture', record.file)
  if (!exists(abs)) throw new LectureError('ASSET_MISSING', `图片文件不存在：${record.file}`)
  return fs.readFileSync(abs)
}

export function figuresIndex(projectDir) {
  return loadFigures(projectDir).assets
}

export function figureSummary(record) {
  return {
    assetId: record.assetId,
    file: record.file,
    kind: record.kind,
    type: record.type,
    width: record.width,
    height: record.height,
    caption: record.caption,
    markdown: assetMarkdown(record),
  }
}

export function removeFigureRecord(projectDir, assetId) {
  const data = loadFigures(projectDir)
  const idx = data.assets.findIndex((a) => a.assetId === assetId)
  if (idx < 0) return false
  const [removed] = data.assets.splice(idx, 1)
  try {
    fs.unlinkSync(path.join(projectDir, '.lecture', removed.file))
  } catch {}
  writeJson(projectPaths(projectDir).figuresFile, data)
  return true
}

export function loadFigureData(projectDir) {
  return readJson(projectPaths(projectDir).figuresFile, { schemaVersion: 1, assets: [] })
}
