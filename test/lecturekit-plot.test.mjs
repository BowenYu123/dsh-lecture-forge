import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { run } from '../lib/runner.mjs'
import { PYTHON, PYTHON_ENV, ROOT, tmpDir } from './helpers/env.mjs'

const PY_DIR = path.join(ROOT, 'py')

const SPECS = {
  line: {
    type: 'line',
    title: '折线图：平方与线性',
    xlabel: 'x 轴',
    ylabel: 'y 轴',
    series: [
      { x: [0, 1, 2, 3, 4], y: [0, 1, 4, 9, 16], label: '平方' },
      { x: [0, 1, 2, 3, 4], y: [0, 2, 4, 6, 8], label: '线性', color: '#dc2626', dash: '6 4' },
    ],
  },
  scatter: {
    type: 'scatter',
    title: '散点图',
    series: [{ x: [1, 2, 3, 4, 5], y: [2.1, 1.7, 3.9, 3.2, 5.4], label: '样本', size: 8 }],
  },
  parametric: {
    type: 'parametric',
    title: '参数曲线',
    xlabel: 'x',
    ylabel: 'y',
    samples: 300,
    series: [{ t0: 0, t1: 6.283185307179586, fx: 'cos(t)', fy: 'sin(2*t)', label: '李萨如曲线' }],
  },
  vector_field: {
    type: 'vector_field',
    title: '向量场',
    xrange: [-2, 2],
    yrange: [-2, 2],
    u: '-y',
    v: 'x',
    grid: 21,
  },
  heatmap: {
    type: 'heatmap',
    title: '热力图',
    f: 'sin(x)*cos(y)',
    xrange: [-3.141592653589793, 3.141592653589793],
    yrange: [-3.141592653589793, 3.141592653589793],
    grid: 81,
    colormap: 'viridis',
  },
  contour: {
    type: 'contour',
    title: '等值线',
    f: 'sin(x)*cos(y)',
    xrange: [-3.141592653589793, 3.141592653589793],
    yrange: [-3.141592653589793, 3.141592653589793],
    grid: 81,
    levels: [-0.8, -0.4, 0, 0.4, 0.8],
    colormap: 'plasma',
  },
  npmath: {
    type: 'heatmap',
    title: 'np.* 与 math.* 表达式',
    f: 'np.sin(x) * math.cos(y)',
    xrange: [-3.141592653589793, 3.141592653589793],
    yrange: [-3.141592653589793, 3.141592653589793],
    grid: 41,
    colormap: 'gray',
  },
  log: {
    type: 'line',
    title: '对数坐标',
    logy: true,
    series: [{ x: [1, 2, 3, 4], y: [1, 10, 100, 1000], label: '指数' }],
  },
}

function pythonScript() {
  return String.raw`
import json
import os
import sys

from lecturekit import plot

specs = json.load(open(sys.argv[1], encoding="utf-8"))
outdir = sys.argv[2]
results = {}
for name, spec in specs.items():
    try:
        svg = plot.render_plot(spec)
    except Exception as exc:
        results[name] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        continue
    with open(os.path.join(outdir, name + ".svg"), "w", encoding="utf-8") as handle:
        handle.write(svg)
    results[name] = {
        "ok": True,
        "start": svg.startswith("<svg"),
        "viewBox": 'viewBox="0 0 900 560"' in svg,
        "style": "<style>" in svg,
        "finite": ("NaN" not in svg and "Infinity" not in svg),
        "length": len(svg),
        "tickLabels": svg.count('class="lf-tick-label"'),
        "legend": "lf-legend" in svg,
        "external": ("href=" in svg or "<script" in svg or "<image" in svg),
        "text": svg,
    }

malicious = [
    "__import__('os').system('echo x')",
    "np.__dict__",
    "open('/etc/passwd')",
    "().__class__",
]
rejected = {}
for expr in malicious:
    try:
        plot.render_plot({
            "type": "parametric",
            "series": [{"t0": 0, "t1": 1, "fx": expr, "fy": "t"}],
        })
    except Exception as exc:
        rejected[expr] = f"{type(exc).__name__}: {exc}"
    else:
        rejected[expr] = None

try:
    plot.render_plot({"type": "unknown_plot"})
except Exception as exc:
    unknown = f"{type(exc).__name__}: {exc}"
else:
    unknown = None

print(json.dumps({"types": results, "rejected": rejected, "unknown": unknown}, ensure_ascii=False))
`
}

test('lecturekit.plot 渲染多种图形为自包含 SVG', async (t) => {
  const dir = tmpDir('lecturekit-plot')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  await fs.writeFile(path.join(dir, 'specs.json'), JSON.stringify(SPECS), 'utf8')
  await fs.writeFile(path.join(dir, 'check.py'), pythonScript(), 'utf8')

  const pythonPath = [PY_DIR, PYTHON_ENV.PYTHONPATH].filter(Boolean).join(path.delimiter)
  const result = await run(
    PYTHON,
    ['-X', 'utf8', path.join(dir, 'check.py'), path.join(dir, 'specs.json'), dir],
    {
      cwd: dir,
      env: { ...PYTHON_ENV, PYTHONPATH: pythonPath },
      timeoutMs: 120000,
      windowsHide: true,
    },
  )
  assert.equal(result.code, 0, `python 失败：\n${result.stderr}`)
  const payload = JSON.parse(result.stdout)

  for (const name of Object.keys(SPECS)) {
    const entry = payload.types[name]
    assert.ok(entry, `${name} 没有结果`)
    assert.equal(entry.ok, true, `${name} 渲染失败：${entry.error}`)
    assert.equal(entry.start, true, `${name} 不是以 <svg 开头`)
    assert.equal(entry.viewBox, true, `${name} 缺少 viewBox="0 0 900 560"`)
    assert.equal(entry.style, true, `${name} 缺少 <style>`)
    assert.equal(entry.finite, true, `${name} 含 NaN/Infinity`)
    assert.equal(entry.external, false, `${name} 引用了外部资源`)
    assert.ok(entry.length > 1000, `${name} 输出过短`)
    assert.ok(entry.tickLabels >= 4, `${name} 刻度文字不足`)
  }

  assert.match(payload.types.line.text, /折线图：平方与线性/)
  assert.match(payload.types.line.text, /平方/)
  assert.match(payload.types.line.text, /线性/)
  assert.match(payload.types.line.text, /Noto Sans SC/)
  assert.match(payload.types.scatter.text, /样本/)
  assert.match(payload.types.parametric.text, /李萨如曲线/)
  assert.match(payload.types.npmath.text, /np\.\* 与 math\.\* 表达式/)
  assert.match(payload.types.vector_field.text, /\|F\|/)
  assert.match(payload.types.log.text, /对数坐标/)

  for (const expr of Object.keys(payload.rejected)) {
    assert.ok(payload.rejected[expr], `恶意表达式没有被拒绝：${expr}`)
    assert.match(payload.rejected[expr], /^ValueError:/)
  }
  assert.match(payload.unknown, /未知图类型/)
})
