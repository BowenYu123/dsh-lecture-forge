"""Crop a region from a rasterized PDF page.

Usage: python crop_image.py <src.png> <dst.png> <x> <y> <width> <height>
All coordinates are fractions of the page (0..1), origin at the top-left.
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 7:
        print("usage: crop_image.py <src.png> <dst.png> <x> <y> <width> <height>", file=sys.stderr)
        return 2
    try:
        from PIL import Image
    except Exception as exc:  # pragma: no cover - environment problem
        print(f"Pillow is required for cropping: {exc}", file=sys.stderr)
        return 3

    src, dst = sys.argv[1], sys.argv[2]
    try:
        x, y, width, height = (float(v) for v in sys.argv[3:7])
    except ValueError:
        print("coordinates must be numbers", file=sys.stderr)
        return 2
    for name, value in (("x", x), ("y", y), ("width", width), ("height", height)):
        if value < 0 or value > 1:
            print(f"{name} must be within 0..1", file=sys.stderr)
            return 2
    if width <= 0 or height <= 0:
        print("width and height must be positive", file=sys.stderr)
        return 2
    if x + width > 1.0001 or y + height > 1.0001:
        print("region exceeds page bounds", file=sys.stderr)
        return 2

    try:
        image = Image.open(src)
        image = image.convert("RGB")
    except Exception as exc:
        print(f"cannot open source image: {exc}", file=sys.stderr)
        return 4

    page_w, page_h = image.size
    left = max(0, min(page_w - 1, int(round(x * page_w))))
    top = max(0, min(page_h - 1, int(round(y * page_h))))
    right = max(left + 1, min(page_w, int(round((x + width) * page_w))))
    bottom = max(top + 1, min(page_h, int(round((y + height) * page_h))))
    if right <= left or bottom <= top:
        print("empty crop region", file=sys.stderr)
        return 5

    crop = image.crop((left, top, right, bottom))
    crop.save(dst, "PNG")
    print(
        json.dumps(
            {
                "ok": True,
                "file": dst,
                "pageWidth": page_w,
                "pageHeight": page_h,
                "box": [left, top, right, bottom],
                "width": crop.size[0],
                "height": crop.size[1],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
