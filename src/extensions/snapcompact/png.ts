import { promisify } from 'node:util'
import { crc32, deflate } from 'node:zlib'

const compress = promisify(deflate)
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function chunk(name: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length, 0)
  result.write(name, 4, 4, 'ascii')
  data.copy(result, 8)
  result.writeUInt32BE(
    crc32(result.subarray(4, data.length + 8)),
    data.length + 8,
  )
  return result
}

/** Standard 8-bit grayscale PNG, with asynchronous deflate and no third-party encoder. */
export async function encodePng(
  pixels: Buffer,
  width: number,
  height: number,
): Promise<string> {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // Bit depth; color type 0 is grayscale, no palette or alpha needed.
  const rows = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    // PNG filter byte stays zero (None), followed by the row's grayscale samples.
    pixels.copy(rows, y * (width + 1) + 1, y * width, (y + 1) * width)
  }
  const data = await compress(rows, { level: 9 })
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', data),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}
