"""Render a plot spec to SVG using lecturekit.plot (numpy only).

Usage: python run_plot.py <spec.json> <out.svg>
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: run_plot.py <spec.json> <out.svg>", file=sys.stderr)
        return 2
    spec_path, out_path = sys.argv[1], sys.argv[2]
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        with open(spec_path, "r", encoding="utf-8") as handle:
            spec = json.load(handle)
    except Exception as exc:
        print(f"cannot read spec: {exc}", file=sys.stderr)
        return 3
    if not isinstance(spec, dict):
        print("spec must be a JSON object", file=sys.stderr)
        return 3
    try:
        from lecturekit.plot import render_plot
    except Exception as exc:
        print(f"cannot import lecturekit.plot: {exc}", file=sys.stderr)
        return 4
    try:
        svg = render_plot(spec)
    except Exception as exc:
        print(f"plot failed: {exc}", file=sys.stderr)
        return 5
    if not isinstance(svg, str) or "<svg" not in svg:
        print("render_plot did not return an SVG document", file=sys.stderr)
        return 6
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(svg)
    print(json.dumps({"ok": True, "file": out_path, "bytes": len(svg.encode("utf-8"))}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
