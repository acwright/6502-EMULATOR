import { inflateSync, crc32 } from 'node:zlib'
import { encodePNG } from '../../debug/PNG'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Split a PNG into its chunks, without trusting the encoder under test. */
function chunks(png: Buffer): { type: string; payload: Buffer }[] {
  const out: { type: string; payload: Buffer }[] = []
  let at = SIGNATURE.length
  while (at < png.length) {
    const length = png.readUInt32BE(at)
    const type = png.subarray(at + 4, at + 8).toString('ascii')
    const payload = png.subarray(at + 8, at + 8 + length)
    out.push({ type, payload })
    at += 12 + length // length + type + payload + crc
  }
  return out
}

describe('encodePNG', () => {
  it('starts with the PNG signature', () => {
    const png = encodePNG(1, 1, Buffer.from([255, 0, 0, 255]))
    expect(png.subarray(0, 8)).toEqual(SIGNATURE)
  })

  it('writes an IHDR with the right dimensions and an RGBA color type', () => {
    const png = encodePNG(4, 3, Buffer.alloc(4 * 3 * 4))
    const ihdr = chunks(png).find((c) => c.type === 'IHDR')!

    expect(ihdr.payload.readUInt32BE(0)).toBe(4)
    expect(ihdr.payload.readUInt32BE(4)).toBe(3)
    expect(ihdr.payload[8]).toBe(8) // bit depth
    expect(ihdr.payload[9]).toBe(6) // color type: RGBA
  })

  it('ends with an empty IEND', () => {
    const png = encodePNG(1, 1, Buffer.from([0, 0, 0, 0]))
    const iend = chunks(png).find((c) => c.type === 'IEND')!
    expect(iend.payload).toHaveLength(0)
  })

  // The whole point of the format: a decoder must recover exactly the pixels
  // given, filter bytes included. Decoding via zlib rather than a PNG
  // library keeps this test honest about what the encoder actually wrote.
  it('round-trips pixel data through inflate', () => {
    const width = 3
    const height = 2
    const rgba = Buffer.from(
      Array.from({ length: width * height * 4 }, (_, i) => i % 256)
    )
    const png = encodePNG(width, height, rgba)

    const idat = chunks(png).find((c) => c.type === 'IDAT')!
    const raw = inflateSync(idat.payload)

    const stride = width * 4
    expect(raw).toHaveLength((stride + 1) * height)
    for (let y = 0; y < height; y++) {
      expect(raw[y * (stride + 1)]).toBe(0) // filter byte: none
      expect(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)).toEqual(
        rgba.subarray(y * stride, y * stride + stride)
      )
    }
  })

  it('rejects a buffer of the wrong size rather than encoding garbage', () => {
    expect(() => encodePNG(4, 4, Buffer.alloc(10))).toThrow(/expected/)
  })

  it('produces a chunk CRC that verifies against a value computed independently', () => {
    const png = encodePNG(1, 1, Buffer.from([1, 2, 3, 4]))
    const ihdrStart = SIGNATURE.length
    const length = png.readUInt32BE(ihdrStart)
    const typeAndPayload = png.subarray(ihdrStart + 4, ihdrStart + 8 + length)
    const storedCrc = png.readUInt32BE(ihdrStart + 8 + length)

    expect(storedCrc).toBe(crc32(typeAndPayload) >>> 0)
  })
})
