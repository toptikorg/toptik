# Self-hosted fonts

These unmodified font files are from the official Google Fonts repository under `ofl/<family>/`:

- Italiana
- Great Vibes
- Rubik
- Playfair Display
- Assistant
- Poppins
- Heebo

Each family is licensed under the SIL Open Font License (OFL). The corresponding upstream license text is preserved in `licenses/<family>-OFL.txt`. The font files include the glyph coverage shipped by Google Fonts for their listed family; the Hebrew-capable families are Rubik, Assistant, and Heebo.

`src/app/layout.tsx` loads these files with `next/font/local` so builds do not need to fetch Google Fonts CSS or font binaries from the network. Do not replace them with system fonts or subset them without comparing the live typography and preserving the relevant license notices.

Upstream: https://github.com/google/fonts/tree/main/ofl
