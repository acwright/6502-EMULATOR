import { crc32, adler32 } from '../../debug/Checksums'

const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'ascii'))

describe('crc32', () => {
  // The standard CRC-32 (IEEE 802.3) check value for the ASCII digits 1-9 —
  // used to validate implementations across languages and libraries.
  it('matches the standard check value for "123456789"', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926)
  })

  it('is 0 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('is deterministic and sensitive to the input', () => {
    expect(crc32(bytes('hello'))).toBe(crc32(bytes('hello')))
    expect(crc32(bytes('hello'))).not.toBe(crc32(bytes('hellp')))
  })
})

describe('adler32', () => {
  it('is 1 for empty input, per RFC 1950', () => {
    expect(adler32(new Uint8Array(0))).toBe(1)
  })

  // Wikipedia's own worked example for the algorithm.
  it('matches a known value for "Wikipedia"', () => {
    expect(adler32(bytes('Wikipedia'))).toBe(0x11e60398)
  })
})
