#!/usr/bin/env python3
"""LectureForge PDF 文本/图片抽取子进程。

用法:
  python extract_pdf.py --input a.pdf --output out.json --max-pages 400 --image-dir imgs

成功: stdout 输出 JSON（同时写 --output）；失败: stdout 输出
{"ok": false, "code": "...", "message": "..."} 并以退出码 1 结束。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import traceback

MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGES_PER_PAGE = 5
MAX_TOTAL_IMAGES = 200


def emit(payload: dict, output_path: str | None, exit_code: int) -> None:
    text = json.dumps(payload, ensure_ascii=False)
    if output_path:
        try:
            with open(output_path, "w", encoding="utf-8") as handle:
                handle.write(text)
        except OSError:
            pass
    sys.stdout.write(text + "\n")
    sys.stdout.flush()
    raise SystemExit(exit_code)


def fail(code: str, message: str, output_path: str | None) -> None:
    emit({"ok": False, "code": code, "message": message}, output_path, 1)


def sniff_type(data: bytes) -> tuple[str | None, int | None, int | None]:
    """不依赖 Pillow 的图片签名识别（兜底）。"""
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        width = int.from_bytes(data[16:20], "big")
        height = int.from_bytes(data[20:24], "big")
        return "png", width, height
    if data.startswith(b"\xff\xd8\xff"):
        index = 2
        while index + 9 < len(data):
            if data[index] != 0xFF:
                index += 1
                continue
            marker = data[index + 1]
            if marker in (0xD8, 0xD9):
                index += 2
                continue
            length = int.from_bytes(data[index + 2:index + 4], "big")
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                height = int.from_bytes(data[index + 5:index + 7], "big")
                width = int.from_bytes(data[index + 7:index + 9], "big")
                return "jpg", width, height
            index += 2 + max(length, 2)
        return "jpg", None, None
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        width = int.from_bytes(data[6:8], "little")
        height = int.from_bytes(data[8:10], "little")
        return "gif", width, height
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp", None, None
    return None, None, None


def image_info(image) -> tuple[bytes | None, str, int | None, int | None]:
    try:
        data = image.data
    except Exception:
        return None, "", None, None
    if isinstance(data, str):
        data = data.encode("latin-1", errors="ignore")
    if not isinstance(data, (bytes, bytearray)) or not data:
        return None, "", None, None
    data = bytes(data)
    fmt = None
    width = None
    height = None
    try:
        from PIL import Image  # pypdf 的图片支持依赖 Pillow
        with Image.open(io.BytesIO(data)) as pil:
            fmt = (pil.format or "").upper()
            width, height = pil.size
    except Exception:
        pass
    mapping = {"JPEG": "jpg", "JPG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif"}
    kind = mapping.get(fmt or "")
    if not kind:
        kind, sniff_w, sniff_h = sniff_type(data)
        width = width if width is not None else sniff_w
        height = height if height is not None else sniff_h
    if not kind:
        return None, "", None, None
    return data, kind, width, height


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-pages", type=int, default=400)
    parser.add_argument("--image-dir", required=True)
    args = parser.parse_args()

    output_path = os.path.abspath(args.output)
    image_dir = os.path.abspath(args.image_dir)
    max_pages = max(1, int(args.max_pages or 1))

    try:
        from pypdf import PdfReader
    except Exception as error:  # noqa: BLE001
        fail("PYPDF_MISSING", f"无法导入 pypdf：{error}", output_path)
        return

    if not os.path.isfile(args.input):
        fail("FILE_NOT_FOUND", f"PDF 文件不存在：{args.input}", output_path)
        return
    try:
        os.makedirs(image_dir, exist_ok=True)
    except OSError as error:
        fail("PARSE_FAILED", f"无法创建图片临时目录：{error}", output_path)
        return

    try:
        reader = PdfReader(args.input, strict=False)
        if getattr(reader, "is_encrypted", False):
            try:
                decrypted = reader.decrypt("")
            except Exception:
                decrypted = False
            if not decrypted:
                fail("ENCRYPTED_PDF", "PDF 已加密，需要密码才能读取。", output_path)
                return
    except Exception as error:  # noqa: BLE001
        fail("PARSE_FAILED", f"无法打开 PDF：{error}", output_path)
        return

    warnings: list[str] = []
    try:
        total_pages = len(reader.pages)
    except Exception as error:  # noqa: BLE001
        fail("PARSE_FAILED", f"无法读取 PDF 页数：{error}", output_path)
        return
    limit = min(total_pages, max_pages)
    if total_pages > limit:
        warnings.append(f"PDF 共 {total_pages} 页，已按 maxPages={max_pages} 截断。")

    pages: list[dict] = []
    figures: list[dict] = []
    seen_images: set[str] = set()
    image_warning_emitted = False
    image_counter = 0

    for index in range(limit):
        page_number = index + 1
        try:
            page = reader.pages[index]
        except Exception as error:  # noqa: BLE001
            warnings.append(f"第 {page_number} 页读取失败：{error}")
            pages.append({"page": page_number, "text": "", "chars": 0})
            continue

        try:
            text = page.extract_text() or ""
        except Exception as error:  # noqa: BLE001
            warnings.append(f"第 {page_number} 页文本抽取失败：{error}")
            text = ""
        if not isinstance(text, str):
            text = str(text)
        text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
        pages.append({"page": page_number, "text": text, "chars": len(text)})

        if image_counter >= MAX_TOTAL_IMAGES:
            continue
        page_images = 0
        try:
            images = list(page.images)
        except Exception as error:  # noqa: BLE001
            if not image_warning_emitted:
                warnings.append(f"PDF 图片抽取不可用：{error}")
                image_warning_emitted = True
            images = []
        for image in images:
            if page_images >= MAX_IMAGES_PER_PAGE or image_counter >= MAX_TOTAL_IMAGES:
                break
            data, kind, width, height = image_info(image)
            if data is None:
                continue
            if len(data) > MAX_IMAGE_BYTES:
                warnings.append(f"第 {page_number} 页有图片超过 20MB，已跳过。")
                continue
            page_images += 1
            digest = hashlib.sha256(data).hexdigest()
            if digest in seen_images:
                continue
            seen_images.add(digest)
            image_counter += 1
            filename = f"img-{image_counter:04d}.{kind}"
            try:
                with open(os.path.join(image_dir, filename), "wb") as handle:
                    handle.write(data)
            except OSError as error:
                warnings.append(f"第 {page_number} 页图片写入失败：{error}")
                continue
            figures.append(
                {
                    "page": page_number,
                    "imageIndex": page_images - 1,
                    "file": filename,
                    "type": kind,
                    "width": width,
                    "height": height,
                }
            )

    metadata = {}
    try:
        info = reader.metadata or {}
        title = info.get("/Title")
        author = info.get("/Author")
        if title:
            metadata["title"] = str(title)
        if author:
            metadata["author"] = str(author)
    except Exception:
        pass
    metadata["totalPages"] = total_pages

    emit(
        {
            "ok": True,
            "pages": pages,
            "figures": figures,
            "metadata": metadata,
            "warnings": warnings,
        },
        output_path,
        0,
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        fail("PARSE_FAILED", f"PDF 解析异常：{error}", None)
