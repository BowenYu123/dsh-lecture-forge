// LectureForge — Markdown 分析与渲染测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeMarkdown, renderMarkdown } from '../lib/render/markdown.mjs'

const LINES = [
  '# 第二章 极限 {#sec-2}',
  '',
  '导言段落，参考 [S01, p.3] 与视频 [V01, 00:12:31]。',
  '',
  '## 2.1 极限的定义 {#sec-2-1}',
  '',
  '设 $\\varepsilon>0$，存在 $\\delta>0$，见 [@sec-2-1] 与 [S01, §2.4]。',
  '',
  '> [!CLARIFY] 为什么要用 ε-δ？',
  '> 因为需要把“无限接近”写成可检验的不等式，参考 [S01, §2.4]。',
  '',
  '> [!WARN] 常见错误',
  '> 忘记 $\\delta$ 依赖于 $\\varepsilon$。',
  '',
  '$$\\lim_{x \\to a} f(x) = L$$ {#eq-5}',
  '',
  '![图 3 函数图像](assets/fig-003.svg){#fig-3 width=70%}',
  '',
  '![另一个示意图](assets/fig-004.png){#fig-4}',
  '',
  '如图 [@fig-3]、图 [@fig-4]、式 [@eq-5] 与 [@fig-x] 所示。',
  '',
  '| 量 | 含义 |',
  '| --- | --- |',
  '| ε | 任意小误差 |',
  '',
  '### 邻域',
  '',
  '在 $x=a$ 附近。',
  '',
  '```python',
  'def f(x):',
  '    return "$not math$ <tag> & [S01, p.3]"',
  '```',
  '',
  '坏公式 $\\frac{$ 结束。',
]

const SAMPLE = LINES.join('\n')

test('analyzeMarkdown：章节 id、自动 id 与 explicit 标记', () => {
  const analysis = analyzeMarkdown(SAMPLE)
  assert.equal(analysis.sections.length, 3)

  const [chapter, section, auto] = analysis.sections
  assert.equal(chapter.id, 'sec-2')
  assert.equal(chapter.level, 1)
  assert.equal(chapter.title, '第二章 极限')
  assert.equal(chapter.line, 1)
  assert.equal(chapter.explicit, true)

  assert.equal(section.id, 'sec-2-1')
  assert.equal(section.level, 2)
  assert.equal(section.title, '2.1 极限的定义')
  assert.equal(section.line, 5)
  assert.equal(section.explicit, true)

  // 无 {#id} 的标题自动分配 sec-<n>，并标记 explicit:false。
  assert.equal(auto.id, 'sec-1')
  assert.equal(auto.level, 3)
  assert.equal(auto.title, '邻域')
  assert.equal(auto.explicit, false)

  assert.deepEqual(analysis.headings, analysis.sections)
})

test('analyzeMarkdown：来源标记覆盖 page/section/time 三类', () => {
  const analysis = analyzeMarkdown(SAMPLE)
  assert.equal(analysis.markers.length, 4)

  const page = analysis.markers.find((marker) => marker.kind === 'page')
  assert.ok(page)
  assert.equal(page.sourceId, 'S01')
  assert.equal(page.page, '3')
  assert.equal(page.raw, '[S01, p.3]')

  const section = analysis.markers.find((marker) => marker.kind === 'section')
  assert.ok(section)
  assert.equal(section.section, '2.4')

  const time = analysis.markers.find((marker) => marker.kind === 'time')
  assert.ok(time)
  assert.equal(time.sourceId, 'V01')
  assert.equal(time.time, '00:12:31')

  for (const marker of analysis.markers) {
    assert.ok(marker.line >= 1)
    assert.equal(typeof marker.raw, 'string')
  }
})

test('analyzeMarkdown：标注块、图、交叉引用、公式与代码围栏', () => {
  const analysis = analyzeMarkdown(SAMPLE)

  assert.equal(analysis.callouts.length, 2)
  const clarify = analysis.callouts[0]
  assert.equal(clarify.kind, 'clarify')
  assert.equal(clarify.title, '为什么要用 ε-δ？')
  assert.equal(clarify.markers.length, 1)
  assert.equal(clarify.markers[0].kind, 'section')
  assert.ok(clarify.markers[0].line >= clarify.line && clarify.markers[0].line <= clarify.endLine)
  assert.equal(analysis.callouts[1].kind, 'warn')
  assert.equal(analysis.callouts[1].markers.length, 0)

  assert.equal(analysis.figures.length, 2)
  assert.deepEqual(
    analysis.figures.map((figure) => ({
      assetId: figure.assetId,
      id: figure.id,
      caption: figure.caption,
      path: figure.path,
      width: figure.width,
    })),
    [
      {
        assetId: 'fig-003',
        id: 'fig-3',
        caption: '图 3 函数图像',
        path: 'assets/fig-003.svg',
        width: '70%',
      },
      {
        assetId: 'fig-004',
        id: 'fig-4',
        caption: '另一个示意图',
        path: 'assets/fig-004.png',
        width: null,
      },
    ],
  )
  assert.equal(analysis.figures[0].attrs.width, '70%')

  assert.deepEqual(
    analysis.refs.map((ref) => ref.target),
    ['sec-2-1', 'fig-3', 'fig-4', 'eq-5', 'fig-x'],
  )

  assert.equal(analysis.equations.length, 1)
  assert.equal(analysis.equations[0].id, 'eq-5')
  assert.equal(analysis.equations[0].tex, '\\lim_{x \\to a} f(x) = L')

  // 行内公式 + 展示公式都进 math；围栏代码里的 $ 不算。
  assert.ok(analysis.math.length >= 5)
  assert.equal(analysis.math.filter((item) => item.display).length, 1)
  assert.ok(analysis.math.some((item) => item.tex.includes('\\frac{')))

  assert.equal(analysis.codeFences.length, 1)
  assert.equal(analysis.codeFences[0].lang, 'python')
  assert.ok(analysis.codeFences[0].endLine > analysis.codeFences[0].startLine)

  assert.ok(analysis.wordCount > 10)
  assert.ok(analysis.chars > 100)
})

test('renderMarkdown：标题 id、公式编号、来源标记与标注块', () => {
  const { html, analysis, mathErrors, warnings } = renderMarkdown(SAMPLE)
  assert.equal(analysis.sections.length, 3)

  assert.match(html, /<h1 id="sec-2">第二章 极限<\/h1>/)
  assert.match(html, /<h2 id="sec-2-1">2\.1 极限的定义<\/h2>/)
  assert.match(html, /<h3 id="sec-1">邻域<\/h3>/)

  assert.match(html, /<div class="math-display" id="eq-5">/)
  assert.match(html, /<span class="eqno">\(5\)<\/span>/)

  assert.ok(html.includes('<sup class="src-ref" data-src="S01" data-loc="p.3">[S01·p.3]</sup>'))
  assert.ok(html.includes('<sup class="src-ref" data-src="S01" data-loc="§2.4">[S01·§2.4]</sup>'))
  assert.ok(html.includes('<sup class="src-ref" data-src="V01" data-loc="00:12:31">[V01·00:12:31]</sup>'))

  assert.match(html, /<div class="callout callout-clarify"><p class="callout-title">为什么要用 ε-δ？<\/p>/)
  assert.match(html, /<div class="callout callout-warn"><p class="callout-title">常见错误<\/p>/)

  // 唯一错误来自样例末尾的坏公式；其余公式正常渲染。
  assert.equal(mathErrors.length, 1)
  assert.ok(mathErrors[0].tex.includes('\\frac{'))
})

test('renderMarkdown：图自动编号、xref 文本与属性剥离', () => {
  const { html } = renderMarkdown(SAMPLE)

  assert.ok(html.includes(
    '<figure class="lf-figure" id="fig-3"><img src="assets/fig-003.svg" style="width:70%"><figcaption>图 1：函数图像</figcaption></figure>',
  ))
  assert.ok(html.includes(
    '<figure class="lf-figure" id="fig-4"><img src="assets/fig-004.png"><figcaption>图 2：另一个示意图</figcaption></figure>',
  ))

  assert.match(html, /<a class="xref" href="#fig-3">图 1<\/a>/)
  assert.match(html, /<a class="xref" href="#fig-4">图 2<\/a>/)
  assert.match(html, /<a class="xref" href="#eq-5">式 \(5\)<\/a>/)
  assert.match(html, /<a class="xref" href="#sec-2-1">2\.1 极限的定义<\/a>/)
  assert.match(html, /<span class="xref broken">\[@fig-x\]<\/span>/)

  // 属性块从正文完全消除。
  assert.ok(!html.includes('{#fig-3'))
  assert.ok(!html.includes('{#fig-4'))
  assert.ok(!html.includes('width=70%'))
})

test('renderMarkdown：围栏代码不被数学/标记/图解析，且 HTML 被转义', () => {
  const { html, warnings } = renderMarkdown(SAMPLE)
  const start = html.indexOf('<pre class="code">')
  const end = html.indexOf('</pre>', start)
  assert.ok(start >= 0 && end > start)
  const codeBlock = html.slice(start, end)

  assert.ok(codeBlock.includes('<code class="language-python">'))
  assert.ok(codeBlock.includes('&quot;$not math$ &lt;tag&gt; &amp; [S01, p.3]&quot;'))
  assert.ok(!codeBlock.includes('class="katex"'))
  assert.ok(!codeBlock.includes('src-ref'))
  assert.ok(!codeBlock.includes('<img'))
  assert.ok(warnings.every((warning) => !warning.includes('p.3')))
})

test('renderMarkdown：表格与坏公式降级不抛异常', () => {
  let rendered
  assert.doesNotThrow(() => {
    rendered = renderMarkdown(SAMPLE)
  })

  const { html, mathErrors, warnings } = rendered
  assert.match(html, /<table>/)
  assert.match(html, /<th>量<\/th>/)
  assert.match(html, /<th>含义<\/th>/)

  assert.equal(mathErrors.length, 1)
  assert.ok(mathErrors[0].tex.includes('\\frac{'))
  assert.ok(mathErrors[0].line > 0)
  assert.ok(mathErrors[0].message.length > 0)

  assert.match(html, /<span class="math-error"/)
  assert.ok(warnings.some((warning) => warning.includes('[@fig-x]')))
})

test('renderMarkdown：报告使用而不是猜测', () => {
  // 渲染函数返回的 analysis 与独立分析一致（供 html/审计复用）。
  const { analysis } = renderMarkdown(SAMPLE)
  const standalone = analyzeMarkdown(SAMPLE)
  assert.deepEqual(analysis.sections, standalone.sections)
  assert.deepEqual(analysis.figures, standalone.figures)
  assert.deepEqual(analysis.markers, standalone.markers)
  assert.deepEqual(analysis.callouts, standalone.callouts)
})
