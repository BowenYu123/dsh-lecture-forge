"""零依赖 SVG 绘图：只使用 numpy + 标准库。

渲染结果是一段完整、自包含的 ``<svg>`` 字符串（内联 ``<style>``，不引用
任何外部字体/图片/脚本），可直接嵌进 Notebook、HTML 或讲义 Markdown。

入口::

    from lecturekit import plot
    svg = plot.render_plot({"type": "line", "series": [...]})

支持的类型：line / scatter / parametric / vector_field / heatmap / contour。
表达式（parametric.fx/fy、vector_field.u/v、heatmap.f/contour.f）通过
AST 白名单求值：只允许数字、变量、算术运算，以及 ``np.``/``math.`` 前缀和
白名单函数名；禁止属性链、下划线名称、import 等。
"""

from __future__ import annotations

import ast
import math
import re

import numpy as np

__all__ = ["render_plot"]

# 画布与坐标系（单位 px）
WIDTH = 900
HEIGHT = 560
LEFT = 90
TOP = 70
BOTTOM = 480
RIGHT = 860          # 需要色带时收缩到 770
CB_RIGHT = 770
FONT = "Noto Sans SC, Microsoft YaHei, sans-serif"

_PALETTE = [
    "#2563eb",
    "#dc2626",
    "#059669",
    "#d97706",
    "#7c3aed",
    "#0891b2",
    "#db2777",
    "#65a30d",
]


# ---------------------------------------------------------------------------
# 数值与格式
# ---------------------------------------------------------------------------


def _finite(values, what: str) -> np.ndarray:
    try:
        arr = np.asarray(values, dtype=float)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{what} 不是数值数组：{exc}") from exc
    if arr.size == 0:
        raise ValueError(f"{what} 为空")
    if not np.all(np.isfinite(arr)):
        raise ValueError(f"{what} 含 NaN/Infinity，无法绘图")
    return arr


def _fmt(value: float) -> str:
    if not math.isfinite(value):
        return "0"
    if abs(value) < 1e-12:
        return "0"
    if abs(value) >= 1e4 or abs(value) < 1e-3:
        return f"{value:.3g}"
    text = f"{value:.6g}"
    return text


def _fmt_compact(value: float) -> str:
    if not math.isfinite(value):
        return "0"
    if abs(value) < 1e-12:
        return "0"
    if abs(value) >= 1e4 or abs(value) < 1e-3:
        return f"{value:.3g}"
    return f"{value:.4g}"


def _esc(text) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _nice_step(span: float, target: int = 7) -> float:
    span = abs(span)
    if span <= 0 or not math.isfinite(span):
        return 1.0
    raw = span / max(1, target)
    exp = math.floor(math.log10(raw))
    frac = raw / (10.0**exp)
    if frac < 1.5:
        nice = 1.0
    elif frac < 3.0:
        nice = 2.0
    elif frac < 7.0:
        nice = 5.0
    else:
        nice = 10.0
    return nice * (10.0**exp)


def _linear_ticks(lo: float, hi: float, target: int = 7) -> list[float]:
    if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
        return [lo]
    step = _nice_step(hi - lo, target)
    start = math.ceil(lo / step - 1e-9) * step
    ticks: list[float] = []
    value = start
    guard = 0
    while value <= hi + step * 1e-9 and guard < 200:
        ticks.append(round(value, 12))
        value += step
        guard += 1
    if len(ticks) < 2:
        ticks = [lo, hi]
    return ticks


def _log_ticks(lo: float, hi: float) -> list[float]:
    if lo <= 0 or hi <= 0:
        raise ValueError("对数坐标要求数据全部为正数")
    e0 = math.floor(math.log10(lo))
    e1 = math.ceil(math.log10(hi))
    if e1 - e0 > 12:
        e0 = max(e0, e1 - 12)
    return [10.0**e for e in range(e0, e1 + 1)]


def _auto_range(vmin: float, vmax: float, pad: float = 0.06) -> tuple[float, float]:
    if not (math.isfinite(vmin) and math.isfinite(vmax)):
        return (0.0, 1.0)
    if vmax > vmin:
        span = vmax - vmin
        return (vmin - span * pad, vmax + span * pad)
    if vmin == 0:
        return (-1.0, 1.0)
    delta = abs(vmin) * 0.1
    return (vmin - delta, vmax + delta)


# ---------------------------------------------------------------------------
# 颜色
# ---------------------------------------------------------------------------

_VIRIDIS = [
    (0.267, 0.005, 0.329),
    (0.284, 0.141, 0.458),
    (0.254, 0.265, 0.530),
    (0.207, 0.372, 0.553),
    (0.164, 0.471, 0.558),
    (0.128, 0.567, 0.551),
    (0.135, 0.659, 0.518),
    (0.267, 0.749, 0.441),
    (0.478, 0.821, 0.318),
    (0.741, 0.873, 0.150),
    (0.993, 0.906, 0.144),
]

_PLASMA = [
    (0.050, 0.030, 0.528),
    (0.232, 0.017, 0.645),
    (0.389, 0.001, 0.713),
    (0.541, 0.017, 0.706),
    (0.678, 0.089, 0.651),
    (0.793, 0.196, 0.569),
    (0.882, 0.311, 0.471),
    (0.947, 0.432, 0.372),
    (0.983, 0.563, 0.278),
    (0.996, 0.706, 0.186),
    (0.940, 0.975, 0.131),
]

_GRAY = [(0.10, 0.10, 0.10), (0.98, 0.98, 0.98)]


def _color(name: str | None, t: float) -> str:
    stops = _GRAY
    key = (name or "viridis").lower()
    if key in ("viridis", "plasma"):
        stops = _VIRIDIS if key == "viridis" else _PLASMA
    try:
        tt = float(t)
    except (TypeError, ValueError):
        tt = 0.0
    if not math.isfinite(tt):
        tt = 0.0
    tt = min(1.0, max(0.0, tt))
    if len(stops) == 2:
        a, b = stops
        rgb = [a[i] + (b[i] - a[i]) * tt for i in range(3)]
    else:
        pos = tt * (len(stops) - 1)
        i0 = min(len(stops) - 2, int(math.floor(pos)))
        frac = pos - i0
        a, b = stops[i0], stops[i0 + 1]
        rgb = [a[i] + (b[i] - a[i]) * frac for i in range(3)]
    return "#" + "".join(f"{int(round(c * 255)):02x}" for c in rgb)


# ---------------------------------------------------------------------------
# 安全表达式求值
# ---------------------------------------------------------------------------

_EXPR_FUNCS = {
    "sin",
    "cos",
    "tan",
    "arcsin",
    "arccos",
    "arctan",
    "arctan2",
    "sinh",
    "cosh",
    "tanh",
    "exp",
    "expm1",
    "log",
    "log10",
    "log2",
    "log1p",
    "sqrt",
    "cbrt",
    "abs",
    "absolute",
    "sign",
    "floor",
    "ceil",
    "power",
    "minimum",
    "maximum",
    "clip",
    "where",
    "hypot",
    "mod",
    "remainder",
    "degrees",
    "radians",
    "arctan2",
    "nan_to_num",
}

_EXPR_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau}
# 只允许作为 np.* / math.* 的模块前缀出现；求值时都映射到 numpy。
_EXPR_MODULES = {"np", "math"}

_ALLOWED_NODES = (
    ast.Expression,
    ast.BinOp,
    ast.UnaryOp,
    ast.Constant,
    ast.Name,
    ast.Load,
    ast.Call,
    ast.Attribute,
    ast.IfExp,
    ast.Compare,
    ast.BoolOp,
    ast.Tuple,
    ast.List,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.Pow,
    ast.Mod,
    ast.FloorDiv,
    ast.USub,
    ast.UAdd,
    ast.Not,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
    ast.And,
    ast.Or,
)


def _validate_expr_node(node: ast.AST, variables: set[str], what: str) -> None:
    if not isinstance(node, _ALLOWED_NODES):
        raise ValueError(f"{what} 含不允许的语法：{type(node).__name__}")
    if isinstance(node, ast.Name):
        if (
            node.id not in variables
            and node.id not in _EXPR_FUNCS
            and node.id not in _EXPR_CONSTS
            and node.id not in _EXPR_MODULES
        ):
            raise ValueError(f"{what} 引用了未知名称 {node.id!r}")
    elif isinstance(node, ast.Attribute):
        if not isinstance(node.value, ast.Name) or node.value.id not in ("np", "math"):
            raise ValueError(f"{what} 只允许 np.* / math.* 形式的属性访问")
        if node.attr.startswith("_") or (
            node.attr not in _EXPR_FUNCS and node.attr not in _EXPR_CONSTS
        ):
            raise ValueError(f"{what} 不允许访问属性 {node.attr!r}")
    elif isinstance(node, ast.Call):
        if node.keywords:
            raise ValueError(f"{what} 的函数调用不支持关键字参数")
        func = node.func
        if isinstance(func, ast.Name):
            if func.id not in _EXPR_FUNCS:
                raise ValueError(f"{what} 不允许调用函数 {func.id!r}")
        elif isinstance(func, ast.Attribute):
            _validate_expr_node(func, variables, what)
        else:
            raise ValueError(f"{what} 的函数调用形式不受支持")
    elif isinstance(node, ast.Constant):
        if not isinstance(node.value, (int, float)) or isinstance(node.value, bool):
            raise ValueError(f"{what} 只允许数值常量")
    for child in ast.iter_child_nodes(node):
        _validate_expr_node(child, variables, what)


def _compile_expr(expr, variables: set[str], what: str):
    if isinstance(expr, (int, float)) and not isinstance(expr, bool):
        expr = repr(expr)
    if not isinstance(expr, str) or not expr.strip():
        raise ValueError(f"{what} 必须是非空字符串表达式")
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"{what} 语法错误：{exc.msg}") from exc
    _validate_expr_node(tree, variables, what)
    return compile(tree, f"<{what}>", "eval")


def _eval_expr(expr, env: dict, variables: set[str], what: str):
    code = _compile_expr(expr, variables, what)
    namespace = {"__builtins__": {}, **env, "np": np, "math": np}
    namespace.update({name: getattr(np, name) for name in _EXPR_FUNCS})
    namespace.update(_EXPR_CONSTS)
    try:
        result = eval(code, namespace)  # noqa: S307 - 已通过 AST 白名单
    except Exception as exc:  # noqa: BLE001 - 用户表达式错误统一转成可读信息
        raise ValueError(f"{what} 求值失败：{type(exc).__name__}: {exc}") from exc
    return result


def _eval_grid(expr, xs: np.ndarray, ys: np.ndarray, xname: str, yname: str, what: str):
    env = {xname: xs, yname: ys}
    result = _eval_expr(expr, env, {xname, yname}, what)
    try:
        arr = np.asarray(result, dtype=float)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{what} 的结果不是数值：{exc}") from exc
    # 标量结果广播成网格
    if arr.ndim == 0:
        arr = np.full_like(xs, float(arr), dtype=float)
    elif arr.shape != xs.shape:
        try:
            arr = np.broadcast_to(arr, xs.shape).astype(float)
        except ValueError as exc:
            raise ValueError(
                f"{what} 的结果形状 {arr.shape} 与网格 {xs.shape} 不一致"
            ) from exc
    if not np.all(np.isfinite(arr)):
        raise ValueError(f"{what} 的结果含 NaN/Infinity")
    return arr


# ---------------------------------------------------------------------------
# 坐标系
# ---------------------------------------------------------------------------


class _Axes:
    def __init__(
        self,
        xmin: float,
        xmax: float,
        ymin: float,
        ymax: float,
        *,
        logx: bool = False,
        logy: bool = False,
        right: int = RIGHT,
    ):
        self.xmin, self.xmax = float(xmin), float(xmax)
        self.ymin, self.ymax = float(ymin), float(ymax)
        self.logx, self.logy = bool(logx), bool(logy)
        self.right = int(right)
        if self.xmax <= self.xmin or self.ymax <= self.ymin:
            raise ValueError("坐标轴范围必须递增（xlim/ylim 下界小于上界）")
        if self.logx and self.xmin <= 0:
            raise ValueError("logx 要求 x 范围为正数")
        if self.logy and self.ymin <= 0:
            raise ValueError("logy 要求 y 范围为正数")
        self._lx0 = math.log10(self.xmin) if self.logx else self.xmin
        self._lx1 = math.log10(self.xmax) if self.logx else self.xmax
        self._ly0 = math.log10(self.ymin) if self.logy else self.ymin
        self._ly1 = math.log10(self.ymax) if self.logy else self.ymax

    def sx(self, x):
        arr = np.asarray(x, dtype=float)
        vals = np.log10(arr) if self.logx else arr
        out = LEFT + (vals - self._lx0) / (self._lx1 - self._lx0) * (self.right - LEFT)
        if np.ndim(out) == 0:
            return float(out)
        return out

    def sy(self, y):
        arr = np.asarray(y, dtype=float)
        vals = np.log10(arr) if self.logy else arr
        out = BOTTOM - (vals - self._ly0) / (self._ly1 - self._ly0) * (BOTTOM - TOP)
        if np.ndim(out) == 0:
            return float(out)
        return out

    def xticks(self) -> list[float]:
        return _log_ticks(self.xmin, self.xmax) if self.logx else _linear_ticks(self.xmin, self.xmax)

    def yticks(self) -> list[float]:
        return _log_ticks(self.ymin, self.ymax) if self.logy else _linear_ticks(self.ymin, self.ymax)

    def clip_id(self) -> str:
        return "lf-plot-clip"

    def defs(self) -> str:
        return (
            f'<clipPath id="{self.clip_id()}"><rect x="{LEFT}" y="{TOP}" '
            f'width="{self.right - LEFT}" height="{BOTTOM - TOP}"/></clipPath>'
        )

    def grid_svg(self, grid: bool) -> list[str]:
        if not grid:
            return []
        parts = []
        for tick in self.xticks():
            x = self.sx(tick)
            parts.append(
                f'<line class="lf-grid" x1="{x:.2f}" y1="{TOP}" x2="{x:.2f}" y2="{BOTTOM}"/>'
            )
        for tick in self.yticks():
            y = self.sy(tick)
            parts.append(
                f'<line class="lf-grid" x1="{LEFT}" y1="{y:.2f}" x2="{self.right}" y2="{y:.2f}"/>'
            )
        return parts

    def frame_svg(self, title=None, xlabel=None, ylabel=None) -> list[str]:
        parts: list[str] = []
        parts.append(
            f'<rect class="lf-frame" x="{LEFT}" y="{TOP}" '
            f'width="{self.right - LEFT}" height="{BOTTOM - TOP}" fill="none"/>'
        )
        for tick in self.xticks():
            x = self.sx(tick)
            parts.append(
                f'<line class="lf-tick" x1="{x:.2f}" y1="{BOTTOM}" x2="{x:.2f}" y2="{BOTTOM + 6}"/>'
            )
            parts.append(
                f'<text class="lf-tick-label" x="{x:.2f}" y="{BOTTOM + 22}" '
                f'text-anchor="middle">{_esc(_fmt(tick))}</text>'
            )
        for tick in self.yticks():
            y = self.sy(tick)
            parts.append(
                f'<line class="lf-tick" x1="{LEFT - 6}" y1="{y:.2f}" x2="{LEFT}" y2="{y:.2f}"/>'
            )
            parts.append(
                f'<text class="lf-tick-label" x="{LEFT - 10}" y="{y + 4:.2f}" '
                f'text-anchor="end">{_esc(_fmt(tick))}</text>'
            )
        if title:
            parts.append(
                f'<text class="lf-title" x="{(LEFT + self.right) / 2:.1f}" y="36" '
                f'text-anchor="middle">{_esc(title)}</text>'
            )
        if xlabel:
            parts.append(
                f'<text class="lf-axis-label" x="{(LEFT + self.right) / 2:.1f}" y="{HEIGHT - 14}" '
                f'text-anchor="middle">{_esc(xlabel)}</text>'
            )
        if ylabel:
            parts.append(
                f'<text class="lf-axis-label" x="24" y="{(TOP + BOTTOM) / 2:.1f}" '
                f'text-anchor="middle" transform="rotate(-90 24 {(TOP + BOTTOM) / 2:.1f})">'
                f"{_esc(ylabel)}</text>"
            )
        return parts


# ---------------------------------------------------------------------------
# 图例与色带
# ---------------------------------------------------------------------------


def _legend_svg(entries: list[tuple[str, str, str]], axes: _Axes) -> list[str]:
    """entries: [(label, color, kind)]，kind 为 line/point。"""
    if not entries:
        return []
    row = 22
    width = max(96, max(sum(13 if ord(ch) > 127 else 8 for ch in label) for label, _, _ in entries) + 46)
    height = len(entries) * row + 14
    x = axes.right - width - 14
    y = TOP + 12
    parts = [
        f'<rect class="lf-legend-box" x="{x:.1f}" y="{y:.1f}" width="{width:.1f}" '
        f'height="{height:.1f}" rx="4"/>'
    ]
    for i, (label, color, kind) in enumerate(entries):
        ty = y + 18 + i * row
        if kind == "point":
            parts.append(
                f'<circle cx="{x + 16:.1f}" cy="{ty - 4:.1f}" r="5" fill="{color}"/>'
            )
        else:
            parts.append(
                f'<line x1="{x + 8:.1f}" y1="{ty - 4:.1f}" x2="{x + 26:.1f}" y2="{ty - 4:.1f}" '
                f'stroke="{color}" stroke-width="2.5"/>'
            )
        parts.append(f'<text class="lf-legend" x="{x + 34:.1f}" y="{ty:.1f}">{_esc(label)}</text>')
    return parts


def _colorbar_svg(axes: _Axes, color_name: str, vmin: float, vmax: float, title: str | None) -> list[str]:
    x = axes.right + 34
    y0, y1 = TOP, BOTTOM
    height = y1 - y0
    steps = 256
    parts = [f'<g class="lf-colorbar">']
    if title:
        parts.append(
            f'<text class="lf-legend" x="{x + 9:.1f}" y="{y0 - 10}" text-anchor="middle">'
            f"{_esc(title)}</text>"
        )
    for i in range(steps):
        t = i / max(1, steps - 1)
        yy = y1 - (i + 1) * height / steps
        parts.append(
            f'<rect x="{x:.1f}" y="{yy:.2f}" width="18" height="{height / steps + 0.8:.2f}" '
            f'fill="{_color(color_name, t)}"/>'
        )
    for frac, value, anchor in (
        (0.0, vmax, "end"),
        (0.5, (vmin + vmax) / 2, "end"),
        (1.0, vmin, "end"),
    ):
        yy = y0 + frac * height + 4
        parts.append(
            f'<text class="lf-tick-label" x="{x + 24:.1f}" y="{yy:.1f}" '
            f'text-anchor="{anchor}">{_esc(_fmt_compact(value))}</text>'
        )
    parts.append("</g>")
    return parts


# ---------------------------------------------------------------------------
# 具体图形
# ---------------------------------------------------------------------------


def _style_block() -> str:
    return (
        "<style>"
        ".lf-grid{stroke:#e5e7eb;stroke-width:1;stroke-dasharray:3 4}"
        ".lf-frame{stroke:#374151;stroke-width:1.2}"
        ".lf-tick{stroke:#374151;stroke-width:1}"
        ".lf-tick-label{fill:#4b5563;font-size:12px}"
        ".lf-title{fill:#111827;font-size:19px;font-weight:600}"
        ".lf-axis-label{fill:#374151;font-size:14px}"
        ".lf-legend-box{fill:#ffffff;fill-opacity:1;stroke:#d1d5db;stroke-width:1}"
        ".lf-legend{fill:#374151;font-size:12.5px}"
        "text{font-family:" + FONT + "}"
        "</style>"
    )


def _document(title: str, body: list[str]) -> str:
    label = title or "lecturekit plot"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" '
        f'viewBox="0 0 {WIDTH} {HEIGHT}" role="img" aria-label="{_esc(label)}" '
        f'font-family="{FONT}">'
        f'<defs>{_style_block()}</defs>'
        f'<rect x="0" y="0" width="{WIDTH}" height="{HEIGHT}" fill="#ffffff"/>'
        + "".join(body)
        + "</svg>"
    )


def _line_svg(spec: dict, *, scatter: bool) -> str:
    series = spec.get("series")
    if not isinstance(series, list) or not series:
        raise ValueError("series 必须是非空数组")
    xs_all, ys_all = [], []
    parsed = []
    for i, item in enumerate(series):
        if not isinstance(item, dict):
            raise ValueError(f"series[{i}] 必须是对象")
        x = _finite(item.get("x"), f"series[{i}].x")
        y = _finite(item.get("y"), f"series[{i}].y")
        if x.size != y.size:
            raise ValueError(f"series[{i}] 的 x/y 长度不一致")
        parsed.append((x, y, item))
        xs_all.append(x)
        ys_all.append(y)

    xlim = spec.get("xlim")
    ylim = spec.get("ylim")
    if isinstance(xlim, (list, tuple)) and len(xlim) == 2:
        xmin, xmax = float(xlim[0]), float(xlim[1])
    else:
        xmin, xmax = _auto_range(float(np.min(np.concatenate(xs_all))), float(np.max(np.concatenate(xs_all))))
    if isinstance(ylim, (list, tuple)) and len(ylim) == 2:
        ymin, ymax = float(ylim[0]), float(ylim[1])
    else:
        ymin, ymax = _auto_range(float(np.min(np.concatenate(ys_all))), float(np.max(np.concatenate(ys_all))))

    logx = bool(spec.get("logx"))
    logy = bool(spec.get("logy"))
    if logx:
        positive = np.concatenate(xs_all)[np.concatenate(xs_all) > 0]
        if positive.size == 0:
            raise ValueError("logx 要求 x 数据包含正数")
        if not isinstance(xlim, (list, tuple)):
            xmin, xmax = float(positive.min()) / 1.05, float(positive.max()) * 1.05
    if logy:
        positive = np.concatenate(ys_all)[np.concatenate(ys_all) > 0]
        if positive.size == 0:
            raise ValueError("logy 要求 y 数据包含正数")
        if not isinstance(ylim, (list, tuple)):
            ymin, ymax = float(positive.min()) / 1.05, float(positive.max()) * 1.05

    axes = _Axes(xmin, xmax, ymin, ymax, logx=logx, logy=logy)
    body = [f'<defs>{axes.defs()}</defs>']
    body.extend(axes.grid_svg(bool(spec.get("grid", True))))
    body.append(f'<g clip-path="url(#{axes.clip_id()})">')
    entries = []
    for i, (x, y, item) in enumerate(parsed):
        color = str(item.get("color") or _PALETTE[i % len(_PALETTE)])
        keep = np.ones(x.size, dtype=bool)
        if logx:
            keep &= x > 0
        if logy:
            keep &= y > 0
        if not keep.any():
            continue
        xd = x[keep]
        yd = y[keep]
        if scatter:
            size = item.get("size", 5)
            try:
                size = float(size)
            except (TypeError, ValueError):
                size = 5.0
            size = min(24.0, max(1.0, size))
            points = "".join(
                f'<circle cx="{axes.sx(px):.2f}" cy="{axes.sy(py):.2f}" r="{size / 2:.2f}" '
                f'fill="{color}" fill-opacity="0.82" stroke="{color}" stroke-width="0.6"/>'
                for px, py in zip(xd.tolist(), yd.tolist())
            )
            body.append(points)
        else:
            pts = " ".join(f"{axes.sx(px):.2f},{axes.sy(py):.2f}" for px, py in zip(xd.tolist(), yd.tolist()))
            dash = item.get("dash")
            dash_attr = ""
            if dash:
                dash_attr = f' stroke-dasharray="{_esc(dash)}"'
            body.append(
                f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2.2" '
                f'stroke-linejoin="round" stroke-linecap="round"{dash_attr}/>'
            )
        label = item.get("label")
        if label:
            entries.append((str(label), color, "point" if scatter else "line"))
    body.append("</g>")
    body.extend(axes.frame_svg(spec.get("title"), spec.get("xlabel"), spec.get("ylabel")))
    body.extend(_legend_svg(entries, axes))
    return _document(str(spec.get("title") or ""), body)


def _parametric_svg(spec: dict) -> str:
    series = spec.get("series")
    if not isinstance(series, list) or not series:
        raise ValueError("series 必须是非空数组")
    samples = int(spec.get("samples", 400))
    samples = min(4000, max(2, samples))
    curves = []
    xs_all, ys_all = [], []
    for i, item in enumerate(series):
        if not isinstance(item, dict):
            raise ValueError(f"series[{i}] 必须是对象")
        try:
            t0 = float(item.get("t0", 0.0))
            t1 = float(item.get("t1", 2 * math.pi))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"series[{i}].t0/t1 必须是数值") from exc
        if not (math.isfinite(t0) and math.isfinite(t1)) or t1 <= t0:
            raise ValueError(f"series[{i}] 要求 t1 > t0 且为有限数")
        t = np.linspace(t0, t1, samples)
        fx = item.get("fx", "cos(t)")
        fy = item.get("fy", "sin(t)")
        xs = _eval_grid(fx, t, t, "t", "t", f"series[{i}].fx")
        ys = _eval_grid(fy, t, t, "t", "t", f"series[{i}].fy")
        curves.append((t, xs, ys, item))
        xs_all.append(xs)
        ys_all.append(ys)

    xlim = spec.get("xlim")
    ylim = spec.get("ylim")
    logx = bool(spec.get("logx"))
    logy = bool(spec.get("logy"))
    all_x = np.concatenate(xs_all)
    all_y = np.concatenate(ys_all)
    if isinstance(xlim, (list, tuple)) and len(xlim) == 2:
        xmin, xmax = float(xlim[0]), float(xlim[1])
    elif logx:
        positive = all_x[all_x > 0]
        if positive.size == 0:
            raise ValueError("logx 要求 x 数据包含正数")
        xmin, xmax = float(positive.min()) / 1.05, float(positive.max()) * 1.05
    else:
        xmin, xmax = _auto_range(float(np.min(all_x)), float(np.max(all_x)))
    if isinstance(ylim, (list, tuple)) and len(ylim) == 2:
        ymin, ymax = float(ylim[0]), float(ylim[1])
    elif logy:
        positive = all_y[all_y > 0]
        if positive.size == 0:
            raise ValueError("logy 要求 y 数据包含正数")
        ymin, ymax = float(positive.min()) / 1.05, float(positive.max()) * 1.05
    else:
        ymin, ymax = _auto_range(float(np.min(all_y)), float(np.max(all_y)))

    axes = _Axes(xmin, xmax, ymin, ymax, logx=logx, logy=logy)
    body = [f'<defs>{axes.defs()}</defs>']
    body.extend(axes.grid_svg(bool(spec.get("grid", True))))
    body.append(f'<g clip-path="url(#{axes.clip_id()})">')
    entries = []
    for i, (_t, xs, ys, item) in enumerate(curves):
        color = str(item.get("color") or _PALETTE[i % len(_PALETTE)])
        keep = np.ones(xs.size, dtype=bool)
        if logx:
            keep &= xs > 0
        if logy:
            keep &= ys > 0
        if not keep.any():
            continue
        xd, yd = xs[keep], ys[keep]
        pts = " ".join(f"{axes.sx(px):.2f},{axes.sy(py):.2f}" for px, py in zip(xd.tolist(), yd.tolist()))
        body.append(
            f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2.2" '
            f'stroke-linejoin="round" stroke-linecap="round"/>'
        )
        label = item.get("label")
        if label:
            entries.append((str(label), color, "line"))
    body.append("</g>")
    body.extend(axes.frame_svg(spec.get("title"), spec.get("xlabel", "x"), spec.get("ylabel", "y")))
    body.extend(_legend_svg(entries, axes))
    return _document(str(spec.get("title") or ""), body)


def _range_pair(spec: dict, key: str, default: tuple[float, float]) -> tuple[float, float]:
    raw = spec.get(key)
    if isinstance(raw, (list, tuple)) and len(raw) == 2:
        try:
            lo, hi = float(raw[0]), float(raw[1])
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{key} 必须是两个数值") from exc
        if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
            raise ValueError(f"{key} 要求 [下界, 上界] 且下界小于上界")
        return lo, hi
    return default


def _grid_resolution(spec: dict, default: int) -> int:
    raw = spec.get("grid")
    if isinstance(raw, bool):
        return default
    try:
        n = int(raw) if raw is not None else default
    except (TypeError, ValueError) as exc:
        raise ValueError("grid 必须是整数分辨率") from exc
    return min(401, max(9, n))


def _vector_field_svg(spec: dict) -> str:
    xr = _range_pair(spec, "xrange", (-2.0, 2.0))
    yr = _range_pair(spec, "yrange", (-2.0, 2.0))
    n = _grid_resolution(spec, 21)
    xs = np.linspace(xr[0], xr[1], n)
    ys = np.linspace(yr[0], yr[1], n)
    gx, gy = np.meshgrid(xs, ys)
    u = _eval_grid(spec.get("u", "-y"), gx, gy, "x", "y", "u")
    v = _eval_grid(spec.get("v", "x"), gx, gy, "x", "y", "v")
    mag = np.hypot(u, v)
    vmax = float(np.max(mag)) if mag.size else 0.0
    if not math.isfinite(vmax) or vmax <= 0:
        vmax = 1.0
    color_name = str(spec.get("colormap") or "viridis")
    axes = _Axes(xr[0], xr[1], yr[0], yr[1], right=CB_RIGHT)
    body = [f'<defs>{axes.defs()}</defs>']
    body.extend(axes.grid_svg(bool(spec.get("grid", True))))
    body.append(f'<g clip-path="url(#{axes.clip_id()})">')
    cell = min((axes.right - LEFT) / max(1, n - 1), (BOTTOM - TOP) / max(1, n - 1))
    for row in range(n):
        for col in range(n):
            ux = float(u[row, col])
            uy = float(v[row, col])
            m = math.hypot(ux, uy)
            if m <= 1e-12 or not math.isfinite(m):
                continue
            norm = min(1.0, m / vmax)
            # 箭头长度基本一致（保证中心弱场也可见），颜色才编码强弱
            length = cell * (0.45 + 0.4 * norm)
            cx = float(axes.sx(float(gx[row, col])))
            cy = float(axes.sy(float(gy[row, col])))
            dx = ux / m
            dy = -uy / m
            tail_x, tail_y = cx - dx * length / 2, cy - dy * length / 2
            tip_x, tip_y = cx + dx * length / 2, cy + dy * length / 2
            head = min(6.0, length * 0.45)
            base_x, base_y = tip_x - dx * head, tip_y - dy * head
            px, py = -dy * head * 0.45, dx * head * 0.45
            color = _color(color_name, norm)
            body.append(
                f'<line x1="{tail_x:.2f}" y1="{tail_y:.2f}" x2="{base_x:.2f}" y2="{base_y:.2f}" '
                f'stroke="{color}" stroke-width="1.5"/>'
                f'<polygon points="{tip_x:.2f},{tip_y:.2f} {base_x + px:.2f},{base_y + py:.2f} '
                f'{base_x - px:.2f},{base_y - py:.2f}" fill="{color}"/>'
            )
    body.append("</g>")
    body.extend(axes.frame_svg(spec.get("title"), spec.get("xlabel", "x"), spec.get("ylabel", "y")))
    body.extend(_colorbar_svg(axes, color_name, 0.0, vmax, spec.get("clabel") or "|F|"))
    return _document(str(spec.get("title") or ""), body)


def _heatmap_svg(spec: dict) -> str:
    xr = _range_pair(spec, "xrange", (-math.pi, math.pi))
    yr = _range_pair(spec, "yrange", (-math.pi, math.pi))
    n = _grid_resolution(spec, 81)
    xs = np.linspace(xr[0], xr[1], n)
    ys = np.linspace(yr[0], yr[1], n)
    gx, gy = np.meshgrid(xs, ys)
    z = _eval_grid(spec.get("f", "sin(x)*cos(y)"), gx, gy, "x", "y", "f")
    color_name = str(spec.get("colormap") or "viridis")

    vmin_raw = spec.get("vmin")
    vmax_raw = spec.get("vmax")
    vmin = float(vmin_raw) if vmin_raw is not None else float(np.min(z))
    vmax = float(vmax_raw) if vmax_raw is not None else float(np.max(z))
    if not (math.isfinite(vmin) and math.isfinite(vmax)):
        raise ValueError("heatmap 的 vmin/vmax 必须是有限数")
    if vmax <= vmin:
        vmax = vmin + 1.0

    axes = _Axes(xr[0], xr[1], yr[0], yr[1], right=CB_RIGHT)
    body = [f'<defs>{axes.defs()}</defs>']
    body.append(f'<g clip-path="url(#{axes.clip_id()})">')
    cols = min(60, n - 1)
    rows = min(60, n - 1)
    # 对原始网格做块平均后画矩形，块大小 ≤ 60×60，既平滑又不至于让 SVG 爆炸
    for ci in range(cols):
        xa = xr[0] + (xr[1] - xr[0]) * ci / cols
        xb = xr[0] + (xr[1] - xr[0]) * (ci + 1) / cols
        i0 = int(round(ci * (n - 1) / cols))
        i1 = max(i0 + 1, int(round((ci + 1) * (n - 1) / cols)))
        for rj in range(rows):
            ya = yr[0] + (yr[1] - yr[0]) * rj / rows
            yb = yr[0] + (yr[1] - yr[0]) * (rj + 1) / rows
            j0 = int(round(rj * (n - 1) / rows))
            j1 = max(j0 + 1, int(round((rj + 1) * (n - 1) / rows)))
            block = z[j0:j1, i0:i1]
            value = float(np.mean(block)) if block.size else float(z[min(j0, n - 1), min(i0, n - 1)])
            t = (value - vmin) / (vmax - vmin)
            x = axes.sx(xa)
            y = axes.sy(yb)
            w = axes.sx(xb) - x
            h = axes.sy(ya) - y
            body.append(
                f'<rect x="{x:.2f}" y="{y:.2f}" width="{max(0.2, w + 0.8):.2f}" '
                f'height="{max(0.2, h + 0.8):.2f}" fill="{_color(color_name, t)}"/>'
            )
    body.append("</g>")
    # 热图默认也画一层浅色网格，保持与其它图一致（不遮挡颜色，只在块边界上叠加细线）。
    body.extend(axes.grid_svg(True))
    if bool(spec.get("contours", False)):
        levels = spec.get("levels")
        body.append(f'<g clip-path="url(#{axes.clip_id()})">')
        body.extend(_contour_paths(z, axes, levels, color_name, vmin, vmax))
        body.append("</g>")
    body.extend(axes.frame_svg(spec.get("title"), spec.get("xlabel", "x"), spec.get("ylabel", "y")))
    body.extend(_colorbar_svg(axes, color_name, vmin, vmax, spec.get("clabel")))
    return _document(str(spec.get("title") or ""), body)


def _contour_paths(z: np.ndarray, axes: _Axes, levels, color_name: str, vmin: float, vmax: float) -> list[str]:
    n_y, n_x = z.shape
    if levels is None:
        lo, hi = float(np.min(z)), float(np.max(z))
        if hi <= lo:
            hi = lo + 1.0
        step = _nice_step(hi - lo, 6)
        levels = []
        v = math.ceil(lo / step) * step
        while v < hi and len(levels) < 40:
            levels.append(v)
            v += step
    if not isinstance(levels, (list, tuple)) or not levels:
        raise ValueError("contour 的 levels 必须是非空数值数组")
    try:
        level_values = [float(v) for v in levels]
    except (TypeError, ValueError) as exc:
        raise ValueError("contour 的 levels 必须全部是数值") from exc

    x0, x1 = axes.xmin, axes.xmax
    y0, y1 = axes.ymin, axes.ymax
    span = max(1e-9, abs(vmax - vmin), abs(vmin), abs(vmax))
    # 抬高一丁点，避开 level 恰好落在网格顶点上的退化情形
    eps = span * 1e-9
    parts = []
    for level in level_values:
        lev = level + eps
        segments: list[str] = []

        def edge_point(a: float, b: float, pa, pb):
            t = (lev - a) / (b - a)
            t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
            return (pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1]))

        for j in range(n_y - 1):
            for i in range(n_x - 1):
                v00 = float(z[j, i])
                v10 = float(z[j, i + 1])
                v11 = float(z[j + 1, i + 1])
                v01 = float(z[j + 1, i])
                case = (1 if v00 > lev else 0) | (2 if v10 > lev else 0)
                case |= (4 if v11 > lev else 0) | (8 if v01 > lev else 0)
                if case == 0 or case == 15:
                    continue

                # 边编号：0=下，1=右，2=上，3=左
                crossings: dict[int, tuple[float, float]] = {}
                if (v00 > lev) != (v10 > lev):
                    crossings[0] = edge_point(v00, v10, (i, j), (i + 1, j))
                if (v10 > lev) != (v11 > lev):
                    crossings[1] = edge_point(v10, v11, (i + 1, j), (i + 1, j + 1))
                if (v01 > lev) != (v11 > lev):
                    crossings[2] = edge_point(v01, v11, (i, j + 1), (i + 1, j + 1))
                if (v00 > lev) != (v01 > lev):
                    crossings[3] = edge_point(v00, v01, (i, j), (i, j + 1))

                table = {
                    1: ((0, 3),),
                    2: ((0, 1),),
                    3: ((3, 1),),
                    4: ((1, 2),),
                    6: ((0, 2),),
                    7: ((3, 2),),
                    8: ((3, 2),),
                    9: ((0, 2),),
                    11: ((1, 2),),
                    12: ((3, 1),),
                    13: ((0, 1),),
                    14: ((0, 3),),
                }
                mean = (v00 + v10 + v11 + v01) / 4.0
                if case == 5:
                    pairs = ((0, 1), (2, 3)) if mean > lev else ((0, 3), (1, 2))
                elif case == 10:
                    pairs = ((0, 3), (1, 2)) if mean > lev else ((0, 1), (2, 3))
                else:
                    pairs = table.get(case, ())

                for e0, e1 in pairs:
                    p0 = crossings.get(e0)
                    p1 = crossings.get(e1)
                    if p0 is None or p1 is None:
                        continue
                    gx0 = x0 + (x1 - x0) * (p0[0] / (n_x - 1))
                    gy0 = y0 + (y1 - y0) * (p0[1] / (n_y - 1))
                    gx1 = x0 + (x1 - x0) * (p1[0] / (n_x - 1))
                    gy1 = y0 + (y1 - y0) * (p1[1] / (n_y - 1))
                    segments.append(
                        f"M{axes.sx(gx0):.2f},{axes.sy(gy0):.2f}L{axes.sx(gx1):.2f},{axes.sy(gy1):.2f}"
                    )
        if segments:
            t = (level - vmin) / (vmax - vmin) if vmax > vmin else 0.5
            color = _color(color_name, t)
            parts.append(
                f'<path d="{"".join(segments)}" fill="none" stroke="{color}" '
                f'stroke-width="1.6" stroke-linecap="round"/>'
            )
    return parts


def _contour_svg(spec: dict) -> str:
    xr = _range_pair(spec, "xrange", (-math.pi, math.pi))
    yr = _range_pair(spec, "yrange", (-math.pi, math.pi))
    n = _grid_resolution(spec, 81)
    xs = np.linspace(xr[0], xr[1], n)
    ys = np.linspace(yr[0], yr[1], n)
    gx, gy = np.meshgrid(xs, ys)
    z = _eval_grid(spec.get("f", "sin(x)*cos(y)"), gx, gy, "x", "y", "f")
    color_name = str(spec.get("colormap") or "viridis")
    vmin, vmax = float(np.min(z)), float(np.max(z))
    if vmax <= vmin:
        vmax = vmin + 1.0
    axes = _Axes(xr[0], xr[1], yr[0], yr[1], right=CB_RIGHT)
    body = [f'<defs>{axes.defs()}</defs>']
    body.extend(axes.grid_svg(bool(spec.get("grid", True))))
    body.append(f'<g clip-path="url(#{axes.clip_id()})">')
    body.extend(_contour_paths(z, axes, spec.get("levels"), color_name, vmin, vmax))
    body.append("</g>")
    body.extend(axes.frame_svg(spec.get("title"), spec.get("xlabel", "x"), spec.get("ylabel", "y")))
    body.extend(_colorbar_svg(axes, color_name, vmin, vmax, spec.get("clabel")))
    return _document(str(spec.get("title") or ""), body)


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

_RENDERERS = {
    "line": lambda spec: _line_svg(spec, scatter=False),
    "scatter": lambda spec: _line_svg(spec, scatter=True),
    "parametric": _parametric_svg,
    "vector_field": _vector_field_svg,
    "heatmap": _heatmap_svg,
    "contour": _contour_svg,
}


def render_plot(spec: dict) -> str:
    """把绘图 spec 渲染成自包含 SVG 字符串。

    未知 type、非法数据或表达式错误都会抛出带可读信息的 ``ValueError``。
    """
    if not isinstance(spec, dict):
        raise ValueError("spec 必须是对象")
    kind = spec.get("type")
    renderer = _RENDERERS.get(kind)
    if renderer is None:
        raise ValueError(
            f"未知图类型 {kind!r}，支持：{', '.join(sorted(_RENDERERS))}"
        )
    try:
        svg = renderer(spec)
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001 - 统一转成可读错误
        raise ValueError(f"绘图失败（{kind}）：{type(exc).__name__}: {exc}") from exc
    if re.search(r"(?<![\w.])(NaN|Infinity)(?![\w.])", svg):
        # 理论上不应发生；作为最后的自检，避免坏 SVG 流入讲义
        raise ValueError("生成的 SVG 含非有限数值，已中止")
    return svg
