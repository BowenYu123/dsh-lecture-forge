// LectureForge — Notebook (nbformat 4.5) 生成与执行。
//
// buildNotebook 把讲义 Markdown 转成"Markdown 说明 + Python 代码"的 notebook；
// executeNotebook 用 lecturekit.driver 在无 Jupyter 的机器上顺序执行 code 单元，
// 把 stdout / 表达式结果 / 错误写回 outputs，并返回每个单元的执行报告。
//
// 设计约束：
// - 只消费 analyzeMarkdown 的结果（analysis.figures 等），不 import 它；
// - 生成过程纯函数，便于测试；notebookJson 输出稳定（2 空格缩进 + 结尾换行）；
// - 执行失败（Python 缺失、进程超时、被取消）抛 LectureError，单元级异常写进 outputs。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { exists, nowIso, PLUGIN_VERSION, PY_DIR, VENDOR_DIR } from '../paths.mjs'
import { LectureError } from '../projects.mjs'
import { run } from '../runner.mjs'

const PYTHON_LANGS = new Set(['python', 'py', 'python3', 'ipython', 'ipython3'])
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const QUOTE_RE = /^ {0,3}(?:> ?)+/

/** 去掉块引用前缀（`> ` / `>> `），返回引用层内的文本；非引用行原样返回。 */
function unquote(line) {
  const match = QUOTE_RE.exec(line)
  return match ? line.slice(match[0].length) : line
}

/* ------------------------------------------------------------------ *
 * Markdown → cells
 * ------------------------------------------------------------------ */

function normalizeText(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** 从 analysis.figures 构造 图号 映射；找不到时允许按 fig-<n> 的数字后缀兜底。 */
function buildFigureNumbers(analysis) {
  const numbers = new Map()
  const figures = Array.isArray(analysis?.figures) ? analysis.figures : []
  figures.forEach((figure, index) => {
    let number = null
    if (Number.isInteger(figure?.number) && figure.number > 0) {
      number = figure.number
    } else {
      // assetId/id 通常带补零编号（fig-001）；优先用它，避免 figures 数组缺项时
      // 把 fig-003 误当成第 2 张图。
      for (const key of [figure?.assetId, figure?.id]) {
        const digits = typeof key === 'string' ? /^fig[-_]?0*(\d+)$/i.exec(key.trim()) : null
        if (digits) {
          number = Number.parseInt(digits[1], 10)
          break
        }
      }
    }
    if (!number || number <= 0) number = index + 1
    const keys = [figure?.id, figure?.assetId, `fig-${number}`]
    for (const key of keys) {
      if (typeof key !== 'string' || !key.trim()) continue
      const normalized = key.trim()
      numbers.set(normalized, number)
      // assets 用 fig-001 补零，正文引用常写 [@fig-1]，补一个去零别名
      const digits = /^fig[-_]?0*(\d+)$/i.exec(normalized)
      if (digits) numbers.set(`fig-${Number.parseInt(digits[1], 10)}`, number)
    }
  })
  return numbers
}

function figureNumber(target, numbers) {
  if (numbers.has(target)) return numbers.get(target)
  const match = /^fig[-_]?0*(\d+)$/i.exec(target)
  if (match) {
    const number = Number.parseInt(match[1], 10)
    if (Number.isFinite(number) && number > 0) return number
  }
  return null
}

/** 处理单个非围栏行：删属性、换图引用；行内代码保持原样。 */
function cleanInline(line, numbers, warnings) {
  const spans = []
  let text = line.replace(/(`+)([\s\S]*?)\1/g, (whole) => {
    spans.push(whole)
    return `\uE000${spans.length - 1}\uE001`
  })

  text = text.replace(/[ \t]*\{#[^{}\n]*\}/g, '')

  text = text.replace(/\[@([A-Za-z0-9_][A-Za-z0-9_:.\-]*)\]/g, (whole, target) => {
    if (!/^fig[-_]/i.test(target)) return whole // 章节/公式引用暂不改写
    const number = figureNumber(target, numbers)
    if (number == null) {
      warnings.push(`图引用 [@${target}] 找不到编号映射，已保留原文`)
      return whole
    }
    return `图 ${number}`
  })

  return text.replace(/\uE000(\d+)\uE001/g, (_whole, index) => spans[Number(index)] ?? '')
}

/** 清理一段 Markdown（跳过围栏代码与行内代码），去掉讲义私有属性。 */
function cleanMarkdown(text, numbers, warnings) {
  const lines = text.split('\n')
  const out = []
  let fence = null
  for (const line of lines) {
    const match = FENCE_RE.exec(line)
    if (fence) {
      out.push(line)
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length) {
        fence = null
      }
      continue
    }
    if (match) {
      fence = { marker: match[1][0], length: match[1].length }
      out.push(line)
      continue
    }
    out.push(cleanInline(line, numbers, warnings))
  }
  return out.join('\n')
}

function trimBlankLines(text) {
  return text.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '')
}

function makeMarkdownCell(source) {
  return {
    cell_type: 'markdown',
    id: null, // 稍后统一编号
    metadata: {},
    source,
  }
}

function makeCodeCell(source) {
  return {
    cell_type: 'code',
    id: null,
    metadata: { lf: { lang: 'python' } },
    execution_count: null,
    outputs: [],
    source,
  }
}

function scanCells(mdText, numbers, warnings) {
  const lines = normalizeText(mdText).split('\n')
  const cells = []
  let markdown = []
  const flushMarkdown = () => {
    if (!markdown.length) return
    const cleaned = trimBlankLines(cleanMarkdown(markdown.join('\n'), numbers, warnings))
    markdown = []
    if (!cleaned.trim()) return
    const last = cells[cells.length - 1]
    if (last && last.cell_type === 'markdown') {
      last.source = `${last.source.replace(/\s+$/, '')}\n\n${cleaned}`
    } else {
      cells.push(makeMarkdownCell(cleaned))
    }
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const open = FENCE_RE.exec(unquote(line))
    if (!open) {
      markdown.push(line)
      index += 1
      continue
    }

    const marker = open[1][0]
    const length = open[1].length
    const info = open[2].trim()
    const lang = info ? info.split(/\s+/)[0].replace(/[^\w.+#-]/g, '').toLowerCase() : ''
    const indent = /^ */.exec(line)[0].length

    let close = -1
    for (let probe = index + 1; probe < lines.length; probe += 1) {
      const cand = FENCE_RE.exec(unquote(lines[probe]))
      if (cand && cand[1][0] === marker && cand[1].length >= length && !cand[2].trim()) {
        close = probe
        break
      }
    }
    const end = close >= 0 ? close : lines.length
    if (close < 0) warnings.push(`第 ${index + 1} 行的代码围栏没有闭合，已按到文末处理`)
    const body = lines.slice(index + 1, end).map((raw) => {
      const plain = unquote(raw)
      let cut = 0
      while (cut < indent && plain[cut] === ' ') cut += 1
      return plain.slice(cut)
    })

    if (PYTHON_LANGS.has(lang)) {
      flushMarkdown()
      const source = body.join('\n').replace(/\s+$/, '')
      if (source.trim()) cells.push(makeCodeCell(source))
    } else {
      // 非 Python 围栏原样留在 Markdown 单元里（含围栏行与引用前缀）
      markdown.push(...lines.slice(index, close >= 0 ? close + 1 : lines.length))
    }
    index = close >= 0 ? close + 1 : lines.length
  }
  flushMarkdown()
  return cells
}

/** 给每个单元补稳定的 id（nbformat 4.5 要求）。 */
function assignCellIds(cells) {
  return cells.map((cell, index) => ({
    ...cell,
    id: `cell-${index + 1}`,
  }))
}

/* ------------------------------------------------------------------ *
 * 构建 notebook
 * ------------------------------------------------------------------ */

export function buildNotebook({ project, analysis, mdText, assets = [] } = {}) {
  const warnings = []
  const numbers = buildFigureNumbers(analysis)
  const cells = assignCellIds(scanCells(mdText ?? '', numbers, warnings))
  const firstHeading = /^#{1,6}[ \t]+(.+?)[ \t]*$/m.exec(normalizeText(mdText))?.[1] ?? ''
  const title = String(project?.title ?? '').trim() || firstHeading.replace(/[ \t]*\{#[^}]*\}/, '').trim()
  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        name: 'python3',
        display_name: 'Python 3',
        language: 'python',
      },
      language_info: { name: 'python' },
      lf: {
        projectId: String(project?.projectId ?? project?.id ?? ''),
        title,
        generatedAt: nowIso(),
        pluginVersion: PLUGIN_VERSION,
      },
    },
    cells,
  }
  // assets 仅用于保持签名/未来扩展：notebook 中的相对路径 assets/fig-xxx.svg
  // 由 build 阶段复制到 out/assets/，这里不改写路径。
  void assets
  return { notebook, warnings }
}

export function notebookJson(notebook) {
  return `${JSON.stringify(notebook, null, 2)}\n`
}

/* ------------------------------------------------------------------ *
 * 执行 notebook
 * ------------------------------------------------------------------ */

function pythonPathEnv(pyDir) {
  const parts = [pyDir]
  const vendorPy = path.join(VENDOR_DIR, 'py')
  try {
    if (exists(vendorPy)) parts.push(vendorPy)
  } catch {
    // vendor 目录不可用不影响主流程
  }
  return parts.join(path.delimiter)
}

function clampTimeout(value, fallback, min = 1) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(min, Math.round(number))
}

function readReport(text) {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export async function executeNotebook({
  notebook,
  pythonPath,
  cwd,
  pyDir,
  cellTimeoutMs = 60000,
  totalTimeoutMs = 600000,
  signal,
} = {}) {
  if (!notebook || typeof notebook !== 'object' || !Array.isArray(notebook.cells)) {
    throw new LectureError('INVALID_NOTEBOOK', 'executeNotebook 需要合法的 notebook 对象')
  }
  if (typeof pythonPath !== 'string' || !pythonPath.trim()) {
    throw new LectureError('PYTHON_NOT_FOUND', 'executeNotebook 缺少 pythonPath', '检查 Python 运行时配置')
  }
  const cellTimeout = clampTimeout(cellTimeoutMs, 60000, 100)
  const totalTimeout = Math.max(cellTimeout, clampTimeout(totalTimeoutMs, 600000, 100))
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lf-notebook-'))
  const inputFile = path.join(workDir, 'in.ipynb')
  const outputFile = path.join(workDir, 'out.ipynb')
  const reportFile = path.join(workDir, 'report.json')
  const env = {
    PYTHONPATH: pythonPathEnv(pyDir ?? PY_DIR),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }

  try {
    await fs.writeFile(inputFile, notebookJson(notebook), 'utf8')
    const args = [
      '-m',
      'lecturekit.driver',
      '--input',
      inputFile,
      '--output',
      outputFile,
      '--report',
      reportFile,
      '--cell-timeout',
      String(cellTimeout),
      '--total-timeout',
      String(totalTimeout),
    ]
    const result = await run(pythonPath, args, {
      cwd: cwd ?? workDir,
      env,
      timeoutMs: totalTimeout + 30000,
      signal,
      windowsHide: true,
    })

    const stderr = String(result.stderr ?? '').trim()
    if (result.spawnError) {
      throw new LectureError(
        'PYTHON_NOT_FOUND',
        `无法启动 Python：${pythonPath}`,
        String(result.spawnError?.message ?? result.spawnError),
      )
    }
    if (result.aborted) {
      throw new LectureError('IPYNB_ABORTED', 'Notebook 执行已取消')
    }
    if (result.timedOut) {
      throw new LectureError(
        'IPYNB_TIMEOUT',
        `Notebook 执行超过 ${totalTimeout + 30000} ms 被终止`,
        stderr || undefined,
      )
    }
    if (result.code !== 0) {
      throw new LectureError(
        'IPYNB_EXEC_FAILED',
        `lecturekit.driver 退出码 ${result.code}`,
        stderr || undefined,
      )
    }

    let executedNotebook
    try {
      executedNotebook = JSON.parse(await fs.readFile(outputFile, 'utf8'))
    } catch (error) {
      throw new LectureError(
        'IPYNB_EXEC_FAILED',
        `没有读到执行后的 notebook：${error instanceof Error ? error.message : String(error)}`,
        stderr || undefined,
      )
    }

    let report = null
    try {
      report = readReport(await fs.readFile(reportFile, 'utf8'))
    } catch {
      report = null
    }
    if (!report) {
      // driver 没写 report 时按"全部成功"退化，避免整次构建失败
      report = {
        executed: 0,
        failed: 0,
        cells: [],
        warnings: ['lecturekit.driver 没有生成 report.json，执行结果可能不完整'],
      }
    }
    const warnings = Array.isArray(report.warnings)
      ? report.warnings.map((item) => String(item))
      : []
    if (stderr) warnings.push(`driver stderr: ${stderr}`)
    return {
      notebook: executedNotebook,
      executed: Number(report.executed) || 0,
      failed: Number(report.failed) || 0,
      cells: Array.isArray(report.cells) ? report.cells : [],
      warnings,
      run: {
        code: result.code ?? 0,
        stderr,
        timedOut: Boolean(result.timedOut),
      },
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
