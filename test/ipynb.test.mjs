import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import { buildNotebook, notebookJson, executeNotebook } from '../lib/render/ipynb.mjs'
import { PYTHON, ROOT, tmpDir } from './helpers/env.mjs'

const PY_DIR = `${ROOT}/py`

function markdownFixture() {
  return [
    '# 极限的定义 {#sec-2-1}',
    '',
    '第一段讲极限，引用图 [@fig-1]，来源 [S01, p.3]。',
    '',
    '> [!CLARIFY] 注意',
    '> 这里是一个标注块，内容应原样保留。',
    '',
    '$$\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$$ {#eq-1}',
    '',
    '```python',
    "print('hi')",
    '```',
    '',
    '```python',
    'x = 2',
    '```',
    '',
    '```js',
    'const answer = 42 // [@fig-1] 在代码里不改写',
    '```',
    '',
    '![示意图](assets/fig-001.svg){#fig-1 width=70%}',
    '',
    '## 下一节 {#sec-2-2}',
    '',
    '再次引用 [@fig-1]，以及另一个图 [@fig-2]。',
  ].join('\n')
}

const ANALYSIS = {
  figures: [
    { id: 'fig-1', assetId: 'fig-001', caption: '示意图', path: 'assets/fig-001.svg' },
  ],
}

const PROJECT = { id: 'proj-001', title: '极限讲义' }

test('buildNotebook 把讲义 Markdown 转成 nbformat 4.5 单元', () => {
  const { notebook, warnings } = buildNotebook({
    project: PROJECT,
    analysis: ANALYSIS,
    mdText: markdownFixture(),
    assets: [{ assetId: 'fig-001', file: 'assets/fig-001.svg' }],
  })

  assert.deepEqual(warnings, [])
  assert.equal(notebook.nbformat, 4)
  assert.equal(notebook.nbformat_minor, 5)

  const types = notebook.cells.map((cell) => cell.cell_type)
  assert.deepEqual(types, ['markdown', 'code', 'code', 'markdown'])

  const [intro, first, second, rest] = notebook.cells
  assert.match(intro.source, /^# 极限的定义/m)
  assert.match(intro.source, /> \[!CLARIFY\] 注意/)
  assert.match(intro.source, /\$\$\\lim_/)
  assert.match(intro.source, /\[S01, p\.3\]/)
  assert.match(intro.source, /图 1/)
  assert.doesNotMatch(intro.source, /\{#/)

  assert.equal(first.source, "print('hi')")
  assert.equal(second.source, 'x = 2')
  assert.equal(first.metadata.lf.lang, 'python')
  assert.equal(second.metadata.lf.lang, 'python')

  assert.match(rest.source, /```js/)
  assert.match(rest.source, /const answer = 42/)
  assert.match(rest.source, /!\[示意图\]\(assets\/fig-001\.svg\)/)
  assert.doesNotMatch(rest.source, /width=70%/)
  assert.match(rest.source, /## 下一节/)
  assert.match(rest.source, /再次引用 图 1/)
  assert.match(rest.source, /图 2/) // 没有映射时按 fig-<n> 数字后缀兜底
  assert.match(rest.source, /const answer = 42 \/\/ \[@fig-1\]/) // 代码里的引用不改写

  assert.equal(notebook.metadata.kernelspec.name, 'python3')
  assert.equal(notebook.metadata.kernelspec.display_name, 'Python 3')
  assert.equal(notebook.metadata.language_info.name, 'python')
  assert.equal(notebook.metadata.lf.projectId, 'proj-001')
  assert.equal(notebook.metadata.lf.title, '极限讲义')
  assert.equal(notebook.metadata.lf.pluginVersion, '0.1.0')
  assert.ok(!Number.isNaN(Date.parse(notebook.metadata.lf.generatedAt)))

  const ids = notebook.cells.map((cell) => cell.id)
  assert.deepEqual(ids, ['cell-1', 'cell-2', 'cell-3', 'cell-4'])
  for (const cell of notebook.cells) {
    if (cell.cell_type === 'code') {
      assert.deepEqual(cell.outputs, [])
      assert.equal(cell.execution_count, null)
    }
  }
})

test('buildNotebook 合并连续 markdown、忽略空单元并稳定序列化', () => {
  const md = ['# 标题 {#sec-1}', '', '', '正文。', '', '## 小节 {#sec-2}', '', '结尾。'].join('\n')
  const { notebook } = buildNotebook({ project: PROJECT, analysis: {}, mdText: md })
  assert.equal(notebook.cells.length, 1)
  assert.equal(notebook.cells[0].cell_type, 'markdown')
  assert.match(notebook.cells[0].source, /^# 标题/m)
  assert.match(notebook.cells[0].source, /## 小节/)
  assert.doesNotMatch(notebook.cells[0].source, /\{#/)

  const text = notebookJson(notebook)
  assert.ok(text.endsWith('\n'))
  assert.deepEqual(JSON.parse(text), JSON.parse(notebookJson(notebook)))

  const empty = buildNotebook({ project: PROJECT, analysis: {}, mdText: '\n\n  \n' })
  assert.equal(empty.notebook.cells.length, 0)
  assert.doesNotThrow(() => JSON.parse(notebookJson(empty.notebook)))
})

test('executeNotebook 捕获输出、表达式、错误并继续执行', async (t) => {
  const dir = tmpDir('ipynb-exec')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const mdText = [
    '```python',
    "print('hello')",
    '```',
    '',
    '```python',
    'x = 21',
    '```',
    '',
    '```python',
    '1 + 2',
    '```',
    '',
    '```python',
    'import numpy as np',
    'np.arange(3)',
    '```',
    '',
    '```python',
    '1/0',
    '```',
    '',
    '```python',
    "print(x + 1)",
    '```',
  ].join('\n')
  const { notebook } = buildNotebook({ project: PROJECT, analysis: {}, mdText })
  assert.equal(notebook.cells.length, 6)

  const result = await executeNotebook({
    notebook,
    pythonPath: PYTHON,
    cwd: dir,
    pyDir: PY_DIR,
    cellTimeoutMs: 15000,
    totalTimeoutMs: 60000,
  })

  assert.equal(result.run.code, 0)
  assert.equal(result.run.timedOut, false)
  assert.equal(result.executed, 6)
  assert.equal(result.failed, 1)

  const cells = result.notebook.cells
  assert.deepEqual(
    cells.map((cell) => cell.execution_count),
    [1, 2, 3, 4, 5, 6],
  )

  const hello = cells[0].outputs.find((output) => output.output_type === 'stream')
  assert.equal(hello.name, 'stdout')
  assert.equal(hello.text.join(''), 'hello\n')
  assert.equal(cells[0].outputs.length, 1, 'print 的返回值 None 不应产生 execute_result')

  assert.deepEqual(cells[1].outputs, [])
  assert.equal(cells[2].outputs[0].data['text/plain'].join(''), '3')
  assert.equal(cells[2].outputs[0].output_type, 'execute_result')
  assert.equal(cells[3].outputs[0].data['text/plain'].join(''), 'array([0, 1, 2])')

  const error = cells[4].outputs.find((output) => output.output_type === 'error')
  assert.equal(error.ename, 'ZeroDivisionError')
  assert.match(error.evalue, /division by zero/)
  assert.ok(Array.isArray(error.traceback) && error.traceback.length > 0)

  const after = cells[5].outputs.find((output) => output.output_type === 'stream')
  assert.equal(after.text.join(''), '22\n', '错误单元之后的单元仍然执行')

  assert.deepEqual(
    result.cells.map((cell) => cell.ok),
    [true, true, true, true, false, true],
  )
  assert.equal(result.cells[4].ename, 'ZeroDivisionError')
  assert.equal(result.cells[4].timedOut, false)
  for (const cell of result.cells) {
    assert.ok(Number.isInteger(cell.durationMs) && cell.durationMs >= 0)
  }
})

test('executeNotebook 单元超时后继续执行后续单元', async (t) => {
  const dir = tmpDir('ipynb-timeout')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const mdText = [
    '```python',
    'import time',
    "print('before')",
    'time.sleep(3)',
    "print('after')",
    '```',
    '',
    '```python',
    "print('continued')",
    '```',
  ].join('\n')
  const { notebook } = buildNotebook({ project: PROJECT, analysis: {}, mdText })
  assert.equal(notebook.cells.length, 2)

  const result = await executeNotebook({
    notebook,
    pythonPath: PYTHON,
    cwd: dir,
    pyDir: PY_DIR,
    cellTimeoutMs: 800,
    totalTimeoutMs: 30000,
  })

  assert.equal(result.run.code, 0)
  assert.equal(result.executed, 2)
  assert.equal(result.failed, 1)
  assert.equal(result.cells[0].timedOut, true)
  assert.equal(result.cells[0].ename, 'TimeoutError')
  assert.ok(result.cells[0].durationMs >= 700)
  assert.equal(result.cells[1].ok, true)
  assert.equal(result.cells[1].timedOut, false)

  const timedOutCell = result.notebook.cells[0]
  const error = timedOutCell.outputs.find((output) => output.output_type === 'error')
  assert.equal(error.ename, 'TimeoutError')
  const before = timedOutCell.outputs.find((output) => output.output_type === 'stream')
  assert.equal(before.text.join(''), 'before\n', '超时前的 stdout 应保留')

  const continued = result.notebook.cells[1].outputs.find((output) => output.output_type === 'stream')
  assert.equal(continued.text.join(''), 'continued\n')
})
