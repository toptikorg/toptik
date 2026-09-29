#!/usr/bin/env python3
"""Rebuild src/app/fonts/*.woff2 from the unmodified OFL TTFs (google/fonts, ofl/<family>).

Usage: pip install fonttools brotli && python3 scripts/optimize-fonts.py <dir-with-original-ttfs>

- Rubik, Heebo, Great Vibes, Poppins: subset to the same Unicode ranges the site
  previously received from Google (latin + hebrew) and, for variable fonts,
  limit the wght axis to the weights the site uses. WOFF2 output.
- Assistant, Italiana, Playfair Display: their OFL declares a Reserved Font Name,
  so they are only converted to WOFF2 (lossless: no glyphs or axes removed).
"""
import io
import sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.varLib import instancer

SRC = Path(sys.argv[1])
OUT = Path(__file__).resolve().parent.parent / "src" / "app" / "fonts"

# Google Fonts unicode-range for the `latin` and `hebrew` subsets.
RANGES = [
    (0x0000, 0x00FF), (0x0131, 0x0131), (0x0152, 0x0153), (0x02BB, 0x02BC),
    (0x02C6, 0x02C6), (0x02DA, 0x02DA), (0x02DC, 0x02DC), (0x0304, 0x0304),
    (0x0308, 0x0308), (0x0329, 0x0329), (0x2000, 0x206F), (0x20AC, 0x20AC),
    (0x2122, 0x2122), (0x2191, 0x2191), (0x2193, 0x2193), (0x2212, 0x2212),
    (0x2215, 0x2215), (0xFEFF, 0xFEFF), (0xFFFD, 0xFFFD),
    (0x0590, 0x05FF), (0x200C, 0x2010), (0x20AA, 0x20AA), (0x25CC, 0x25CC),
    (0xFB1D, 0xFB4F),
]
UNICODES = [c for lo, hi in RANGES for c in range(lo, hi + 1)]

SUBSET = {  # file -> wght limit (None = static font)
    "Rubik[wght].ttf": (400, 700),
    "Heebo[wght].ttf": (300, 700),
    "GreatVibes-Regular.ttf": None,
    "Poppins-Medium.ttf": None,
    "Poppins-SemiBold.ttf": None,
    "Poppins-Bold.ttf": None,
}
CONVERT_ONLY = ["Assistant[wght].ttf", "Italiana-Regular.ttf", "PlayfairDisplay[wght].ttf"]

for name, wght in SUBSET.items():
    font = TTFont(SRC / name)
    if wght:
        font = instancer.instantiateVariableFont(font, {"wght": wght})
        buf = io.BytesIO()
        font.save(buf)
        buf.seek(0)
        font = TTFont(buf, lazy=False)
    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    opts.glyph_names = False
    opts.hinting = False
    opts.flavor = "woff2"
    s = subset.Subsetter(opts)
    s.populate(unicodes=UNICODES)
    s.subset(font)
    font.flavor = "woff2"
    font.save(OUT / (Path(name).stem + ".woff2"))

for name in CONVERT_ONLY:
    font = TTFont(SRC / name)
    font.flavor = "woff2"
    font.save(OUT / (Path(name).stem + ".woff2"))
