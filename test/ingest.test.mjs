// LectureForge — 素材摄取测试（node --test test/ingest.test.mjs）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import zlib from 'node:zlib'
import { ingestPath } from '../lib/ingest/index.mjs'
import { PYTHON, ROOT, fixture, tmpDir } from './helpers/env.mjs'
import { crc32, createZip } from './helpers/zip.mjs'

const CONFIG = { maxPages: 400, maxFileBytes: 200 * 1024 * 1024, lowTextCharThreshold: 80 }
const RUNTIME = { python: { command: PYTHON } }
const tempDirs = []

function tempDir(name) {
  const dir = tmpDir(name)
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

test('Markdown：heading/text 顺序、section 递增与 id 格式', async () => {
  const dir = tempDir('md')
  const file = path.join(dir, 'sample.md')
  fs.writeFileSync(
    file,
    [
      '# 第一章 导论',
      '',
      '这是第一章的正文，用来验证段落块能够按顺序输出。',
      '',
      '## 1.1 研究背景',
      '',
      '这是第二节的正文，内容同样足够形成一个文本块。',
      '',
      '- 要点一',
      '- 要点二',
      '',
    ].join('\n'),
    'utf8',
  )

  const result = await ingestPath({ file, sourceId: 'S01', config: CONFIG })
  assert.equal(result.kind, 'md')
  assert.equal(result.label, 'sample.md')
  assert.equal(result.structure.sections, 2)
  assert.ok(result.blocks.length >= 4)

  const headings = result.blocks.filter((block) => block.kind === 'heading')
  assert.deepEqual(
    headings.map((block) => block.text),
    ['第一章 导论', '1.1 研究背景'],
  )
  assert.deepEqual(
    headings.map((block) => block.section),
    [1, 2],
  )
  assert.equal(result.blocks[0].kind, 'heading')
  assert.ok(result.blocks.some((block) => block.kind === 'text' && block.section === 2))
  assert.ok(result.blocks.every((block) => /^S01#s\d{2}-b\d{2}$/.test(block.id)))
  assertGlobalBlockNumbers(result.blocks)
  assert.ok(result.blocks.every((block) => block.chars === block.text.length))
  assert.deepEqual(result.lowTextPages, [])
})

test('HTML：section/heading/table/本地图片', async () => {
  const dir = tempDir('html')
  const image = makePng(80, 80)
  fs.writeFileSync(path.join(dir, 'pic.png'), image)
  const file = path.join(dir, 'sample.html')
  fs.writeFileSync(
    file,
    [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>网页样本</title></head><body>',
      '<nav>导航应被移除</nav>',
      '<h1>第一章</h1><p>这是网页的第一段正文。</p>',
      '<h2>数据表</h2>',
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
      '<figure><img src="pic.png" alt="示意图"><figcaption>图一说明</figcaption></figure>',
      '<script>console.log("should be removed")</script>',
      '</body></html>',
    ].join('\n'),
    'utf8',
  )

  const result = await ingestPath({ file, sourceId: 'S01', config: CONFIG })
  assert.equal(result.kind, 'html')
  assert.equal(result.structure.sections, 2)
  assert.equal(result.metadata.title, '网页样本')
  assert.equal(result.metadata.language, 'zh-CN')

  const headingTexts = result.blocks.filter((block) => block.kind === 'heading').map((block) => block.text)
  assert.deepEqual(headingTexts, ['第一章', '数据表'])
  assert.ok(result.blocks.every((block) => !block.text.includes('导航应被移除')))
  assert.ok(result.blocks.every((block) => !block.text.includes('should be removed')))

  const table = result.blocks.find((block) => block.kind === 'table')
  assert.ok(table)
  assert.equal(table.section, 2)
  assert.equal(table.text, 'A | B\n1 | 2')

  const figureBlock = result.blocks.find((block) => block.kind === 'figure')
  assert.ok(figureBlock)
  assert.equal(figureBlock.text, '示意图')
  assert.equal(figureBlock.section, 2)
  assert.equal(result.figures.length, 1)
  assert.equal(result.figures[0].type, 'png')
  assert.equal(result.figures[0].width, 80)
  assert.equal(result.figures[0].height, 80)
  assert.ok(result.figures[0].data.length > 4096)
  assert.ok(result.blocks.every((block) => /^S01#s\d{2}-b\d{2}$/.test(block.id)))
  assertGlobalBlockNumbers(result.blocks)
})

test('DOCX：标题、段落与表格（自写 zip）', async () => {
  const dir = tempDir('docx')
  const xml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 标题</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>这是第一段正文，内容足够长。</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>第二节 标题</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>这是第二段正文。</w:t></w:r></w:p>',
    '<w:tbl>',
    '<w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>',
    '<w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr>',
    '</w:tbl>',
    '</w:body></w:document>',
  ].join('')
  const file = path.join(dir, 'sample.docx')
  fs.writeFileSync(
    file,
    createZip({
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      'word/document.xml': xml,
    }),
  )

  const result = await ingestPath({ file, sourceId: 'S01', config: CONFIG })
  assert.equal(result.kind, 'docx')
  assert.equal(result.structure.sections, 2)
  assert.deepEqual(
    result.blocks.filter((block) => block.kind === 'heading').map((block) => block.text),
    ['第一章 标题', '第二节 标题'],
  )
  assert.deepEqual(
    result.blocks.filter((block) => block.kind === 'heading').map((block) => block.section),
    [1, 2],
  )
  const table = result.blocks.find((block) => block.kind === 'table')
  assert.ok(table)
  assert.equal(table.text, 'A | B\n1 | 2')
  assert.equal(table.section, 2)
  assert.ok(result.blocks.every((block) => /^S01#s\d{2}-b\d{2}$/.test(block.id)))
  assertGlobalBlockNumbers(result.blocks)
})

test('PPTX：slide 编号、标题与正文', async () => {
  const dir = tempDir('pptx')
  const ns =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
  const shape = (text, title = false) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${title ? 'Title 1' : 'Content 2'}"/>` +
    `<p:nvPr>${title ? '<p:ph type="title"/>' : ''}</p:nvPr></p:nvSpPr>` +
    `<p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
  const slide = (title, body) =>
    `<p:sld ${ns}><p:cSld><p:spTree>${shape(title, true)}${shape(body)}</p:spTree></p:cSld></p:sld>`
  const file = path.join(dir, 'sample.pptx')
  fs.writeFileSync(
    file,
    createZip({
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      'ppt/slides/slide1.xml': slide('第一页标题', '第一页正文'),
      'ppt/slides/slide2.xml': slide('第二页标题', '第二页正文'),
    }),
  )

  const result = await ingestPath({ file, sourceId: 'S01', config: CONFIG })
  assert.equal(result.kind, 'pptx')
  assert.equal(result.structure.slides, 2)
  assert.equal(result.structure.sections, 2)
  const headings = result.blocks.filter((block) => block.kind === 'heading')
  assert.deepEqual(
    headings.map((block) => block.text),
    ['第一页标题', '第二页标题'],
  )
  assert.deepEqual(
    headings.map((block) => block.section),
    [1, 2],
  )
  const texts = result.blocks.filter((block) => block.kind === 'text').map((block) => block.text)
  assert.deepEqual(texts, ['第一页正文', '第二页正文'])
  assert.ok(result.blocks.every((block) => /^S01#s\d{2}-b\d{2}$/.test(block.id)))
  assertGlobalBlockNumbers(result.blocks)
})

test('PDF：文本层抽取、页码 block 与每页覆盖', async (t) => {
  const pdfPath = fixture('sample-2page.pdf')
  try {
    if (!fs.existsSync(pdfPath)) generateSamplePdf(pdfPath)
  } catch (error) {
    t.skip(`Edge 生成 PDF 失败：${String(error?.message ?? error)}`)
    return
  }

  const result = await ingestPath({ file: pdfPath, sourceId: 'S01', config: CONFIG, runtime: RUNTIME })
  assert.equal(result.kind, 'pdf')
  assert.ok(result.structure.pages >= 1)
  assert.ok(result.blocks.length > 0)
  assert.ok(result.blocks.every((block) => /^S01#p\d{3}-b\d{2}$/.test(block.id)))
  assert.ok(result.blocks.every((block) => Number.isInteger(block.page) && block.page >= 1))
  assert.ok(result.blocks.every((block) => block.section === null))
  assert.ok(result.blocks.every((block) => block.provenance === 'textlayer'))
  for (let page = 1; page <= result.structure.pages; page += 1) {
    assert.ok(
      result.blocks.some((block) => block.page === page) || result.lowTextPages.includes(page),
      `第 ${page} 页既没有 block，也不在 lowTextPages 中`,
    )
  }
  assert.ok(
    result.blocks.every(
      (block) =>
        block.confidence === (result.lowTextPages.includes(block.page) ? 'low' : 'high') &&
        block.needsVision === result.lowTextPages.includes(block.page),
    ),
  )
  assert.ok(result.blocks.every((block) => block.chars <= 4000))
  assertGlobalBlockNumbers(result.blocks)
})

function assertGlobalBlockNumbers(blocks) {
  const numbers = blocks.map((block) => {
    const match = /-b(\d+)$/.exec(block.id)
    assert.ok(match, `block id 缺少块号：${block.id}`)
    return Number(match[1])
  })
  assert.deepEqual(
    numbers,
    numbers.map((_, index) => index + 1),
    'block 编号应跨页/章节全局递增',
  )
}

function makePng(width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const index = row + 1 + x * 4
      raw[index] = (x * 73 + y * 151) & 0xff
      raw[index + 1] = (x * 191 + y * 37) & 0xff
      raw[index + 2] = (x * 29 + y * 223) & 0xff
      raw[index + 3] = 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function generateSamplePdf(target) {
  const edgeCandidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  const edge = edgeCandidates.find((candidate) => candidate && fs.existsSync(candidate))
  if (!edge) throw new Error('未找到 Edge（msedge.exe）')
  const dir = tempDir('pdf-generate')
  const htmlPath = path.join(dir, 'sample.html')
  const generated = path.join(dir, 'sample.pdf')
  fs.writeFileSync(
    htmlPath,
    [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<style>@page{size:A4;margin:18mm} body{font-family:sans-serif;font-size:16px}',
      '.page{page-break-after:always}</style></head><body>',
      '<h1>Page One Heading</h1>',
      '<p>This is the first page with enough text for the PDF text layer. ' +
        'LectureForge should assign this paragraph to the first page.</p>',
      '<div class="page"></div>',
      '<h1>Page Two Heading</h1>',
      '<p>This is the second page. It also contains readable text so that the ' +
        'extraction pipeline produces blocks for the second page.</p>',
      '</body></html>',
    ].join('\n'),
    'utf8',
  )
  const result = spawnSync(
    edge,
    ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${generated}`, htmlPath],
    { timeout: 60000, windowsHide: true, encoding: 'utf8' },
  )
  if (!fs.existsSync(generated) || fs.statSync(generated).size < 1000) {
    throw new Error(`Edge 未生成有效 PDF（status=${result.status}）：${result.stderr ?? ''}`)
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(generated, target)
  assert.ok(fs.existsSync(target))
}
