import { crc32, adler32 } from './Checksums'

/**
 * The minimum PNG a debugger needs: one IHDR, one IDAT, one IEND, 8-bit RGBA,
 * no interlacing, no filtering beyond "none" per row. `Video.buffer` is
 * already exactly this pixel format, so encoding it is a formality rather
 * than a general-purpose image library.
 *
 * The IDAT payload is a zlib stream (RFC 1950) built from DEFLATE (RFC 1951)
 * "stored" — i.e. uncompressed — blocks rather than an actual `node:zlib`
 * call. `createMethods()` runs in the Electron renderer as well as under
 * Node (§4.3), and a browser context has no `zlib`; hand-rolling the trivial
 * uncompressed encoding, per §3.2.4 of the spec, means one implementation
 * works unmodified in both, at the cost of a larger (but still small — a
 * fixed 320×240 frame) file than real compression would produce.
 */

function chunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)

  const typed = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)

  return Buffer.concat([length, typed, crc])
}

/** Longest a single DEFLATE stored block may claim, per RFC 1951 §3.2.4. */
const MAX_STORED_BLOCK = 0xffff

/** Wrap raw bytes as a zlib stream (RFC 1950) of uncompressed DEFLATE blocks. */
function zlibStore(data: Uint8Array): Buffer {
  const blocks: Buffer[] = []
  let offset = 0

  do {
    const length = Math.min(MAX_STORED_BLOCK, data.length - offset)
    const final = offset + length >= data.length
    const block = Buffer.alloc(5 + length)
    block[0] = final ? 1 : 0 // BFINAL in bit 0, BTYPE=00 (stored) fills the rest
    block.writeUInt16LE(length, 1)
    block.writeUInt16LE(length ^ 0xffff, 3) // NLEN: one's complement of LEN
    Buffer.from(data.buffer, data.byteOffset + offset, length).copy(block, 5)
    blocks.push(block)
    offset += length
  } while (offset < data.length)

  // CMF/FLG = 0x78 0x01: a 32K window, fastest compression level, no preset
  // dictionary — the level flag is informational only and stored data is
  // valid under any of them.
  const header = Buffer.from([0x78, 0x01])
  const trailer = Buffer.alloc(4)
  trailer.writeUInt32BE(adler32(data), 0)

  return Buffer.concat([header, ...blocks, trailer])
}

/** Encode an RGBA buffer (`width * height * 4` bytes, row-major) as a PNG. */
export function encodePNG(width: number, height: number, rgba: Buffer | Uint8Array): Buffer {
  const expected = width * height * 4
  if (rgba.length !== expected) {
    throw new Error(`encodePNG: expected ${expected} bytes for ${width}x${height} RGBA, got ${rgba.length}`)
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter: adaptive (per-row, all "none" here)
  ihdr[12] = 0 // interlace: none

  // Every scanline is prefixed with a filter-type byte; 0 ("none") needs no
  // per-pixel transform, which is the right trade for a debugger — simplicity
  // over the space real filtering would otherwise save on a mostly-flat image.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  const idat = chunk('IDAT', zlibStore(raw))
  const iend = chunk('IEND', Buffer.alloc(0))

  return Buffer.concat([signature, chunk('IHDR', ihdr), idat, iend])
}
