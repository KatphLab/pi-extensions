/** Maintainer-only importer. Requires a trusted OMP checkout and matching native build. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync, inflateSync } from 'node:zlib'

const root = process.argv[2]
if (!root)
  throw new Error(
    'Usage: bun run scripts/import-snapcompact-fonts.ts <omp-root> [native-entry]',
  )
const nativeEntry =
  process.argv[3] ?? resolve(root, 'packages/natives/native/index.js')
const native = await import(pathToFileURL(resolve(nativeEntry)).href)
const destination = new URL(
  '../src/extensions/snapcompact/fonts/',
  import.meta.url,
)
await mkdir(destination, { recursive: true })

interface Glyph {
  code: number
  width: number
  height: number
  x: number
  y: number
  pixels: Buffer
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

function predictor(
  filter: number,
  left: number,
  up: number,
  corner: number,
): number {
  switch (filter) {
    case 0:
      return 0
    case 1:
      return left
    case 2:
      return up
    case 3:
      return Math.floor((left + up) / 2)
    case 4:
      return paeth(left, up, corner)
    default:
      throw new Error('Unsupported PNG filter')
  }
}

function unfilter(row: Buffer, previous: Buffer, filter: number): void {
  for (let x = 0; x < row.length; x++) {
    row[x] =
      ((row[x] ?? 0) +
        predictor(
          filter,
          row[x - 3] ?? 0,
          previous[x] ?? 0,
          previous[x - 3] ?? 0,
        )) &
      255
  }
}

/** Decode only the non-interlaced, RGB8 grayscale pages emitted by OMP's Silver path. */
function decode(png: Buffer): Buffer {
  if (png[24] !== 8 || png[25] !== 2 || png[28] !== 0)
    throw new Error('Expected RGB8 PNG from OMP')
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const chunks: Buffer[] = []
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      chunks.push(png.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const raw = inflateSync(Buffer.concat(chunks), {
    maxOutputLength: 16_000_000,
  })
  const stride = width * 3
  if (raw.length !== (stride + 1) * height)
    throw new Error('Invalid OMP PNG dimensions')
  const pixels = Buffer.alloc(width * height)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const offset = y * (stride + 1)
    const filter = raw[offset] ?? 0
    const row = Buffer.from(raw.subarray(offset + 1, offset + 1 + stride))
    unfilter(row, previous, filter)
    for (let x = 0; x < width; x++) pixels[y * width + x] = row[x * 3] ?? 255
    previous = row
  }
  return pixels
}

function crop(
  pixels: Buffer,
  size: number,
  origin: number,
  code: number,
): Glyph {
  const x0 = origin % size
  const y0 = Math.floor(origin / size)
  let left = 48
  let right = -1
  let top = 48
  let bottom = -1
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      if (pixels[(y0 + y) * size + x0 + x] === 255) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < 0)
    return { code, width: 0, height: 0, x: 0, y: 0, pixels: Buffer.alloc(0) }
  const width = right - left + 1
  const height = bottom - top + 1
  const data = Buffer.alloc(width * height)
  for (let y = 0; y < height; y++) {
    pixels.copy(
      data,
      y * width,
      (y0 + top + y) * size + x0 + left,
      (y0 + top + y) * size + x0 + right + 1,
    )
  }
  return { code, width, height, x: left - 16, y: top - 16, pixels: data }
}

async function silverGlyphs(): Promise<Glyph[]> {
  let candidates = ''
  for (let code = 32; code <= 0x10_ff_ff; code++) {
    if (code < 0xd8_00 || code > 0xdf_ff)
      candidates += String.fromCodePoint(code)
  }
  const supported: string = native.snapcompactSupportedChars(
    'silver',
    candidates,
  )
  const chars = [...supported].filter((char) => char !== '█')
  const glyphs: Glyph[] = []
  // Isolate each glyph in a 3x3-cell box to retain overhangs and antialiased edges.
  const size = 2016
  const cols = size / 16
  const perRow = cols / 3
  const perPage = perRow * perRow
  for (let offset = 0; offset < chars.length; offset += perPage) {
    const page = chars.slice(offset, offset + perPage)
    const cells = Array<string>(cols * cols).fill(' ')
    for (const [index, char] of page.entries()) {
      cells[
        (Math.floor(index / perRow) * 3 + 1) * cols + (index % perRow) * 3 + 1
      ] = char
    }
    const encoded: string = await native.renderSnapcompactPng(cells.join(''), {
      size,
      font: 'silver',
      cellWidth: 16,
      cellHeight: 16,
      stretch: false,
      variant: 'bw',
      lineRepeat: 1,
    })
    const pixels = decode(Buffer.from(encoded, 'base64'))
    for (const [index, char] of page.entries()) {
      const origin =
        Math.floor(index / perRow) * 48 * size + (index % perRow) * 48
      glyphs.push(crop(pixels, size, origin, char.codePointAt(0) ?? 0))
    }
  }
  return glyphs
}

function asciiGlyph(code: number, block: string): Glyph {
  const bitmap = /BITMAP\n([\s\S]*?)ENDCHAR/
    .exec(block)?.[1]
    ?.trim()
    .split('\n')
  if (bitmap?.length !== 13 || !block.includes('BBX 8 13 0 -2'))
    throw new Error('Unexpected BDF glyph geometry')
  const pixels = Buffer.alloc(8 * 13, 255)
  for (const [y, row] of bitmap.entries()) {
    const bits = Number.parseInt(row, 16)
    for (let x = 0; x < 8; x++) pixels[y * 8 + x] = bits & (128 >> x) ? 0 : 255
  }
  return { code, width: 8, height: 13, x: 0, y: 0, pixels }
}

async function asciiGlyphs(): Promise<Glyph[]> {
  const source = await readFile(
    resolve(root, 'crates/pi-natives/src/fonts/8x13.bdf'),
    'utf8',
  )
  const glyphs: Glyph[] = []
  for (const block of source.split('STARTCHAR ').slice(1)) {
    const code = Number(/ENCODING (\d+)/.exec(block)?.[1])
    if (code < 32 || code > 126 || !Number.isInteger(code)) continue
    glyphs.push(asciiGlyph(code, block))
  }
  if (glyphs.length !== 95)
    throw new Error('Expected all printable ASCII glyphs')
  return glyphs
}

function encode(glyphs: Glyph[]): Buffer {
  const header = Buffer.alloc(12)
  header.write('SCFONT01')
  header.writeUInt32BE(glyphs.length, 8)
  const records = glyphs.map((glyph) => {
    const record = Buffer.alloc(8)
    record.writeUInt32BE(glyph.code, 0)
    record.writeUInt8(glyph.width, 4)
    record.writeUInt8(glyph.height, 5)
    record.writeInt8(glyph.x, 6)
    record.writeInt8(glyph.y, 7)
    return Buffer.concat([record, glyph.pixels])
  })
  return gzipSync(Buffer.concat([header, ...records]), { level: 9 })
}

await writeFile(
  new URL('8x13.bin.gz', destination),
  encode(await asciiGlyphs()),
)
await writeFile(
  new URL('silver.bin.gz', destination),
  encode(await silverGlyphs()),
)
