import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { oneOf, type Static } from '@earendil-works/pi-schema'

export const fontNameSchema = oneOf(['8x13', 'silver'])
type FontName = Static<typeof fontNameSchema>

export interface Glyph {
  width: number
  height: number
  x: number
  y: number
  pixels: Buffer
}

const unzip = promisify(gunzip)
const fonts = new Map<FontName, Promise<ReadonlyMap<number, Glyph>>>()

function decodeFont(data: Buffer): ReadonlyMap<number, Glyph> {
  if (data.toString('ascii', 0, 8) !== 'SCFONT01')
    throw new Error('Invalid bundled bitmap font')
  const count = data.readUInt32BE(8)
  const glyphs = new Map<number, Glyph>()
  let offset = 12
  for (let index = 0; index < count; index++) {
    const code = data.readUInt32BE(offset)
    const width = data.readUInt8(offset + 4)
    const height = data.readUInt8(offset + 5)
    const x = data.readInt8(offset + 6)
    const y = data.readInt8(offset + 7)
    offset += 8
    const end = offset + width * height
    if (width > 48 || height > 48 || end > data.length)
      throw new Error('Invalid bundled glyph bounds')
    glyphs.set(code, {
      width,
      height,
      x,
      y,
      pixels: data.subarray(offset, end),
    })
    offset = end
  }
  if (offset !== data.length) throw new Error('Invalid bundled font length')
  return glyphs
}

async function readFont(name: FontName): Promise<ReadonlyMap<number, Glyph>> {
  const compressed = await readFile(
    new URL(`fonts/${name}.bin.gz`, import.meta.url),
  )
  const data = await unzip(compressed, { maxOutputLength: 2_000_000 })
  return decodeFont(data)
}

/** Fixed, trusted glyph assets are loaded lazily; no runtime TTF parser or native addon. */
export function loadFont(name: FontName): Promise<ReadonlyMap<number, Glyph>> {
  let font = fonts.get(name)
  if (!font) {
    font = readFont(name)
    fonts.set(name, font)
  }
  return font
}
