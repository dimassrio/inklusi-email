#!/usr/bin/env python3
"""Slice source PNGs into an edition's image assets.

Reads an image-crop manifest (JSON) and writes cropped PNGs. Pure standard
library — no Pillow/ImageMagick required.

Manifest shape (editions/<edition>/crops.json):

    {
      "transparent": true,
      "crops": [
        { "file": "news-01.png", "source": "source/berita-page1.png",
          "x0": 0, "y0": 0, "x1": 302, "y1": 214 }
      ]
    }

`source` is resolved relative to the manifest's folder; outputs are written to
`images/` next to the manifest.

When `transparent` is true (default), the near-white background connected to the
crop border is made transparent (flood fill from the edges), so rounded photos
and covers blend onto colored email backgrounds. Interior whites are kept. Set
`"transparent": false` globally or per crop to disable.
"""

import json
import os
import struct
import sys
import zlib

WHITE = 252  # min channel >= WHITE counts as background white (canvas is 255)
SOFT = 246   # feather band: WHITE-SOFT .. WHITE gets partial alpha


def decode_png(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: not a PNG")
    i = 8
    idat = b""
    width = height = color_type = None
    palette = None
    while i < len(data):
        length = struct.unpack(">I", data[i : i + 4])[0]
        chunk_type = data[i + 4 : i + 8]
        chunk = data[i + 8 : i + 8 + length]
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type = struct.unpack(">IIBB", chunk[:10])
            if bit_depth != 8:
                raise ValueError(f"{path}: only 8-bit PNGs are supported")
        elif chunk_type == b"PLTE":
            palette = chunk
        elif chunk_type == b"IDAT":
            idat += chunk
        elif chunk_type == b"IEND":
            break
        i += 12 + length
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    raw = zlib.decompress(idat)
    bpp = channels
    stride = width * channels
    out = bytearray()
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        f = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        pos += stride
        if f == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out += line
        prev = line

    # Normalise to RGB triples.
    rgb = bytearray(width * height * 3)
    if color_type == 2:
        rgb[:] = out
    elif color_type == 6:
        for n in range(width * height):
            rgb[n * 3 : n * 3 + 3] = out[n * 4 : n * 4 + 3]
    elif color_type in (0, 4):
        for n in range(width * height):
            v = out[n * channels]
            rgb[n * 3] = rgb[n * 3 + 1] = rgb[n * 3 + 2] = v
    elif color_type == 3:
        for n in range(width * height):
            idx = out[n]
            rgb[n * 3 : n * 3 + 3] = palette[idx * 3 : idx * 3 + 3]
    return width, height, bytes(rgb)


def _chunk(tag, payload):
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def encode_png(width, height, pixels, channels):
    color_type = 6 if channels == 4 else 2
    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    stride = width * channels
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw += pixels[y * stride : (y + 1) * stride]
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )


def crop(source, x0, y0, x1, y1, transparent):
    width, height, pix = decode_png(source)
    x0 = max(0, min(x0, width))
    x1 = max(x0, min(x1, width))
    y0 = max(0, min(y0, height))
    y1 = max(y0, min(y1, height))
    cw, chh = x1 - x0, y1 - y0

    rgb = bytearray(cw * chh * 3)
    for y in range(chh):
        s = ((y0 + y) * width + x0) * 3
        rgb[y * cw * 3 : (y + 1) * cw * 3] = pix[s : s + cw * 3]

    if not transparent:
        return cw, chh, bytes(rgb), 3

    n = cw * chh
    minc = bytearray(n)
    white = bytearray(n)
    for p in range(n):
        r, g, b = rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]
        m = r if r < g else g
        if b < m:
            m = b
        minc[p] = m
        white[p] = 1 if m >= WHITE else 0

    # Flood fill background (white connected to the border).
    bg = bytearray(n)
    stack = []
    for x in range(cw):
        for y in (0, chh - 1):
            p = y * cw + x
            if white[p] and not bg[p]:
                bg[p] = 1
                stack.append(p)
    for y in range(chh):
        for x in (0, cw - 1):
            p = y * cw + x
            if white[p] and not bg[p]:
                bg[p] = 1
                stack.append(p)
    while stack:
        p = stack.pop()
        x = p % cw
        y = p // cw
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < chh and 0 <= nx < cw:
                q = ny * cw + nx
                if white[q] and not bg[q]:
                    bg[q] = 1
                    stack.append(q)

    # Compose RGBA with feathered edges.
    rgba = bytearray(n * 4)
    for p in range(n):
        rgba[p * 4] = rgb[p * 3]
        rgba[p * 4 + 1] = rgb[p * 3 + 1]
        rgba[p * 4 + 2] = rgb[p * 3 + 2]
        if bg[p]:
            continue
        alpha = 255
        x = p % cw
        y = p // cw
        edges = (
            (y > 0 and bg[p - cw])
            or (y < chh - 1 and bg[p + cw])
            or (x > 0 and bg[p - 1])
            or (x < cw - 1 and bg[p + 1])
        )
        if edges and minc[p] >= SOFT:
            alpha = int(255 * (WHITE - minc[p]) / (WHITE - SOFT))
            alpha = max(0, min(255, alpha))
        rgba[p * 4 + 3] = alpha
    return cw, chh, bytes(rgba), 4


def main():
    if len(sys.argv) < 2:
        print("usage: extract_images.py <edition>/crops.json", file=sys.stderr)
        sys.exit(2)
    manifest_path = os.path.abspath(sys.argv[1])
    base = os.path.dirname(manifest_path)
    manifest = json.load(open(manifest_path))
    default_transparent = manifest.get("transparent", True)
    out_dir = os.path.join(base, "images")
    os.makedirs(out_dir, exist_ok=True)
    for item in manifest["crops"]:
        transparent = item.get("transparent", default_transparent)
        src = os.path.join(base, item["source"])
        w, h, pixels, ch = crop(src, item["x0"], item["y0"], item["x1"], item["y1"], transparent)
        with open(os.path.join(out_dir, item["file"]), "wb") as fh:
            fh.write(encode_png(w, h, pixels, ch))
        tag = "RGBA" if ch == 4 else "RGB "
        print(f"  {item['file']:<16} <- {item['source']} [{item['x0']},{item['y0']} {item['x1']},{item['y1']}]  {w}x{h} {tag}")


if __name__ == "__main__":
    main()
