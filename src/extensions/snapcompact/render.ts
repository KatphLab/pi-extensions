import { stripVTControlCharacters } from 'node:util'
import {
  compile,
  int,
  lit,
  obj,
  type Static,
  str,
} from '@earendil-works/pi-schema'
import { fontNameSchema, type Glyph, loadFont } from './font.js'
import { encodePng } from './png.js'

const shapeSchema = obj({
  size: int({ minimum: 64, maximum: 2048 }),
  font: fontNameSchema,
  cellWidth: int({ minimum: 8, maximum: 32 }),
  cellHeight: int({ minimum: 13, maximum: 32 }),
})
export type Shape = Static<typeof shapeSchema>
const validShape = compile(shapeSchema)

export const MAX_FRAME_BYTES = 3_000_000

export const frameSchema = obj({
  type: lit('image'),
  mimeType: lit('image/png'),
  data: str({
    minLength: 1,
    maxLength: MAX_FRAME_BYTES,
    pattern: '^[A-Za-z0-9+/]+={0,2}$',
  }),
})
export type Frame = Static<typeof frameSchema>

export type RenderFrame = (text: string, shape: Shape) => Promise<Frame>

/** Keep newlines visible without wasting the rest of each raster row. */
export function normalize(text: string): string {
  const stripped = stripVTControlCharacters(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, '█')
    .replace(/\t/g, ' ')
  return Array.from(stripped, (char) => {
    const code = char.codePointAt(0) ?? 0
    return code < 32 || code === 127
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : char
  }).join('')
}

/** Conservative edges avoid the high-resolution assumptions of newer OMP catalogs. */
export function resolveShape(id: string, api: string, text: string): Shape {
  const lineage = id.toLowerCase()
  const claude = /claude/.test(lineage)
  const gemini = /gemini/.test(lineage)
  const known = claude || gemini || /gpt|o[1-9]/.test(lineage)
  const anthropic = claude || (!known && /anthropic|bedrock/.test(api))
  const google = gemini || (!known && /google/.test(api))
  const size = google ? 2048 : 1568
  if (/[^\u0020-\u007e█]/u.test(text)) {
    return { size, font: 'silver', cellWidth: 16, cellHeight: 16 }
  }
  return {
    size,
    font: '8x13',
    cellWidth: anthropic ? 11 : 8,
    cellHeight: anthropic ? 16 : 22,
  }
}

/** OMP's black-ink alpha blend and cell origins, applied to pre-rasterized glyphs. */
function drawGlyph(
  pixels: Buffer,
  width: number,
  height: number,
  glyph: Glyph,
  x: number,
  y: number,
): void {
  const left = x + glyph.x
  const top = y + glyph.y
  const right = Math.min(glyph.width, width - left)
  const bottom = Math.min(glyph.height, height - top)
  for (let row = Math.max(0, -top); row < bottom; row++) {
    for (let col = Math.max(0, -left); col < right; col++) {
      const target = (top + row) * width + left + col
      const shade = glyph.pixels[row * glyph.width + col] ?? 255
      pixels[target] = Math.floor(((pixels[target] ?? 255) * shade + 127) / 255)
    }
  }
}

/** Portable renderer: fonts are bundled data; PNG compression uses Node/Bun's zlib. */
export async function renderFrame(text: string, shape: Shape): Promise<Frame> {
  if (!validShape.check(shape))
    throw new Error('Invalid snapcompact frame geometry')
  const cols = Math.floor(shape.size / shape.cellWidth)
  const rows = Math.floor(shape.size / shape.cellHeight)
  const chars = [...text]
  if (chars.length > cols * rows)
    throw new Error('Snapcompact page exceeds frame capacity')
  const font = await loadFont(shape.font)
  const contentHeight = Math.ceil(chars.length / cols) * shape.cellHeight
  const height = Math.max(64, contentHeight)
  const pixels = Buffer.alloc(shape.size * height, 255)
  const block: Glyph = {
    width: shape.cellWidth,
    height: shape.cellHeight,
    x: 0,
    y: 0,
    pixels: Buffer.alloc(shape.cellWidth * shape.cellHeight),
  }
  for (const [index, char] of chars.entries()) {
    const glyph = char === '█' ? block : font.get(char.codePointAt(0) ?? 0)
    if (!glyph)
      throw new Error(
        'The archive contains glyphs unavailable in the bitmap font',
      )
    drawGlyph(
      pixels,
      shape.size,
      contentHeight,
      glyph,
      (index % cols) * shape.cellWidth,
      Math.floor(index / cols) * shape.cellHeight,
    )
  }
  const data = await encodePng(pixels, shape.size, height)
  return { type: 'image', mimeType: 'image/png', data }
}
