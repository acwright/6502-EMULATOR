/**
 * CRC-32 and Adler-32, written out rather than pulled from `node:zlib` /
 * `node:crypto`.
 *
 * `createMethods()` — and therefore this module — runs in two places: the
 * headless host under plain Node, and the Electron renderer, which is a
 * browser context with no built-in `zlib` or `crypto` module. Node built-ins
 * would need a bundler polyfill of uncertain API coverage (`zlib.crc32` in
 * particular is a recent addition even Node polyfill packages may not carry);
 * ~30 lines of portable arithmetic sidesteps the question entirely, and both
 * algorithms are simple enough that "written incorrectly" is not a real risk
 * next to "the polyfill doesn't have this export."
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE 802.3) — what PNG chunk checksums and `screen.hash` both use. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Adler-32 (RFC 1950) — the trailer a zlib stream carries. */
export function adler32(data: Uint8Array): number {
  const MOD = 65521
  let a = 1
  let b = 0
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]!) % MOD
    b = (b + a) % MOD
  }
  return ((b << 16) | a) >>> 0
}
