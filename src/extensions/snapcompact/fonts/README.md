# Snapcompact bitmap fonts

These are fixed glyph assets, not executable code or native addons. Normal use requires no font tooling, system fonts, or OMP installation. The TypeScript renderer reads them lazily and writes PNGs with Node/Bun's built-in zlib.

## Sources and licenses

Imported from [oh-my-pi](https://github.com/can1357/oh-my-pi) commit `256b3211bca7458391866a8bcc9369902664be55` (native package release `18.15.0`):

- **`8x13.bin.gz`**: the 95 printable ASCII glyphs from `crates/pi-natives/src/fonts/8x13.bdf`, converted from BDF bit masks to grayscale pixels. The original declares: `COPYRIGHT "Public domain font. Share and enjoy."` Its source credits Markus Kuhn and the X.org Misc Fixed font collection. Natural glyph geometry is 8×13 with ascent 11.
- **`silver.bin.gz`**: 13,778 supported glyphs rasterized at 16px from `crates/pi-natives/src/fonts/Silver.ttf`, retaining grayscale antialiasing and glyph overhang offsets. This is a modified representation of **Silver by Poppy Works / Wolfgang Wozniak**, with contributions from Itou Hiro (PixelMPlus), leedheo (DOSGothic), and ぶち (Buchidot). Silver is licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/); see [Silver.LICENSE](Silver.LICENSE). Original source: <https://poppyworks.itch.io/silver>. The font was rasterized, cropped, and losslessly compressed; no endorsement by its authors is implied.

`█` is drawn directly as a full cell, matching OMP's newline marker. Unsupported glyphs cause normal-summary fallback, not replacement characters. Silver's coverage is finite; it does not cover every script or emoji.

The cell-placement, baseline, clipping, and black-ink blending logic is adapted from `crates/pi-natives/src/snapcompact.rs`. The OMP MIT copyright and permission notice is retained in [OMP.LICENSE](OMP.LICENSE). These notices apply to their named materials, not to unrelated repository code.

## Binary format

Each gzip stream expands to:

1. ASCII magic `SCFONT01` (8 bytes).
2. Glyph count, unsigned 32-bit big-endian.
3. For each glyph: Unicode code point (u32 BE), width (u8), height (u8), horizontal and vertical cell-origin offsets (signed i8 each), then `width × height` grayscale bytes. `0` is black and `255` is white. A space may have no pixels.

The importer isolates each Silver glyph in a padded 48×48 region before cropping so neighboring glyphs do not contaminate the stored bitmap. Runtime font decompression is capped at 2 MB per font. The two compressed assets together occupy approximately 468 KiB; their total decompressed payload is approximately 1.35 MiB.

## Regenerate

This is a **maintainer-only** operation. It requires Bun, the trusted OMP source checkout above, and its matching built native addon. They are not runtime dependencies of this extension. The importer decodes OMP's PNG pages with built-in zlib, never downloads packages, and starts no subprocesses.

```sh
# Use the native entry from a matching, already-built OMP checkout:
bun run fonts:import /absolute/path/to/oh-my-pi

# Or explicitly select an existing matching native package entry:
bun run fonts:import /absolute/path/to/oh-my-pi /absolute/path/to/pi-natives/native/index.js

bun run check
```

Do not regenerate from an untrusted native entry: the importer executes that module with your permissions. Review asset-size changes and font-license changes when updating upstream. Pixel-hash regression tests in `render.test.ts` compare representative ASCII, wrapped text, and CJK/Korean/Latin pages against OMP's original raster output.
