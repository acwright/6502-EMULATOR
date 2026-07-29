import { unescape, parseByteList } from '../../../cli/dbg/text'
import { UsageError } from '../../../cli/args'

describe('unescape', () => {
  // A single-quoted shell string cannot contain a real carriage return, so
  // `6502 dbg send 'LIST\r'` depends on this translation happening here.
  it('turns \\r, \\n and \\t into their real bytes', () => {
    expect(unescape('LIST\\r')).toBe('LIST\r')
    expect(unescape('a\\nb')).toBe('a\nb')
    expect(unescape('a\\tb')).toBe('a\tb')
  })

  it('turns \\\\ into a single backslash', () => {
    expect(unescape('a\\\\b')).toBe('a\\b')
  })

  it('leaves ordinary text alone', () => {
    expect(unescape('PRINT 2+2')).toBe('PRINT 2+2')
  })
})

describe('parseByteList', () => {
  it('reads a contiguous hex string as byte pairs', () => {
    expect(parseByteList('DEADBEEF', 'x')).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('reads a comma-separated list, mixing hex and decimal', () => {
    expect(parseByteList('0xDE, 173, $10', 'x')).toEqual([0xde, 173, 0x10])
  })

  it('reads a space-separated list', () => {
    expect(parseByteList('1 2 3', 'x')).toEqual([1, 2, 3])
  })

  it('rejects a value outside a byte', () => {
    expect(() => parseByteList('256', 'x')).toThrow(UsageError)
    expect(() => parseByteList('-1', 'x')).toThrow(UsageError)
  })

  it('rejects nonsense rather than silently producing NaN', () => {
    expect(() => parseByteList('not-a-byte', 'x')).toThrow(UsageError)
  })
})
