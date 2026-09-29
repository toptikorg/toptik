# Self-hosted fonts

WOFF2 files derived from the official Google Fonts repository (`ofl/<family>/`, https://github.com/google/fonts/tree/main/ofl), all under the SIL Open Font License. License texts are in `licenses/<family>-OFL.txt`.

Regenerate with `python3 scripts/optimize-fonts.py <dir-with-original-ttfs>` (needs `fonttools` and `brotli`).

| Family | Treatment |
| --- | --- |
| Rubik | Subset to Google's `latin` + `hebrew` unicode ranges; wght axis limited to 400-700 (site uses 400-700) |
| Heebo | Same subset; wght axis limited to 300-700 |
| Great Vibes | Same subset (static) |
| Poppins Medium/SemiBold/Bold | Same subset (static, 500/600/700) |
| Assistant, Italiana, Playfair Display | Lossless TTF->WOFF2 conversion only. Their OFL declares a Reserved Font Name, so no glyphs or axes are removed |

The subset ranges are the same ones the site received from Google Fonts before (`subsets: ["latin","hebrew"]` for Rubik/Assistant/Heebo, latin for the rest). Glyph coverage was compared against the originals: no codepoint in those ranges is missing, and all 47-50 Hebrew-block glyphs are kept.

Original TTF sha256:

- Assistant[wght] `1c3b393884f8fb133a1b17f41d26178adae1050a4f86d7a429d1b5658c314fa3`
- GreatVibes-Regular `8d509802186f1b51572531ecf313e8098f9a5bfdfaca93f0c9b34467f9982d15`
- Heebo[wght] `18f930b583fa8fe6b40b2f8263b7ac6afbac07adc91a12467874e7467d3ace30`
- Italiana-Regular `0ad271d9cd42a57cd5c5fa483ae2406a8138b95acb2a43eb73a8d37b7291fee9`
- PlayfairDisplay[wght] `c40f2293766a503bc70cce9e512ef844a4ccb7cbcde792fe2ea31d191917d8d6`
- Poppins-Bold `983676516167748b74de6f4771fb384c664fd913acb8b471122ecacf5da5ea6c`
- Poppins-Medium `90373e7d838d32468438fc3e152dca0bdb12edcab99ea639f158790b1ba1fd05`
- Poppins-SemiBold `d3bf1bdaf0550e83da9ac0b1d1d9fe6db086835a83aa28578e609a394b9a0286`
- Rubik[wght] `1b3a7437ba2af80e465e773ed60c5036d1ba6ace492d89046dbcf18fb31e4e88`

`src/app/layout.tsx` loads these with `next/font/local`, so builds never fetch Google Fonts.
