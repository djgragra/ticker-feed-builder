#!/usr/bin/env python3
"""Generates assets/icon.png (1024), tray icons, icon-mac.png, icon.icns, icon.ico and assets/linux-icons/*.png.
No Python dependencies; the .icns and the resized PNGs use the macOS tools sips and iconutil.
Run on a Mac:  python3 dev/make-icons.py"""
import os, shutil, struct, subprocess, tempfile, zlib

BG, ACCENT, SOFT = (0x16, 0x18, 0x1c), (0xf0, 0x8a, 0x24), (0xb8, 0xbd, 0xc6)

def in_rect(x, y, x0, y0, x1, y1): return x0 <= x <= x1 and y0 <= y <= y1

def in_tri(x, y, a, b, c):
    def s(p, q, r): return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
    p = (x, y); d1, d2, d3 = s(p, a, b), s(p, b, c), s(p, c, a)
    return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))

def glyph(x, y):
    """Ticker: one headline bar (accent), two text lines, and a live dot."""
    if in_rect(x, y, .16, .30, .66, .38): return ACCENT
    if in_rect(x, y, .16, .47, .84, .53): return SOFT
    if in_rect(x, y, .16, .62, .62, .68): return SOFT
    if (x - .78) ** 2 + (y - .34) ** 2 <= .055 ** 2: return ACCENT
    return None

def color_at(x, y, rr=0.2):
    cx = min(max(x, rr), 1 - rr); cy = min(max(y, rr), 1 - rr)
    if (x - cx) ** 2 + (y - cy) ** 2 > rr * rr: return None
    return glyph(x, y) or BG

def png(size, ss=2):
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    c = color_at((px + (sx + .5) / ss) / size, (py + (sy + .5) / ss) / size)
                    if c:
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            n = ss * ss; a = acc[3] // n
            row += bytes([acc[0] // n, acc[1] // n, acc[2] // n, a]) if a else b"\0\0\0\0"
        rows.append(b"\x00" + bytes(row))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
os.makedirs(os.path.join(root, "linux-icons"), exist_ok=True)
master = os.path.join(root, "icon.png")
open(master, "wb").write(png(1024))
shutil.copy(master, os.path.join(root, "icon-mac.png"))

def resized(size, dest):
    subprocess.run(["sips", "-z", str(size), str(size), master, "--out", dest], check=True, stdout=subprocess.DEVNULL)

for s in (16, 32, 48, 64, 128, 256, 512):
    resized(s, os.path.join(root, "linux-icons", "%dx%d.png" % (s, s)))

with tempfile.TemporaryDirectory() as tmp:                 # .icns through iconutil
    iconset = os.path.join(tmp, "icon.iconset"); os.makedirs(iconset)
    for base in (16, 32, 128, 256, 512):
        resized(base, os.path.join(iconset, "icon_%dx%d.png" % (base, base)))
        resized(base * 2, os.path.join(iconset, "icon_%dx%d@2x.png" % (base, base)))
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(root, "icon.icns")], check=True)

sizes = (16, 32, 48, 64, 128, 256)                         # .ico: PNG images inside the container
images = [open(os.path.join(root, "linux-icons", "%dx%d.png" % (s, s)), "rb").read() for s in sizes]
head = struct.pack("<HHH", 0, 1, len(sizes)); offset = 6 + 16 * len(sizes); entries = b""
for s, data in zip(sizes, images):
    entries += struct.pack("<BBBBHHII", 0 if s == 256 else s, 0 if s == 256 else s, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
open(os.path.join(root, "icon.ico"), "wb").write(head + entries + b"".join(images))
def mono(size, ss=3):
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            n = 0
            for sy in range(ss):
                for sx in range(ss):
                    if glyph((px + (sx + .5) / ss) / size, (py + (sy + .5) / ss) / size): n += 1
            row += bytes([0, 0, 0, 255 * n // (ss * ss)])
        rows.append(b"\x00" + bytes(row))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")

open(os.path.join(root, "trayTemplate.png"), "wb").write(mono(22))      # macOS menu bar (template image)
open(os.path.join(root, "trayTemplate@2x.png"), "wb").write(mono(44))
shutil.copy(os.path.join(root, "linux-icons", "32x32.png"), os.path.join(root, "tray.png"))  # Windows / Linux tray
print("icons written")
