// LectureForge — 用 LibreOffice Kit 把 PDF 渲染成页面 PNG（讲义质检用）。
//
// kit = {node, cli, electronAsNode}：node 为运行时 node（Windows 为 node.exe，
// macOS/Linux 为包内 node，缺失时回退 Electron 并置 electronAsNode=true），
// cli 为 @deepseek-ai/libreoffice-kit/lib/cli.js。调用：
//   node cli.js render --input <pdf> --output-dir <dir> --pages 1,3 [--dpi 144]
// 该命令用 mkdir(wx) 创建输出目录，因此 --output-dir 必须**不存在**。
// 这里先渲染到一个临时 stage 目录，成功后再把 page-*.png 与 manifest.json
// 复制进调用方要的 outDir（可已存在），并清理 stage。
import fs from 'node:fs'
import path from 'node:path'
import { run } from '../runner.mjs'
import { ensureDir } from '../paths.mjs'

/**
 * @param {{
 *   pdfPath: string,
 *   outDir: string,
 *   pages?: number[]|string[]|string,
 *   dpi?: number,
 *   kit?: {node: string, cli: string},
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{
 *   ok: boolean,
 *   pageCount: number,
 *   pages: Array<{page: number, file: string, width?: number, height?: number}>,
 *   missingFonts: string[],
 *   message?: string,
 * }>}
 */
export async function renderPdfPages({ pdfPath, outDir, pages, dpi = 144, kit, signal, timeoutMs = 120000 } = {}) {
  const empty = { ok: false, pageCount: 0, pages: [], missingFonts: [] }
  if (!pdfPath || !outDir) return { ...empty, message: '缺少 pdfPath 或 outDir。' }
  if (!kit || !kit.node || !kit.cli) {
    return { ...empty, message: 'LibreOffice Kit 不可用（缺少可用的 node 或 kit cli；可配置 libreOfficeKitCli）。' }
  }

  const pdfFile = path.resolve(String(pdfPath))
  const outputDir = path.resolve(String(outDir))
  const requested = normalizePages(pages)
  if (!requested.ok) return { ...empty, message: requested.message }
  if (!fs.existsSync(pdfFile)) return { ...empty, message: `PDF 文件不存在：${pdfFile}` }
  if (!fs.existsSync(String(kit.cli))) {
    return { ...empty, message: `LibreOffice Kit cli 不存在：${kit.cli}` }
  }

  ensureDir(path.dirname(outputDir))
  const stage = freshStagePath(outputDir)
  let manifest = null
  try {
    const args = [
      String(kit.cli),
      'render',
      '--input',
      pdfFile,
      '--output-dir',
      stage,
      '--pages',
      requested.arg,
      '--dpi',
      String(dpi),
    ]
    const result = await run(String(kit.node), args, {
      timeoutMs,
      signal,
      windowsHide: true,
      // macOS/Linux 回退到 Electron 时，必须让 Electron 以纯 Node 模式跑 cli.js。
      ...(kit.electronAsNode ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
    })
    if (result.aborted) return { ...empty, message: '页面渲染已取消。' }
    if (result.spawnError) return { ...empty, message: `无法启动 LibreOffice Kit：${result.spawnError}` }

    const manifestPath = path.join(stage, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      return {
        ...empty,
        message: `渲染未产出 manifest.json（退出码 ${result.code}）：${tail(result.stderr || result.stdout)}`,
      }
    }
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      return { ...empty, message: `manifest.json 读取失败：${error.message}` }
    }
    if (result.code !== 0) {
      return {
        ...empty,
        message: `渲染失败（退出码 ${result.code}）：${tail(result.stderr || result.stdout)}`,
      }
    }

    const missingFonts = Array.isArray(manifest?.missingFonts)
      ? manifest.missingFonts.map((font) => (typeof font === 'string' ? font : String(font?.name ?? font)))
      : []
    const images = Array.isArray(manifest?.images) ? manifest.images : []
    if (images.length === 0) {
      return { ...empty, missingFonts, message: '渲染完成，但 manifest 中没有页面图像。' }
    }

    ensureDir(outputDir)
    const rendered = []
    for (const image of images) {
      const source = resolveImagePath(image, stage)
      if (!source || !fs.existsSync(source)) continue
      const dest = path.join(outputDir, path.basename(source))
      fs.copyFileSync(source, dest)
      rendered.push({
        page: resolvePageNumber(image, source, rendered.length + 1),
        file: dest,
        width: Number.isFinite(Number(image.width)) ? Number(image.width) : undefined,
        height: Number.isFinite(Number(image.height)) ? Number(image.height) : undefined,
      })
    }
    rendered.sort((a, b) => a.page - b.page)
    cleanStalePages(outputDir, new Set(rendered.map((page) => path.basename(page.file))))
    fs.copyFileSync(manifestPath, path.join(outputDir, 'manifest.json'))

    const pageCount = Number(manifest?.pageCount)
    const response = {
      ok: rendered.length > 0,
      pageCount: Number.isFinite(pageCount) && pageCount > 0 ? pageCount : rendered.length,
      pages: rendered,
      missingFonts,
    }
    if (requested.list.length > 0 && rendered.length < requested.list.length) {
      response.message = `请求 ${requested.list.length} 页，实际产出 ${rendered.length} 页。`
    }
    return response
  } finally {
    removeQuietly(stage, { recursive: true })
  }
}

function resolveImagePath(image, stage) {
  // 真实 kit 的 manifest 用 path（绝对路径）；测试桩/旧版 manifest 可能用 file（相对）。
  const raw = image?.path ?? image?.file
  if (!raw) return null
  const text = String(raw)
  if (path.isAbsolute(text)) return text
  return path.resolve(stage, text)
}

function normalizePages(pages) {
  if (pages == null) return { ok: true, arg: 'all', list: [] }
  if (typeof pages === 'string') {
    const text = pages.trim()
    if (!text || text === 'all') return { ok: true, arg: 'all', list: [] }
    const parts = text.split(',').map((part) => part.trim())
    if (parts.every((part) => /^[1-9]\d*$/.test(part))) {
      return { ok: true, arg: parts.join(','), list: parts.map(Number) }
    }
    return { ok: false, message: `pages 参数不合法：${pages}` }
  }
  if (Array.isArray(pages)) {
    if (pages.length === 0) return { ok: true, arg: 'all', list: [] }
    const parts = pages.map((page) => String(page).trim())
    if (parts.every((part) => /^[1-9]\d*$/.test(part))) {
      return { ok: true, arg: parts.join(','), list: parts.map(Number) }
    }
    return { ok: false, message: `pages 参数不合法：${JSON.stringify(pages)}` }
  }
  return { ok: false, message: `pages 参数不合法：${String(pages)}` }
}

function resolvePageNumber(image, file, fallback) {
  const direct = Number(image?.page ?? image?.index)
  if (Number.isFinite(direct) && direct > 0) return direct
  const fromName = /page-(\d+)\.png$/i.exec(path.basename(file))
  if (fromName) return Number(fromName[1])
  return fallback
}

/** kit 要求输出目录不存在；生成一个父目录下唯一的 stage 路径。 */
function freshStagePath(outputDir) {
  const parent = path.dirname(outputDir)
  const base = path.basename(outputDir)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(parent, `.${base}.stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(parent, `.${base}.stage-${Date.now().toString(36)}`)
}

/** 删除上一次构建遗留、本次未产出的 page-*.png。 */
function cleanStalePages(outputDir, keep) {
  let entries
  try {
    entries = fs.readdirSync(outputDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (/^page-\d+\.png$/i.test(name) && !keep.has(name)) {
      removeQuietly(path.join(outputDir, name))
    }
  }
}

function removeQuietly(file, options = {}) {
  try {
    fs.rmSync(file, { force: true, ...options })
  } catch {
    // 删除失败不影响主流程
  }
}

function tail(value, max = 600) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `…${text.slice(-max)}` : text
}
