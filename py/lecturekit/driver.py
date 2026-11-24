#!/usr/bin/env python3
"""LectureForge Notebook 执行器（纯标准库，不依赖 jupyter / nbformat / nbconvert）。

用法::

    python -X utf8 -m lecturekit.driver \
        --input in.ipynb --output out.ipynb --report report.json \
        --cell-timeout 60000 --total-timeout 600000

行为约定：

* 单进程顺序执行所有 code 单元，共享同一份 globals（与 Jupyter kernel 类似）。
* 每个单元捕获 stdout / stderr（单条流截断到 200KB）。
* 单元最后一行是表达式时按 AST 求值，结果先尝试 ``_repr_svg_`` /
  ``_repr_png_`` / ``_repr_html_``（display_data），否则给出 ``text/plain``
  （execute_result）。
* 单元异常记 error output 并继续；``SystemExit`` / ``KeyboardInterrupt``
  记录后终止后续单元。
* 单元超时通过 ``ctypes.pythonapi.PyThreadState_SetAsyncExc`` 向执行线程注入
  ``TimeoutError``（Windows 生效）；Unix 主线程另用 ``SIGALRM`` 以便打断
  ``time.sleep`` 之类的阻塞调用。超时单元记 error 并继续。
* 退出码：0 = 正常完成（即使有单元失败）；2 = 参数 / IO / 格式错误。
"""

from __future__ import annotations

import argparse
import ast
import base64
import builtins
import ctypes
import io
import json
import os
import signal
import sys
import tempfile
import threading
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout

MAX_STREAM_CHARS = 200 * 1024
EXPR_FILENAME = "<lecturekit-expr>"

# 由 main() 填充：需要从错误信息里抹掉的临时目录前缀。
_TEMP_PREFIXES: list[str] = []


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------


def _truncate(text: str, limit: int = MAX_STREAM_CHARS) -> str:
    if text is None:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…[输出已截断]"


def _sanitize(text: str) -> str:
    """清掉临时工作目录前缀，保留可读的相对路径。"""
    out = str(text)
    for prefix in _TEMP_PREFIXES:
        if not prefix:
            continue
        out = out.replace(prefix + os.sep, "")
        out = out.replace(prefix + "/", "")
        out = out.replace(prefix, "")
    return out


def _cell_source(cell: dict) -> str:
    source = cell.get("source", "")
    if isinstance(source, list):
        return "".join(str(part) for part in source)
    return str(source)


def _split_lines(text: str) -> list[str]:
    lines = text.splitlines(keepends=True)
    return lines if lines else [""]


def _stream_output(name: str, text: str) -> dict:
    return {
        "output_type": "stream",
        "name": name,
        "text": _split_lines(_truncate(text)),
    }


# ---------------------------------------------------------------------------
# 超时注入
# ---------------------------------------------------------------------------


def _set_async_exc(thread_id: int, exc_type) -> bool:
    """向指定线程注入 / 清除异步异常；失败时返回 False（不抛异常）。"""
    try:
        if exc_type is None:
            ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(thread_id), None)
        else:
            ctypes.pythonapi.PyThreadState_SetAsyncExc(
                ctypes.c_ulong(thread_id), ctypes.py_object(exc_type)
            )
        return True
    except Exception:
        return False


class _TimeoutState:
    def __init__(self) -> None:
        self.timed_out = False
        self.finished = False
        self.lock = threading.Lock()


def _timeout_outcome(message: str) -> dict:
    return {
        "outputs": [],
        "timed_out": True,
        "error": {
            "ename": "TimeoutError",
            "evalue": message,
            "traceback": [f"TimeoutError: {message}"],
        },
    }


def _merge_timeout(outcome: dict, message: str) -> dict:
    """保留超时前已经捕获的 stdout/stderr，只替换 error 输出。"""
    error = _timeout_outcome(message)["error"]
    outputs = [
        item
        for item in outcome.get("outputs") or []
        if item.get("output_type") != "error"
    ]
    outputs.append({"output_type": "error", **error})
    merged = dict(outcome)
    merged.update({"outputs": outputs, "timed_out": True, "error": error})
    return merged


def _run_cell_timed(
    source: str,
    ns: dict,
    filename: str,
    timeout_s: float,
    label: str,
    execution_count: int,
) -> dict:
    """执行一个单元，附单元超时。返回 {outputs, timed_out, error}。"""
    state = _TimeoutState()
    thread_id = threading.get_ident()
    timer = None
    use_signal = (
        os.name != "nt"
        and hasattr(signal, "setitimer")
        and hasattr(signal, "SIGALRM")
        and threading.current_thread() is threading.main_thread()
    )
    previous_handler = None

    def fire_from_thread() -> None:
        with state.lock:
            if state.finished:
                return
            state.timed_out = True
            # 注入必须在锁内完成：cleanup() 也拿同一把锁，之后才清除 pending 异常，
            # 避免"先清除、后注入"把 TimeoutError 泄漏到下一个单元。
            _set_async_exc(thread_id, TimeoutError)

    def fire_from_signal(signum, frame):  # pragma: no cover - 仅 Unix
        state.timed_out = True
        raise TimeoutError(f"单元执行超时（{label}）")

    if timeout_s and timeout_s > 0:
        if use_signal:
            try:
                previous_handler = signal.signal(signal.SIGALRM, fire_from_signal)
                signal.setitimer(signal.ITIMER_REAL, float(timeout_s))
            except (OSError, ValueError):
                use_signal = False
                previous_handler = None
        if not use_signal:
            timer = threading.Timer(float(timeout_s), fire_from_thread)
            timer.daemon = True
            timer.start()

    message = f"单元执行超时（{label}）"

    def cleanup() -> None:
        with state.lock:
            state.finished = True
        if timer is not None:
            timer.cancel()
        if use_signal:
            try:
                signal.setitimer(signal.ITIMER_REAL, 0)
                if previous_handler is not None:
                    signal.signal(signal.SIGALRM, previous_handler)
            except (OSError, ValueError):
                pass
        # 清除尚未送达的异步异常，避免污染后续单元。
        if os.name == "nt":
            _set_async_exc(thread_id, None)

    try:
        try:
            outcome = _run_cell_inner(source, ns, filename, execution_count)
        except TimeoutError:
            outcome = _timeout_outcome(message)
        if state.timed_out:
            outcome = _merge_timeout(outcome, message)
        return outcome
    except TimeoutError:
        # 异步异常在单元结束后的清理阶段才送达（极小概率）。
        return _timeout_outcome(message)
    finally:
        for attempt in (0, 1):
            try:
                cleanup()
                break
            except TimeoutError:  # pragma: no cover - 清理阶段收到迟到注入
                if attempt == 1:
                    raise


# ---------------------------------------------------------------------------
# 单元执行
# ---------------------------------------------------------------------------


def _format_exception(exc: BaseException) -> list[str]:
    # SyntaxError 的 traceback 只有解释器内部帧（ast.parse），Jupyter 风格是
    # 直接给出源码位置；这里只保留 format_exception_only 的定位信息。
    if isinstance(exc, SyntaxError):
        return [
            _sanitize(line.rstrip("\n"))
            for line in traceback.format_exception_only(type(exc), exc)
        ]
    lines: list[str] = []
    tb = exc.__traceback__
    if tb is not None:
        entries = [e for e in traceback.extract_tb(tb) if e.filename != __file__]
        if entries:
            lines.append("Traceback (most recent call last):")
            for entry in entries:
                lines.append(f'  File "{entry.filename}", line {entry.lineno}, in {entry.name}')
                if entry.line:
                    lines.append("    " + entry.line.strip())
    for line in traceback.format_exception_only(type(exc), exc):
        lines.append(line.rstrip("\n"))
    return [_sanitize(line) for line in lines]


def _error_output(exc: BaseException, ename: str | None = None) -> dict:
    name = ename or type(exc).__name__
    try:
        evalue = _sanitize(str(exc))
    except Exception:
        evalue = ""
    return {
        "ename": name,
        "evalue": evalue,
        "traceback": _format_exception(exc) or [f"{name}: {evalue}"],
    }


def _mime_output(value, execution_count: int) -> dict | None:
    """把表达式结果转成 Jupyter output（display_data 或 execute_result）。"""
    data: dict[str, list[str]] = {}
    for attr, mime in (
        ("_repr_svg_", "image/svg+xml"),
        ("_repr_png_", "image/png"),
        ("_repr_html_", "text/html"),
    ):
        method = getattr(value, attr, None)
        if not callable(method):
            continue
        try:
            payload = method()
        except Exception:
            continue
        if payload is None:
            continue
        if isinstance(payload, (bytes, bytearray)):
            if mime == "image/png":
                payload = base64.b64encode(bytes(payload)).decode("ascii")
            else:
                payload = bytes(payload).decode("utf-8", "replace")
        if not isinstance(payload, str):
            payload = str(payload)
        data[mime] = _split_lines(_truncate(payload))
        break

    if data:
        return {"output_type": "display_data", "data": data, "metadata": {}}

    try:
        text = repr(value)
        if not isinstance(text, str):
            text = str(text)
    except Exception as exc:  # repr 自身出错时不要让整个 notebook 崩掉
        text = f"<repr 失败: {type(exc).__name__}: {exc}>"
    return {
        "output_type": "execute_result",
        "execution_count": execution_count,
        "data": {"text/plain": _split_lines(_truncate(text))},
        "metadata": {},
    }


def _run_cell_inner(source: str, ns: dict, filename: str, execution_count: int) -> dict:
    """真正执行代码；始终返回 outcome，不向外抛业务异常。"""
    stdout = io.StringIO()
    stderr = io.StringIO()
    outputs: list[dict] = []
    error: dict | None = None
    aborted = False

    try:
        tree = ast.parse(source, filename=filename, mode="exec")
        body = tree.body
        expr_node = None
        if body and isinstance(body[-1], ast.Expr):
            expr_node = body[-1].value
            body = body[:-1]
        module = ast.Module(body=body, type_ignores=[])
        ast.fix_missing_locations(module)
        exec_code = compile(module, filename, "exec")
        expr_code = None
        if expr_node is not None:
            expr_code = compile(
                ast.fix_missing_locations(ast.Expression(body=expr_node)),
                filename,
                "eval",
            )

        result = None
        has_result = False
        with redirect_stdout(stdout), redirect_stderr(stderr):
            exec(exec_code, ns)
            if expr_code is not None:
                result = eval(expr_code, ns)
                has_result = True
        if has_result and result is not None:  # 与 IPython 一致：None 不产生 execute_result
            mime = _mime_output(result, execution_count)
            if mime is not None:
                outputs.append(mime)
    except SystemExit as exc:
        error = _error_output(exc, "SystemExit")
        aborted = True
    except KeyboardInterrupt as exc:
        error = _error_output(exc, "KeyboardInterrupt")
        aborted = True
    except BaseException as exc:  # noqa: BLE001 - 用户代码可能抛出任何东西
        error = _error_output(exc)

    captured_out = stdout.getvalue()
    captured_err = stderr.getvalue()
    if captured_out:
        outputs.insert(0, _stream_output("stdout", captured_out))
    if captured_err:
        insert_at = 1 if captured_out else 0
        outputs.insert(insert_at, _stream_output("stderr", captured_err))

    if error is not None:
        outputs.append({"output_type": "error", **error})

    return {"outputs": outputs, "timed_out": False, "error": error, "aborted": aborted}


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m lecturekit.driver",
        description="顺序执行 ipynb 中的 code 单元并写回 outputs（无需 Jupyter）。",
        allow_abbrev=False,
    )
    parser.add_argument("--input", required=True, help="输入 .ipynb 路径")
    parser.add_argument("--output", required=True, help="输出 .ipynb 路径")
    parser.add_argument("--report", default=None, help="report JSON 路径（缺省 <output>.report.json）")
    parser.add_argument("--cell-timeout", type=int, default=60000, help="单单元超时毫秒（0=不限）")
    parser.add_argument("--total-timeout", type=int, default=600000, help="总超时毫秒（0=不限）")
    return parser


def _write_json(path: str, payload) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
        handle.write("\n")


def run(
    notebook: dict,
    cell_timeout_ms: int = 60000,
    total_timeout_ms: int = 600000,
) -> tuple[dict, dict]:
    """执行 notebook（原地修改副本）并返回 (notebook, report)。"""
    cells = notebook.get("cells")
    if not isinstance(cells, list):
        raise ValueError("notebook 缺少 cells 数组")
    cell_timeout_s = max(0, int(cell_timeout_ms)) / 1000.0
    total_timeout_s = max(0, int(total_timeout_ms)) / 1000.0
    deadline = time.monotonic() + total_timeout_s if total_timeout_s > 0 else None

    ns: dict = {
        "__name__": "__main__",
        "__doc__": None,
        "__package__": None,
        "__builtins__": builtins,
    }
    executed = 0
    failed = 0
    records: list[dict] = []
    warnings: list[str] = []

    # 先清空所有 code 单元的旧执行结果，避免总超时提前结束时残留陈旧 outputs。
    for cell in cells:
        if isinstance(cell, dict) and cell.get("cell_type") == "code":
            cell["outputs"] = []
            cell["execution_count"] = None

    for index, cell in enumerate(cells):
        if not isinstance(cell, dict) or cell.get("cell_type") != "code":
            continue
        source = _cell_source(cell)
        if not source.strip():
            continue

        remaining_total = None
        if deadline is not None:
            remaining_total = deadline - time.monotonic()
            if remaining_total <= 0:
                warnings.append("已达到总超时，剩余 code 单元未执行")
                break

        limit_s = cell_timeout_s
        total_limited = False
        if remaining_total is not None:
            if limit_s <= 0 or remaining_total <= limit_s:
                limit_s = remaining_total
                total_limited = True

        executed += 1
        cell["execution_count"] = executed
        cell["outputs"] = []
        filename = f"<cell {index + 1}>"
        started = time.monotonic()
        if limit_s > 0:
            label = f"{int(round(limit_s * 1000))} ms"
            try:
                outcome = _run_cell_timed(source, ns, filename, limit_s, label, executed)
            except TimeoutError:
                outcome = _timeout_outcome(f"单元执行超时（{label}）")
        else:
            outcome = _run_cell_inner(source, ns, filename, executed)
        duration_ms = int(round((time.monotonic() - started) * 1000))

        outputs = outcome.get("outputs") or []
        cell["outputs"] = outputs
        error = outcome.get("error")
        timed_out = bool(outcome.get("timed_out"))
        ok = error is None and not timed_out
        if not ok:
            failed += 1
            if error is not None and not any(
                item.get("output_type") == "error" for item in outputs
            ):
                outputs.append({"output_type": "error", **error})
                cell["outputs"] = outputs
        record = {
            "index": index,
            "ok": ok,
            "ename": error.get("ename") if error else None,
            "evalue": error.get("evalue") if error else None,
            "timedOut": timed_out,
            "durationMs": duration_ms,
        }
        records.append(record)

        if outcome.get("aborted"):
            if error and error.get("ename") == "SystemExit":
                warnings.append(f"第 {index + 1} 个单元调用 SystemExit，后续单元已停止")
            elif error and error.get("ename") == "KeyboardInterrupt":
                warnings.append(f"第 {index + 1} 个单元被 KeyboardInterrupt 中断，后续单元已停止")
            break
        if timed_out and (total_limited or (deadline is not None and time.monotonic() >= deadline)):
            warnings.append("已达到总超时，剩余 code 单元未执行")
            break

    report = {
        "executed": executed,
        "failed": failed,
        "cells": records,
        "warnings": warnings,
    }
    return notebook, report


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.cell_timeout < 0 or args.total_timeout < 0:
        print("--cell-timeout / --total-timeout 必须 >= 0", file=sys.stderr)
        return 2

    input_path = os.path.abspath(args.input)
    output_path = os.path.abspath(args.output)
    report_path = os.path.abspath(args.report or (output_path + ".report.json"))
    _TEMP_PREFIXES[:] = []
    temp_root = os.path.normcase(os.path.abspath(tempfile.gettempdir()))
    for candidate in (input_path, output_path, report_path):
        directory = os.path.dirname(candidate)
        if not directory or directory in _TEMP_PREFIXES:
            continue
        # 只抹掉系统临时目录前缀；用户项目里的真实路径应保留可读。
        normalized = os.path.normcase(os.path.abspath(directory))
        if normalized == temp_root or normalized.startswith(temp_root + os.sep):
            _TEMP_PREFIXES.append(directory)
    # 最长前缀优先，避免短路径先替换掉长路径的一部分。
    _TEMP_PREFIXES.sort(key=len, reverse=True)

    try:
        # utf-8-sig：容忍 Windows 工具写出的 BOM。
        with open(input_path, "r", encoding="utf-8-sig") as handle:
            notebook = json.load(handle)
    except (OSError, ValueError) as exc:
        print(f"无法读取 notebook：{exc}", file=sys.stderr)
        return 2
    if not isinstance(notebook, dict):
        print("notebook 顶层必须是 JSON 对象", file=sys.stderr)
        return 2

    try:
        executed_notebook, report = run(notebook, args.cell_timeout, args.total_timeout)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    try:
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        _write_json(output_path, executed_notebook)
        os.makedirs(os.path.dirname(report_path) or ".", exist_ok=True)
        _write_json(report_path, report)
    except OSError as exc:
        print(f"无法写入结果：{exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
