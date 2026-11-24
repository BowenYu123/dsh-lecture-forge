// LectureForge — 用本机 Chromium/Edge 把 HTML 打印成 PDF。
//
// 说明：不依赖 puppeteer；直接调用浏览器的 --headless --print-to-pdf，输出后校验
// 文件存在、以 %PDF- 开头且体积 > 1KB。失败重试一次（换随机 user-data-dir，
// 避免首次运行残留的 profile 锁）。pages 只是用正则数 /Type /Page 的粗略估算，
// 不作为审计依据（精确页数由 qa.renderPdfPages 的 manifest 提供）。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { run } from '../runner.mjs'
import { ensureDir } from '../paths.mjs'

const MIN_PDF_BYTES = 1024
const PDF_MAGIC = '%PDF-'

/**
 * @param {{
 *   htmlPath: string,
 *   pdfPath: string,
 *   chromiumPath: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   tmpDir?: string,
 * }} options
 * @returns {Promise<{ok: boolean, code?: string|number, message?: string, pages?: number|null}>}
 */
export async function printHtmlToPdf({ htmlPath, pdfPath, chromiumPath, timeoutMs = 180000, signal, tmpDir } = {}) {
  const failure = (code, message) => ({ ok: false, code, message })

  if (!htmlPath || !pdfPath) return failure('INVALID_ARGUMENT', '缺少 htmlPath 或 pdfPath。')
  if (!chromiumPath) return failure('BROWSER_MISSING', '没有提供 Chromium/Edge 可执行文件路径。')

  const htmlFile = absolutePathFromInput(htmlPath)
  const pdfFile = path.resolve(String(pdfPath))
  if (!fs.existsSync(htmlFile)) return failure('HTML_NOT_FOUND', `HTML 文件不存在：${htmlFile}`)
  if (!fs.existsSync(String(chromiumPath))) {
    return failure('BROWSER_MISSING', `找不到浏览器可执行文件：${chromiumPath}`)
  }

  ensureDir(path.dirname(pdfFile))
  const workDir = tmpDir ? path.resolve(String(tmpDir)) : path.join(path.dirname(pdfFile), '.tmp', 'print-pdf')
  ensureDir(workDir)

  // 旧文件必须先删除，否则浏览器崩溃后残留的 PDF 会被误判为成功。
  removeQuietly(pdfFile)

  const profiles = []
  const errors = []
  const fileUrl = pathToFileURL(htmlFile).href

  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (signal?.aborted) return failure('ABORTED', 'PDF 生成已取消。')

      const profileDir = path.join(workDir, `chromium-profile-${randomId()}`)
      ensureDir(profileDir)
      profiles.push(profileDir)

      const args = [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--no-pdf-header-footer',
        '--virtual-time-budget=30000',
        `--user-data-dir=${profileDir}`,
        `--print-to-pdf=${pdfFile}`,
        fileUrl,
      ]
      const result = await run(String(chromiumPath), args, {
        timeoutMs,
        signal,
        windowsHide: true,
        maxOutputBytes: 4 * 1024 * 1024,
      })

      if (result.aborted) return failure('ABORTED', 'PDF 生成已取消。')
      if (result.spawnError) {
        errors.push(`无法启动浏览器：${result.spawnError}`)
        break // 可执行文件本身有问题，重试没有意义
      }

      const verdict = verifyPdf(pdfFile)
      if (verdict.ok) {
        const pages = countPdfPages(pdfFile)
        const response = { ok: true, code: result.code ?? 0, pages }
        if (result.timedOut && pages == null) response.message = '浏览器等待超时，但已生成 PDF。'
        return response
      }
      errors.push(`${verdict.code}：${verdict.message}（浏览器退出码 ${result.code ?? '未知'}）`)
      removeQuietly(pdfFile) // 坏文件清掉，避免第二次误判
    }
  } finally {
    for (const profileDir of profiles) removeQuietly(profileDir, { recursive: true })
  }

  return failure('PDF_FAILED', errors.length > 0 ? errors.join('；') : 'PDF 生成失败。')
}

function absolutePathFromInput(value) {
  const text = String(value)
  if (/^file:/i.test(text)) return fileURLToPath(text)
  return path.resolve(text)
}

function verifyPdf(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return { ok: false, code: 'PDF_MISSING', message: `未生成 PDF：${file}` }
  }
  if (!stat.isFile()) return { ok: false, code: 'PDF_MISSING', message: `输出不是文件：${file}` }
  if (stat.size <= MIN_PDF_BYTES) {
    return { ok: false, code: 'PDF_TOO_SMALL', message: `PDF 体积异常（${stat.size} 字节）：${file}` }
  }
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(PDF_MAGIC.length)
    const read = fs.readSync(fd, head, 0, head.length, 0)
    if (read < head.length || head.toString('latin1') !== PDF_MAGIC) {
      return { ok: false, code: 'PDF_INVALID', message: `输出不是有效的 PDF（缺少 %PDF- 头）：${file}` }
    }
  } finally {
    fs.closeSync(fd)
  }
  return { ok: true }
}

/** 粗略页数估算：数 /Type /Page（排除 /Pages）。可能因对象流压缩返回 null。 */
function countPdfPages(file) {
  try {
    const text = fs.readFileSync(file).toString('latin1')
    const matches = text.match(/\/Type\s*\/Page\b/g)
    return matches && matches.length > 0 ? matches.length : null
  } catch {
    return null
  }
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function removeQuietly(file, options = {}) {
  try {
    fs.rmSync(file, { force: true, ...options })
  } catch {
    // Chromium 可能仍占用 profile，忽略清理失败
  }
}
