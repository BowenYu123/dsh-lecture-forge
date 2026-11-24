# lecturekit

LectureForge 的 Python 侧小工具包，只依赖标准库与 numpy；不需要 Jupyter / matplotlib。

## 绘图

```python
from lecturekit import plot

svg = plot.render_plot({
    "type": "line",
    "title": "示例",
    "xlabel": "x",
    "ylabel": "y",
    "series": [{"x": [0, 1, 2, 3], "y": [0, 1, 4, 9], "label": "平方"}],
})
```

`render_plot(spec)` 返回完整、自包含的 `<svg>` 字符串（900×560，含内联 `<style>`、
坐标轴、刻度、网格、标题/轴标签、图例/色带，不引用任何外部资源）。

支持的 `spec["type"]`：

| type | 主要字段 |
| --- | --- |
| `line` | `series[{x,y,label?,color?,dash?}]`, `title?`, `xlabel?`, `ylabel?`, `logx?`, `logy?`, `grid?`, `xlim?`, `ylim?` |
| `scatter` | `series[{x,y,label?,color?,size?}]`，其余同 `line` |
| `parametric` | `series[{t0,t1,fx,fy,label?,color?}]`, `samples?`，其余同 `line` |
| `vector_field` | `xrange`, `yrange`, `u`, `v`, `grid?`, `colormap?`, `title?` |
| `heatmap` | `f`, `xrange`, `yrange`, `grid?`, `colormap?('viridis'\|'plasma'\|'gray')`, `vmin?`, `vmax?`, `title?` |
| `contour` | `f`, `xrange`, `yrange`, `levels?`, `grid?`, `colormap?`, `title?` |

`f` / `u` / `v` / `fx` / `fy` 是受限表达式：允许 `x`、`y`（或 `t`）、数值常量、
四则/乘方/比较/条件表达式，以及白名单函数（`sin`、`cos`、`exp`、`log`、`sqrt`、
`hypot`、`where` 等，可写成 `np.sin(x)` 或 `math.sin(x)`）。字符串、导入、
下划线属性、任意属性链都会被拒绝并抛出 `ValueError`。

## Notebook 执行器

`python -m lecturekit.driver` 读取 nbformat 4.5 的 `.ipynb`，顺序执行 code 单元，
把 `stream` / `execute_result` / `display_data` / `error` 写回输出文件：

```text
python -X utf8 -m lecturekit.driver \
  --input in.ipynb --output out.ipynb --report report.json \
  --cell-timeout 60000 --total-timeout 600000
```

- code 单元共享同一份 globals；错误单元记录 `error` 后继续，`SystemExit` /
  `KeyboardInterrupt` 记录后终止。
- 最后一行表达式会以 `repr` 输出；对象有 `_repr_svg_` / `_repr_png_` /
  `_repr_html_` 时优先输出对应 MIME 的 `display_data`。
- `report.json`：`{"executed":N,"failed":M,"cells":[{"index":i,"ok":bool,
  "ename":...,"evalue":...,"timedOut":bool,"durationMs":int}],"warnings":[]}`。
- 退出码：0 表示执行完成（单元失败不算进程失败）；2 表示参数 / IO / 格式错误。
- 超时：Unix 主线程用 `SIGALRM`；Windows 用 `PyThreadState_SetAsyncExc` 向执行
  线程注入 `TimeoutError`。Windows 上 `time.sleep()` 等阻塞调用不会被立刻打断，
  异常会在阻塞调用返回后才送达（此时仍标记 `timedOut` 并继续后续单元）。
