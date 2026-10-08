#!/usr/bin/env python3
"""Contact sheets for a review folder: one sheet per frame width (1440, 390, 1280), every PNG scaled to a tile with its
file name under it, so a whole pass can be read at a glance before opening single shots.
    python3 qa/contact-sheet.py <review dir>
"""
import glob, os, sys
from PIL import Image, ImageDraw, ImageFont

d = sys.argv[1]
PLAN = {1440: (360, 4), 390: (190, 8), 1280: (400, 3)}  # tile width, columns
font = ImageFont.load_default()
for frame, (tw, cols) in PLAN.items():
    files = sorted(f for f in glob.glob(os.path.join(d, f'*-{frame}.png')) if not os.path.basename(f).startswith('contact-'))
    if not files:
        continue
    tiles = []
    for f in files:
        im = Image.open(f).convert('RGB')
        th = max(1, round(im.height * tw / im.width))
        th = min(th, 900 if frame != 390 else 760)  # a very long page is cropped to its top in the sheet
        tiles.append((os.path.basename(f), im.resize((tw, round(im.height * tw / im.width)), Image.LANCZOS).crop((0, 0, tw, th))))
    rowh = max(t.height for _, t in tiles) + 22
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * (tw + 16) + 16, rows * (rowh + 16) + 16), '#ddd6c8')
    draw = ImageDraw.Draw(sheet)
    for i, (name, t) in enumerate(tiles):
        x = 16 + (i % cols) * (tw + 16); y = 16 + (i // cols) * (rowh + 16)
        sheet.paste(t, (x, y))
        draw.text((x, y + t.height + 4), name, fill='#2b2420', font=font)
    out = os.path.join(d, f'contact-{frame}.png')
    sheet.save(out, optimize=True)
    print(f'{os.path.basename(out)}: {len(tiles)} shots, {sheet.width}x{sheet.height}')
