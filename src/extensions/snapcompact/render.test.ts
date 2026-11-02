import { expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { crc32, inflateSync } from 'node:zlib'
import { normalize, renderFrame, resolveShape } from './render.js'

it('uses reader lineage before gateway API and readable Unicode geometry', () => {
  expect(
    resolveShape('claude-opus-4-6', 'openai-completions', 'ASCII'),
  ).toMatchObject({ cellWidth: 11, cellHeight: 16, size: 1568 })
  expect(
    resolveShape('gemini-3-flash', 'openai-completions', 'ASCII'),
  ).toMatchObject({ size: 2048, cellHeight: 22 })
  expect(resolveShape('gpt-5', 'openai-responses', 'ASCII')).toMatchObject({
    cellWidth: 8,
    cellHeight: 22,
  })
  expect(resolveShape('unknown', 'custom', '你好')).toMatchObject({
    font: 'silver',
    cellWidth: 16,
  })
})

it('normalizes terminal escapes and prevents text from injecting renderer controls', () => {
  expect(normalize('\u001b[31mHello\u001b[0m\r\n\nworld\t!\u000e')).toBe(
    'Hello█world !\\x0e',
  )
})

// Pixel hashes captured from OMP 256b3211's native renderer before removing the dependency.
const referencePages: [string, string][] = [
  [
    'Hello█world!',
    '6975a525123acebaac57e19106d8a57c754395658d958f2ed601191a213438c1',
  ],
  [
    `${'A'.repeat(142)}gjpq`,
    '6bbef41f3ff937a35fbec8871ed09b9f1ee2ec7186e4a54a1481eed8ebd97898',
  ],
  [
    '你好 café 日本語 한글',
    '27d9706627d7aed88048f021510c13e22b1b9987e3d4a281929d02e5f7a1a256',
  ],
]

function pixelsFromPng(png: Buffer): Buffer {
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  )
  const chunks: Buffer[] = []
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset)
    const name = png.toString('ascii', offset + 4, offset + 8)
    expect(png.readUInt32BE(offset + 8 + length)).toBe(
      crc32(png.subarray(offset + 4, offset + 8 + length)),
    )
    if (name === 'IDAT')
      chunks.push(png.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  expect(width).toBe(1568)
  expect(height).toBeGreaterThanOrEqual(64)
  expect(png[24]).toBe(8)
  expect(png[25]).toBe(0) // Standard 8-bit grayscale, not a native/platform-specific format.
  const rows = inflateSync(Buffer.concat(chunks))
  expect(rows.length).toBe((width + 1) * height)
  const pixels = Buffer.alloc(width * height)
  for (let y = 0; y < height; y++) {
    expect(rows[y * (width + 1)]).toBe(0)
    rows.copy(pixels, y * width, y * (width + 1) + 1, (y + 1) * (width + 1))
  }
  return pixels
}

it.each(referencePages)(
  'preserves OMP pixel layout for %s',
  async (text, expectedHash) => {
    const image = await renderFrame(
      text,
      resolveShape('claude', 'anthropic-messages', text),
    )
    expect(image.mimeType).toBe('image/png')
    const pixels = pixelsFromPng(Buffer.from(image.data, 'base64'))
    expect(createHash('sha256').update(pixels).digest('hex')).toBe(expectedHash)
  },
)

it('rejects invalid geometry, overfull pages, and unsupported glyphs instead of losing text', async () => {
  const shape = resolveShape('claude', 'anthropic-messages', '')
  await expect(renderFrame('text', { ...shape, size: 2049 })).rejects.toThrow(
    'geometry',
  )
  const capacity =
    Math.floor(shape.size / shape.cellWidth) *
    Math.floor(shape.size / shape.cellHeight)
  await expect(renderFrame('x'.repeat(capacity + 1), shape)).rejects.toThrow(
    'capacity',
  )
  const unicode = resolveShape('claude', 'anthropic-messages', '\u{10ffff}')
  await expect(renderFrame('\u{10ffff}', unicode)).rejects.toThrow(
    'glyphs unavailable',
  )
})
