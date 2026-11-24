"""LectureForge 的 Python 侧工具：Notebook 执行器与自包含 SVG 绘图。

``lecturekit`` 只依赖 Python 标准库；绘图模块额外依赖 numpy。

绘图用法::

    from lecturekit import plot

    svg = plot.render_plot(
        {
            "type": "line",
            "series": [{"x": [0, 1, 2], "y": [0, 1, 4], "label": "y = x²"}],
            "title": "示例",
        }
    )

``render_plot`` 返回完整的 ``<svg>`` 字符串（无外部资源引用），可直接写入
``.svg`` 文件或在 Markdown / Notebook 中内联展示。

Notebook 执行器用法（一般由插件内部调用，无需手动执行）::

    python -X utf8 -m lecturekit.driver --input in.ipynb --output out.ipynb --report report.json
"""

__all__ = ["plot"]

__version__ = "0.1.0"
