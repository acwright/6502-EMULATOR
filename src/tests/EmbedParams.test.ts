import {
  parseEmbedParams,
  decodeBase64,
  DEFAULT_EMBED_CF_SIZE,
  PERSISTENT_CF_SIZE,
} from '../renderer/src/embed/params'
import type { MediaSource } from '../renderer/src/embed/params'

/**
 * The embed's URL parameter API.
 *
 * This is the file the whole embed contract hangs on, and it is the only part of
 * the embed that can be tested without a browser — which is why the parser has
 * no imports. A docs site pins an emulator version and writes URLs against it,
 * so the two properties worth defending are that a malformed value degrades to
 * its default rather than to a blank frame, and that an unrecognised parameter
 * is ignored outright rather than treated as an error.
 */

const base64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64')

/** Narrowing helper — every assertion below knows which kind it expects. */
function inline(source: MediaSource | null): Uint8Array {
  if (!source || source.kind !== 'inline') throw new Error(`expected inline source, got ${source?.kind}`)
  return source.bytes
}

function url(source: MediaSource | null): string {
  if (!source || source.kind !== 'url') throw new Error(`expected url source, got ${source?.kind}`)
  return source.url
}

describe('decodeBase64', () => {
  it('decodes standard base64 with padding', () => {
    expect(Array.from(decodeBase64(base64([1, 2, 3, 4, 5])))).toEqual([1, 2, 3, 4, 5])
  })

  it('decodes without padding', () => {
    expect(Array.from(decodeBase64(base64([1, 2]).replace(/=+$/, '')))).toEqual([1, 2])
  })

  it('accepts the URL-safe alphabet', () => {
    const bytes = [0xfb, 0xff, 0xbf]
    const urlSafe = base64(bytes).replace(/\+/g, '-').replace(/\//g, '_')
    expect(Array.from(decodeBase64(urlSafe))).toEqual(bytes)
  })

  it('accepts a space where a query string turned a "+" into one', () => {
    // This is the case that bites anyone pasting plain base64 into a URL by
    // hand: URLSearchParams decodes "+" to " " before we ever see it.
    const bytes = [0xfb, 0xff]
    expect(base64(bytes)).toContain('+')
    expect(Array.from(decodeBase64(base64(bytes).replace('+', ' ')))).toEqual(bytes)
  })

  it('strips a data: URI prefix', () => {
    expect(Array.from(decodeBase64(`data:application/octet-stream;base64,${base64([9])}`))).toEqual([9])
  })

  it('ignores embedded newlines', () => {
    expect(Array.from(decodeBase64(`${base64([1, 2, 3])}\n`))).toEqual([1, 2, 3])
  })

  it('rejects a character outside the alphabet', () => {
    expect(() => decodeBase64('AAAA!')).toThrow(/invalid base64 character/)
  })

  it('rejects data after the padding', () => {
    expect(() => decodeBase64('AA==AA')).toThrow(/after base64 padding/)
  })
})

describe('parseEmbedParams — defaults', () => {
  it('boots a bundled-BIOS machine with nothing configured', () => {
    const params = parseEmbedParams('')
    expect(params).toMatchObject({
      rom: null,
      cart: null,
      program: null,
      cf: null,
      binaries: [],
      autostart: true,
      autotype: null,
      controls: 'minimal',
      frequency: 1_000_000,
      muted: true,
      persist: false,
      origins: null,
      warnings: [],
    })
    expect(params.cfSize).toBe(DEFAULT_EMBED_CF_SIZE)
  })

  it('accepts a leading question mark', () => {
    expect(parseEmbedParams('?controls=full').controls).toBe('full')
  })

  it('accepts a prebuilt URLSearchParams', () => {
    expect(parseEmbedParams(new URLSearchParams({ controls: 'none' })).controls).toBe('none')
  })

  it('ignores parameters it has never heard of, silently', () => {
    // A pinned emulator version has to survive a docs site that has moved on.
    const params = parseEmbedParams('theme=green&scanlines=1&autostart=0')
    expect(params.warnings).toEqual([])
    expect(params.autostart).toBe(false)
  })
})

describe('parseEmbedParams — media sources', () => {
  it.each(['rom', 'cart', 'cf'])('reads %s as a URL', (key) => {
    const params = parseEmbedParams(`${key}=https://example.test/thing.bin`)
    const source = params[key === 'cf' ? 'cf' : (key as 'rom' | 'cart')]
    expect(url(source)).toBe('https://example.test/thing.bin')
    expect(source?.label).toBe('thing.bin')
  })

  it('reads prg as a URL under the "program" key', () => {
    const params = parseEmbedParams('prg=games/hello.prg')
    expect(url(params.program)).toBe('games/hello.prg')
    expect(params.program?.label).toBe('hello.prg')
  })

  it.each([
    ['rom64', 'rom'],
    ['cart64', 'cart'],
    ['prg64', 'program'],
    ['cf64', 'cf'],
  ])('reads %s as inline bytes', (key, field) => {
    const params = parseEmbedParams(`${key}=${base64([0xa9, 0x01, 0x60])}`)
    const source = params[field as 'rom' | 'cart' | 'program' | 'cf']
    expect(Array.from(inline(source))).toEqual([0xa9, 0x01, 0x60])
    expect(source?.label).toMatch(/\(inline\)$/)
  })

  it('prefers the inline payload when both spellings are given, and says so', () => {
    const params = parseEmbedParams(`prg=https://example.test/a.prg&prg64=${base64([7])}`)
    expect(Array.from(inline(params.program))).toEqual([7])
    expect(params.warnings).toEqual(['prg and prg64 both given — using prg64.'])
  })

  it('ignores a malformed inline payload rather than failing the boot', () => {
    const params = parseEmbedParams('rom64=not!base64')
    expect(params.rom).toBeNull()
    expect(params.warnings[0]).toMatch(/^rom64: invalid base64 character/)
  })

  it('ignores an inline payload that decodes to nothing', () => {
    const params = parseEmbedParams('prg64=')
    expect(params.program).toBeNull()
    expect(params.warnings).toEqual(['prg64: decoded to no bytes — ignored.'])
  })

  it('ignores an empty URL', () => {
    const params = parseEmbedParams('cart=%20')
    expect(params.cart).toBeNull()
    expect(params.warnings).toEqual(['cart: empty — ignored.'])
  })

  it('labels a URL by its last path segment, query string excluded', () => {
    const params = parseEmbedParams('rom=https://example.test/roms/my%20bios.bin?v=3')
    expect(params.rom?.label).toBe('my bios.bin')
  })
})

describe('parseEmbedParams — binaries', () => {
  it('repeats, and takes the addresses the CLI takes', () => {
    const params = parseEmbedParams('bin=$C000=a.bin&bin=0x0900=b.bin&bin=2048=c.bin')
    expect(params.binaries.map((b) => b.address)).toEqual([0xc000, 0x0900, 2048])
    expect(params.binaries.map((b) => url(b.source))).toEqual(['a.bin', 'b.bin', 'c.bin'])
  })

  it('reads bin64 as inline bytes, splitting on the first "=" only', () => {
    // Base64 padding is made of "=", so anything but a first-match split would
    // truncate the payload.
    const payload = base64([1, 2])
    expect(payload).toContain('=')
    const params = parseEmbedParams(`bin64=$0900=${payload}`)
    expect(params.binaries).toHaveLength(1)
    expect(params.binaries[0]!.address).toBe(0x0900)
    expect(Array.from(inline(params.binaries[0]!.source))).toEqual([1, 2])
  })

  it('keeps bin and bin64 in URL order, because two of them can overlap', () => {
    const params = parseEmbedParams(`bin=$0900=a.bin&bin64=$0A00=${base64([5])}&bin=$0B00=c.bin`)
    expect(params.binaries.map((b) => b.address)).toEqual([0x0900, 0x0a00, 0x0b00])
  })

  it('drops a spec with no address separator', () => {
    const params = parseEmbedParams('bin=a.bin')
    expect(params.binaries).toEqual([])
    expect(params.warnings[0]).toMatch(/^bin: expected <address>=<url>/)
  })

  it.each(['$10000=a.bin', 'nonsense=a.bin', '=a.bin', '-1=a.bin'])(
    'drops the out-of-range or unparseable address in "%s"',
    (spec) => {
      const params = parseEmbedParams(`bin=${encodeURIComponent(spec)}`)
      expect(params.binaries).toEqual([])
      expect(params.warnings[0]).toMatch(/^bin: expected an address/)
    }
  )

  it('drops a bin64 whose payload is not base64', () => {
    const params = parseEmbedParams('bin64=$0900=zzz!')
    expect(params.binaries).toEqual([])
    expect(params.warnings[0]).toMatch(/^bin64: invalid base64 character/)
  })
})

describe('parseEmbedParams — flags', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on', ''])('reads "%s" as true', (value) => {
    expect(parseEmbedParams(`persist=${value}`).persist).toBe(true)
  })

  it.each(['0', 'false', 'no', 'off'])('reads "%s" as false', (value) => {
    expect(parseEmbedParams(`autostart=${value}`).autostart).toBe(false)
  })

  it('falls back to the default on a value it cannot read', () => {
    const params = parseEmbedParams('autostart=maybe')
    expect(params.autostart).toBe(true)
    expect(params.warnings).toEqual(['autostart: expected 1 or 0, got "maybe" — using 1.'])
  })

  it('starts muted unless told otherwise', () => {
    expect(parseEmbedParams('').muted).toBe(true)
    expect(parseEmbedParams('muted=0').muted).toBe(false)
  })
})

describe('parseEmbedParams — scalars', () => {
  it.each([
    ['1', 1_000_000],
    ['2', 2_000_000],
    ['2MHz', 2_000_000],
    ['2000000', 2_000_000],
  ])('reads freq=%s', (value, expected) => {
    expect(parseEmbedParams(`freq=${value}`).frequency).toBe(expected)
  })

  it('falls back to 1 MHz on an unreadable freq', () => {
    const params = parseEmbedParams('freq=4')
    expect(params.frequency).toBe(1_000_000)
    expect(params.warnings[0]).toMatch(/^freq: expected 1 or 2/)
  })

  it.each(['full', 'minimal', 'none'])('reads controls=%s', (value) => {
    expect(parseEmbedParams(`controls=${value}`).controls).toBe(value)
  })

  it('falls back to minimal controls on an unknown mode', () => {
    const params = parseEmbedParams('controls=compact')
    expect(params.controls).toBe('minimal')
    expect(params.warnings[0]).toMatch(/^controls: expected full, minimal or none/)
  })

  it('unescapes the control characters autotype is written with', () => {
    expect(parseEmbedParams('autotype=RUN%5Cr').autotype).toBe('RUN\r')
    expect(parseEmbedParams('autotype=A%5CnB%5CtC%5C%5CD').autotype).toBe('A\nB\tC\\D')
  })

  it('ignores an empty autotype', () => {
    const params = parseEmbedParams('autotype=')
    expect(params.autotype).toBeNull()
    expect(params.warnings).toEqual(['autotype: empty — ignored.'])
  })
})

describe('parseEmbedParams — CF sizing', () => {
  it('allocates one disk when nothing is being kept', () => {
    // Two embeds on one docs page must not be half a gigabyte of Uint8Array.
    expect(parseEmbedParams('').cfSize).toBe(DEFAULT_EMBED_CF_SIZE)
  })

  it('allocates the full card when persisting', () => {
    // Storage.loadData() resizes to whatever it is handed, so an embed that
    // saved a small card first would shrink the full app's card to match.
    expect(parseEmbedParams('persist=1').cfSize).toBe(PERSISTENT_CF_SIZE)
  })

  it('takes an explicit size in megabytes', () => {
    expect(parseEmbedParams('cfsize=8').cfSize).toBe(8 * 1024 * 1024)
  })

  it.each(['0', '512', '2.5', 'big'])('rejects cfsize=%s and keeps the default', (value) => {
    const params = parseEmbedParams(`cfsize=${value}`)
    expect(params.cfSize).toBe(DEFAULT_EMBED_CF_SIZE)
    expect(params.warnings[0]).toMatch(/^cfsize: expected 1-256/)
  })
})

describe('parseEmbedParams — origins', () => {
  it('accepts any origin when unset — the zero-configuration case', () => {
    expect(parseEmbedParams('').origins).toBeNull()
  })

  it('reads a comma-separated allow-list', () => {
    expect(parseEmbedParams('origins=https://a.test,%20https://b.test').origins).toEqual([
      'https://a.test',
      'https://b.test',
    ])
  })

  it('treats "*" and an empty list as "any"', () => {
    expect(parseEmbedParams('origins=*').origins).toBeNull()
    expect(parseEmbedParams('origins=').origins).toBeNull()
  })
})
