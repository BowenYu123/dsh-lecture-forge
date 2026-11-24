// LectureForge — Chromium 打印 PDF 与 LibreOffice Kit 页面渲染测试。
//
// 本机没有 Edge/Chromium 或 LibreOffice Kit 时对应测试 skip（并打印原因）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture, tmpDir } from './helpers/env.mjs'
import { printHtmlToPdf } from '../lib/render/pdf.mjs'
import { renderPdfPages } from '../lib/render/qa.mjs'
import { renderMath, katexCss } from '../lib/render/math.mjs'

const BROWSER_CANDIDATES =
  process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const BROWSER = BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null

const RESOURCES = process.env.DSH_RESOURCES || process.resourcesPath || null
const KIT_CLI = RESOURCES
  ? path.join(RESOURCES, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')
  : null
const KIT_NODE = RESOURCES
  ? path.join(
      RESOURCES,
      'runtime',
      'primary-runtime',
      'dependencies',
      'node',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    )
  : null

const MATH = renderMath('\\int_0^1 x^2\\,dx = \\frac{1}{3}', { display: true })

function buildHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PDF 渲染测试</title>
<style id="katex-css">${katexCss({ embedFonts: true })}</style>
<style>
  body { margin: 20mm; font-family: "SimSun", serif; font-size: 12pt; line-height: 1.7; }
  h1 { font-size: 20pt; }
  .katex-display { margin: 1.2em 0; }
</style>
</head>
<body>
<h1>PDF 渲染测试</h1>
<p>中文段落，用于验证字体回退与 PDF 输出。</p>
${MATH.html}
<p>最后一行。</p>
</body>
</html>`
}

let workDir = null
let pdfPath = null

test('printHtmlToPdf：Chromium/Edge 生成有效 PDF', { timeout: 180000 }, async (t) => {
  if (!BROWSER) {
    t.skip('未找到 Edge/Chrome/Chromium，跳过浏览器打印测试。')
    return
  }

  workDir = tmpDir('render-pdf')
  const htmlPath = path.join(workDir, 'lecture.html')
  pdfPath = path.join(workDir, 'lecture.pdf')
  fs.writeFileSync(htmlPath, buildHtml(), 'utf8')

  const result = await printHtmlToPdf({
    htmlPath,
    pdfPath,
    chromiumPath: BROWSER,
    timeoutMs: 180000,
    tmpDir: workDir,
  })
  assert.equal(result.ok, true, `打印失败：${result.message ?? JSON.stringify(result)}`)
  assert.ok(fs.existsSync(pdfPath), 'PDF 文件不存在')

  const buffer = fs.readFileSync(pdfPath)
  assert.ok(buffer.length > 1024, `PDF 体积异常：${buffer.length}`)
  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.ok(result.pages === null || result.pages >= 1, `页数估算异常：${result.pages}`)
})

test('renderPdfPages：LibreOffice Kit 渲染 PDF 第 1 页为 PNG', { timeout: 180000 }, async (t) => {
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    // 没有浏览器时用内置两页样例 PDF，保证 Kit 渲染路径在 macOS/Linux 上也被执行。
    const sample = fixture('sample-2page.pdf')
    if (!fs.existsSync(sample)) {
      t.skip('PDF 未生成且缺少样例 PDF，跳过页面渲染测试。')
      return
    }
    pdfPath = sample
    workDir = workDir ?? tmpDir('render-qa')
  }
  if (!KIT_CLI || !fs.existsSync(KIT_CLI)) {
    t.skip(`缺少 LibreOffice Kit cli：${KIT_CLI}`)
    return
  }

  const node = fs.existsSync(KIT_NODE) ? KIT_NODE : process.execPath
  const outDir = path.join(workDir, 'pages')
  const result = await renderPdfPages({
    pdfPath,
    outDir,
    pages: [1],
    dpi: 144,
    kit: { node, cli: KIT_CLI, electronAsNode: node === process.execPath && Boolean(process.versions.electron) },
  })

  assert.equal(result.ok, true, `页面渲染失败：${result.message ?? JSON.stringify(result)}`)
  assert.ok(result.pageCount >= 1, `pageCount 异常：${result.pageCount}`)
  assert.ok(Array.isArray(result.missingFonts))
  assert.equal(result.pages.length, 1)
  assert.equal(result.pages[0].page, 1)
  assert.ok(fs.existsSync(result.pages[0].file), `PNG 不存在：${result.pages[0].file}`)

  const png = fs.readFileSync(result.pages[0].file).subarray(0, 8)
  assert.equal(png.toString('hex'), '89504e470d0a1a0a', '输出不是 PNG')
  assert.ok(fs.statSync(result.pages[0].file).size > 1024)
})
