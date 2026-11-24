// LectureForge — PDF 摄取：Python 子进程抽文本/图片，Node 侧只做组织与校验。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pythonEnv, probeRuntime } from '../config.mjs'
import { LectureError } from '../projects.mjs'
import { run } from '../runner.mjs'
import { sniffImage } from './detect.mjs'

const SCRIPT = fileURLToPath(new URL('../../py/extract_pdf.py', import.meta.url))
const IMAGE_LIMIT = 20 * 1024 * 1024
const MAX_FIGURES = 80
const PYTHON_TIMEOUT_MS = 120000

const HINTS = {
  ENCRYPTED_PDF: '请先用 PDF 阅读器移除密码保护，或另存为无密码版本后再试。',
  PYPDF_MISSING: '请检查插件内置的 pypdf（assets/vendor/py）是否完整，或在配置里指定带 pypdf 的 Python。',
  PARSE_FAILED: '请确认 PDF 未损坏；可以尝试用其他工具另存一份后重试。',
  PDF_TIMEOUT: 'PDF 过大或过于复杂，可调低 maxPages 后重试。',
}

/**
 * @param {{file:string, config:object, runtime?:object|null, signal?:AbortSignal|null,
 *   warnings?:string[]}} input
 */
export async function parsePdf({ file, config = {}, runtime = null, signal = null, warnings = [] } = {}) {
  const activeRuntime = runtime ?? probeRuntime(config)
  const python =
    activeRuntime?.python?.command ||
    activeRuntime?.python?.path ||
    config.pythonPath ||
    process.env.DSH_PYTHON ||
    'python'
  const maxPages = Number.isFinite(config.maxPages) ? config.maxPages : 400

  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lectureforge-pdf-'))
  const imageDir = path.join(tmpRoot, 'images')
  const outputFile = path.join(tmpRoot, 'extract.json')
  await fs.promises.mkdir(imageDir, { recursive: true })

  try {
    const result = await run(
      python,
      [
        SCRIPT,
        '--input',
        path.resolve(file),
        '--output',
        outputFile,
        '--max-pages',
        String(maxPages),
        '--image-dir',
        imageDir,
      ],
      {
        env: pythonEnv(),
        timeoutMs: PYTHON_TIMEOUT_MS,
        signal: signal ?? undefined,
      },
    )

    if (result.aborted) {
      throw new LectureError('ABORTED', 'PDF 摄取已取消。')
    }
    if (result.timedOut) {
      throw new LectureError(
        'PDF_TIMEOUT',
        `PDF 解析超过 ${Math.round(PYTHON_TIMEOUT_MS / 1000)} 秒。`,
        HINTS.PDF_TIMEOUT,
      )
    }
    if (result.spawnError) {
      const code = /ENOENT|not found/i.test(result.spawnError) ? 'PYTHON_MISSING' : 'PDF_EXTRACT_FAILED'
      throw new LectureError(
        code,
        `无法启动 Python 解析 PDF：${result.spawnError}`,
        code === 'PYTHON_MISSING' ? '请安装 Python 或在配置里设置 pythonPath。' : undefined,
      )
    }

    const payload = readPayload(result, outputFile)
    if (!payload || payload.ok !== true) {
      const code = payload?.code || 'PARSE_FAILED'
      throw new LectureError(
        code,
        payload?.message || `PDF 解析失败（退出码 ${result.code ?? '未知'}）。`,
        HINTS[code],
      )
    }

    const pages = Array.isArray(payload.pages) ? payload.pages : []
    const threshold = Number.isFinite(config.lowTextCharThreshold) ? config.lowTextCharThreshold : 80
    const lowTextPages = []
    const units = []
    for (const page of pages) {
      const pageNumber = Number(page.page)
      const text = String(page.text ?? '').replace(/\r\n?/g, '\n').trim()
      const chars = Number.isFinite(page.chars) ? page.chars : text.length
      if (chars < threshold) lowTextPages.push(pageNumber)
      if (!text) continue
      for (const paragraph of splitPageText(text)) {
        units.push({ page: pageNumber, section: null, kind: 'text', text: paragraph })
      }
    }

    const totalChars = pages.reduce((sum, page) => {
      const text = String(page.text ?? '')
      return sum + (Number.isFinite(page.chars) ? page.chars : text.length)
    }, 0)
    if (pages.length > 0 && totalChars < Math.max(threshold, pages.length * 40)) {
      warnings.push(
        `PDF 文本层字符极少（${totalChars} 字符 / ${pages.length} 页），疑似扫描件，需尝试视觉兜底。`,
      )
    }

    const figures = []
    const seen = new Set()
    for (const item of Array.isArray(payload.figures) ? payload.figures : []) {
      if (figures.length >= MAX_FIGURES) {
        warnings.push(`PDF 内嵌图片超过 ${MAX_FIGURES} 张，其余已跳过。`)
        break
      }
      const name = path.basename(String(item.file ?? ''))
      if (!name) continue
      const absolute = path.resolve(imageDir, name)
      if (!absolute.startsWith(path.resolve(imageDir) + path.sep)) continue
      let data
      try {
        const stat = await fs.promises.stat(absolute)
        if (!stat.isFile() || stat.size > IMAGE_LIMIT) {
          warnings.push(`PDF 图片超过 20MB 或不存在，已跳过：${name}`)
          continue
        }
        data = await fs.promises.readFile(absolute)
      } catch (error) {
        warnings.push(`PDF 图片读取失败（${name}）：${String(error?.message ?? error)}`)
        continue
      }
      if (data.length < 4096) continue
      const info = sniffImage(data)
      if (!info.type) {
        warnings.push(`PDF 图片格式不受支持，已跳过：${name}`)
        continue
      }
      const digest = Buffer.from(data).toString('base64')
      if (seen.has(digest)) continue
      seen.add(digest)
      figures.push({
        page: Number.isFinite(item.page) ? item.page : null,
        imageIndex: figures.length,
        type: info.type,
        data,
        width: Number.isFinite(item.width) ? item.width : info.width,
        height: Number.isFinite(item.height) ? item.height : info.height,
      })
    }

    for (const warning of Array.isArray(payload.warnings) ? payload.warnings : []) {
      if (typeof warning === 'string' && warning.trim()) warnings.push(warning.trim())
    }

    const metadata = {
      ...(payload.metadata?.title ? { title: String(payload.metadata.title) } : {}),
      ...(payload.metadata?.author ? { author: String(payload.metadata.author) } : {}),
      pages: pages.length,
    }

    return {
      units,
      figures,
      metadata,
      structure: { pages: pages.length },
      lowTextPages,
      warnings,
      kind: 'pdf',
    }
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
}

function readPayload(result, outputFile) {
  const stdout = String(result.stdout ?? '').trim()
  if (stdout) {
    const start = stdout.indexOf('{')
    const end = stdout.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stdout.slice(start, end + 1))
      } catch {
        /* 再尝试输出文件 */
      }
    }
  }
  try {
    if (fs.existsSync(outputFile)) {
      return JSON.parse(fs.readFileSync(outputFile, 'utf8'))
    }
  } catch {
    /* 忽略，交给调用方报错 */
  }
  const stderr = String(result.stderr ?? '').trim()
  if (stderr) {
    const short = stderr.length > 800 ? `…${stderr.slice(-800)}` : stderr
    throw new LectureError(
      'PARSE_FAILED',
      `PDF 解析子进程失败（退出码 ${result.code ?? '未知'}）：${short}`,
      HINTS.PARSE_FAILED,
    )
  }
  return null
}

function splitPageText(text) {
  const normalized = String(text ?? '').trim()
  if (!normalized) return []
  return normalized
    .split(/\n\s*\n+/)
    .map((part) => part.replace(/[ \t]+\n/g, '\n').trim())
    .filter(Boolean)
}
