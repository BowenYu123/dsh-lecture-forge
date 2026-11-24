// LectureForge — 完整 HTML 文档测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../lib/render/markdown.mjs'
import { renderHtmlDocument } from '../lib/render/html.mjs'

const MARKDOWN = [
  '# 第二章 极限 {#sec-2}',
  '',
  '导言，参考 [S01, p.3]。',
  '',
  '## 2.1 极限的定义 {#sec-2-1}',
  '',
  '设 $\\varepsilon>0$，见 [@fig-3] 与 [@sec-2-1]。',
  '',
  '$$\\lim_{x \\to a} f(x) = L$$ {#eq-5}',
  '',
  '![图 3 函数图像](assets/fig-003.svg){#fig-3 width=70%}',
  '',
  '![示意图](assets/fig-004.png){#fig-4}',
].join('\n')

const { html: BODY_HTML, analysis } = renderMarkdown(MARKDOWN)

const PROJECT = {
  title: '极限与连续 <讲义>',
  goal: '理解 ε-δ 定义',
  subject: '数学分析',
  learnerLevel: 'advanced',
  language: 'zh',
  depth: 'deep',
}

const EXTRAS = {
  sources: [{ sourceId: 'S01', label: '数学分析讲义', kind: 'pdf', pages: 12, blocks: 34 }],
  coverage: {
    total: 10,
    covered: 7,
    merged: 1,
    blocked: 2,
    pending: 0,
    percent: 80,
    perSource: [
      {
        sourceId: 'S01',
        label: '数学分析讲义',
        blocks: 10,
        covered: 7,
        merged: 1,
        blocked: 2,
        pending: 0,
        percent: 80,
      },
    ],
  },
  blockedBlocks: [{ blockId: 'B-009', sourceId: 'S01', page: '7', text: '图注 <无法解析>' }],
  reviewNotes: ['第 7 页图注缺失，已按上下文补全。'],
  figures: analysis.figures,
  assetDataUrls: {
    'fig-003': 'data:image/svg+xml;base64,PHN2Zy8+',
    'fig-004': 'data:image/png;base64,iVBORw0KGgo=',
  },
  generatedAt: '2026-11-04T12:00:00+08:00',
}

test('renderHtmlDocument：完整、自包含的 HTML 文档骨架', () => {
  const { html, warnings } = renderHtmlDocument({
    project: PROJECT,
    analysis,
    bodyHtml: BODY_HTML,
    extras: EXTRAS,
  })

  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(html.trimEnd().endsWith('</html>'))
  assert.match(html, /<html lang="zh-CN">/)
  assert.ok(html.includes('<title>极限与连续 &lt;讲义&gt;</title>'))
  assert.ok(html.includes('content="极限与连续 &lt;讲义&gt;"'))

  // 三个样式块全部内联；KaTeX 字体以 base64 嵌入，打印样式带 @page A4。
  assert.match(html, /<style id="katex-css">/)
  assert.match(html, /<style id="lecture-css">/)
  assert.match(html, /<style id="print-css" media="print">/)
  assert.ok(html.includes('data:font/woff2'))
  assert.ok(html.includes('.lf-cover'))
  assert.match(html, /@page\s*\{[^}]*size:\s*A4/)
  assert.match(html, /margin:\s*18mm 16mm 20mm/)
  assert.match(html, /h2\s*\{[^}]*page-break-before:\s*always/)

  // 不依赖外部资源。
  assert.ok(!html.includes('<link'))
  assert.ok(!html.includes('<script'))
  assert.deepEqual(warnings, [])
})

test('renderHtmlDocument：封面、素材清单与元信息', () => {
  const { html } = renderHtmlDocument({ project: PROJECT, analysis, bodyHtml: BODY_HTML, extras: EXTRAS })

  assert.ok(html.includes('<h1 class="lf-title">极限与连续 &lt;讲义&gt;</h1>'))
  assert.ok(html.includes('<p class="lf-subtitle">理解 ε-δ 定义</p>'))
  assert.ok(html.includes('<dt>主题</dt><dd>数学分析</dd>'))
  assert.ok(html.includes('<dt>学习者</dt><dd>进阶</dd>'))
  assert.ok(html.includes('<dt>语言</dt><dd>中文</dd>'))
  assert.ok(html.includes('<dt>深度</dt><dd>深入</dd>'))
  assert.ok(html.includes('生成时间：'))
  assert.ok(html.includes('2026-11-04'))

  // 素材清单：sourceId + label + blocks/pages。
  assert.ok(html.includes('<td class="col-id">S01</td>'))
  assert.ok(html.includes('<td>数学分析讲义</td>'))
  assert.ok(html.includes('<td class="col-num">12</td>'))
  assert.ok(html.includes('<td class="col-num">34</td>'))
})

test('renderHtmlDocument：目录只收 level>=2，图目录按渲染编号', () => {
  const { html } = renderHtmlDocument({ project: PROJECT, analysis, bodyHtml: BODY_HTML, extras: EXTRAS })

  assert.match(html, /<a class="toc-link" href="#sec-2-1">2\.1 极限的定义<\/a>/)
  assert.match(html, /<li class="lf-toc-item lf-toc-level-2">/)
  // 一级标题（章节）不进目录。
  assert.ok(!html.includes('<a class="toc-link" href="#sec-2">'))

  assert.match(html, /<a class="toc-link" href="#fig-3">图 1　函数图像<\/a>/)
  assert.match(html, /<a class="toc-link" href="#fig-4">图 2　示意图<\/a>/)
})

test('renderHtmlDocument：附录 A/B/C 内容', () => {
  const { html } = renderHtmlDocument({ project: PROJECT, analysis, bodyHtml: BODY_HTML, extras: EXTRAS })

  assert.ok(html.includes('附录 A　未覆盖来源'))
  assert.ok(html.includes('<td class="col-id">B-009</td>'))
  assert.ok(html.includes('<td class="col-num">7</td>'))
  assert.ok(html.includes('图注 &lt;无法解析&gt;'))

  assert.ok(html.includes('附录 B　素材覆盖统计'))
  assert.ok(html.includes('共 <strong>10</strong> 块素材'))
  assert.ok(html.includes('覆盖率 <strong>80%</strong>'))
  assert.ok(html.includes('<td class="col-id">S01</td>'))
  assert.ok(html.includes('<td class="col-num">80%</td>'))

  assert.ok(html.includes('附录 C　复核说明'))
  assert.ok(html.includes('第 7 页图注缺失，已按上下文补全。'))
})

test('renderHtmlDocument：图片 data URL 内联，缺失时保留路径并告警', () => {
  const inlined = renderHtmlDocument({ project: PROJECT, analysis, bodyHtml: BODY_HTML, extras: EXTRAS })
  assert.ok(inlined.html.includes('src="data:image/svg+xml;base64,PHN2Zy8+"'))
  assert.ok(inlined.html.includes('src="data:image/png;base64,iVBORw0KGgo="'))
  assert.ok(!inlined.html.includes('src="assets/fig-003.svg"'))
  assert.deepEqual(inlined.warnings, [])

  const partial = renderHtmlDocument({
    project: PROJECT,
    analysis,
    bodyHtml: BODY_HTML,
    extras: { ...EXTRAS, assetDataUrls: { 'fig-003': EXTRAS.assetDataUrls['fig-003'] } },
  })
  assert.ok(partial.html.includes('src="assets/fig-004.png"'))
  assert.equal(partial.warnings.length, 1)
  assert.match(partial.warnings[0], /1 张图片缺少 data URL/)
})

test('renderHtmlDocument：空 extras 输出空状态而不是报错', () => {
  const { html, warnings } = renderHtmlDocument({ project: PROJECT, analysis, bodyHtml: BODY_HTML })
  assert.ok(html.includes('未登记素材。'))
  assert.ok(html.includes('没有未覆盖的素材块。'))
  assert.ok(html.includes('没有覆盖统计数据。'))
  assert.ok(html.includes('没有额外的复核说明。'))
  assert.deepEqual(warnings, [])
})

test('renderHtmlDocument：正文标记与数学进入文档', () => {
  const { html } = renderHtmlDocument({ project: PROJECT, analysis, bodyHtml: BODY_HTML, extras: EXTRAS })
  assert.match(html, /<h2 id="sec-2-1">2\.1 极限的定义<\/h2>/)
  assert.ok(html.includes('class="src-ref" data-src="S01" data-loc="p.3"'))
  assert.ok(html.includes('<div class="math-display" id="eq-5">'))
  assert.ok(html.includes('<span class="eqno">(5)</span>'))
  assert.ok(html.includes('<a class="xref" href="#fig-3">图 1</a>'))
})
