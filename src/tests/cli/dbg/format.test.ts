import {
  formatBreakpoint,
  formatBreakpoints,
  formatDisasm,
  formatFlags,
  formatRegisters,
  formatStop,
  formatSymbols,
  hexByte,
  hexWord,
  hexDump
} from '../../../cli/dbg/format'

describe('hexByte / hexWord', () => {
  it('pads and uppercases', () => {
    expect(hexByte(0x0a)).toBe('$0A')
    expect(hexWord(0xc0)).toBe('$00C0')
  })
})

describe('formatFlags', () => {
  // The classic monitor rendering: uppercase where set, lowercase where clear,
  // in the wire order NV-BDIZC.
  it('uppercases set flags and lowercases clear ones, in order', () => {
    expect(
      formatFlags({ N: true, V: false, B: false, D: false, I: true, Z: false, C: true })
    ).toBe('NvbdIzC')
  })
})

describe('formatRegisters', () => {
  it('renders every register and the flag string', () => {
    const text = formatRegisters({
      A: 0x42,
      X: 0x10,
      Y: 0x00,
      PC: 0xc000,
      SP: 0xfd,
      P: 0x20,
      flags: { N: false, V: false, B: false, D: false, I: false, Z: false, C: false }
    })
    expect(text).toContain('A=$42')
    expect(text).toContain('PC=$C000')
    expect(text).toContain('[nvbdizc]')
  })
})

describe('formatBreakpoint(s)', () => {
  const bp = {
    id: 1,
    kind: 'exec',
    address: 0xc000,
    end: 0xc000,
    ignoreCount: 0,
    temporary: false,
    enabled: true,
    hits: 3
  }

  it('shows a single address, hits and id', () => {
    const text = formatBreakpoint(bp)
    expect(text).toContain('#1')
    expect(text).toContain('$C000')
    expect(text).toContain('hits=3')
    expect(text).not.toContain('-')
  })

  it('shows a range when end differs from address', () => {
    expect(formatBreakpoint({ ...bp, kind: 'write', end: 0xc0ff })).toContain('$C000-$C0FF')
  })

  it('mentions a condition, disabled state and temporary flag', () => {
    const text = formatBreakpoint({ ...bp, condition: 'A == 3', enabled: false, temporary: true })
    expect(text).toContain('if A == 3')
    expect(text).toContain('disabled')
    expect(text).toContain('temporary')
  })

  it('prints something readable for an empty list', () => {
    expect(formatBreakpoints([])).toBe('(no breakpoints)')
  })
})

describe('formatStop', () => {
  it.each([
    [{ kind: 'breakpoint', id: 2, address: 0xc010 }, /breakpoint #2 at \$C010/],
    [{ kind: 'watchpoint', id: 3, address: 0x0400, access: 'write' }, /watchpoint #3 \(write\)/],
    [{ kind: 'cycle-budget', cycles: 1000 }, /ran 1000 cycles/],
    [{ kind: 'trap', detail: 'stack desynchronised' }, /trap: stack desynchronised/],
    [{ kind: 'paused' }, /paused/]
  ])('renders %o', (stop, pattern) => {
    expect(formatStop(stop)).toMatch(pattern)
  })
})

describe('hexDump', () => {
  it('lays out 16 bytes per line with a matching ASCII gutter', () => {
    const bytes = Uint8Array.from([...'Hello, World!!!!'].map((c) => c.charCodeAt(0)))
    const text = hexDump(0x0300, bytes)
    expect(text).toMatch(/^0300\s+48 65 6C/)
    expect(text).toContain('Hello, World!!!!')
  })

  it('handles a non-printable byte with a dot', () => {
    expect(hexDump(0, Uint8Array.of(0x00, 0x41))).toContain('.A')
  })

  it('wraps onto a new line past 16 bytes', () => {
    const text = hexDump(0, new Uint8Array(20))
    expect(text.split('\n')).toHaveLength(2)
  })
})

describe('formatDisasm', () => {
  it('marks the instruction at the PC', () => {
    const instructions = [
      { address: 0xc000, bytes: [0xea], text: 'C000  EA        NOP' },
      { address: 0xc001, bytes: [0xea], text: 'C001  EA        NOP' }
    ]
    const text = formatDisasm(instructions, 0xc001)
    const lines = text.split('\n')
    expect(lines[0]!.startsWith(' ')).toBe(true)
    expect(lines[1]!.startsWith('>')).toBe(true)
  })
})

describe('formatSymbols', () => {
  it('lists name, address and source', () => {
    const text = formatSymbols([{ name: 'main', address: 0xc000, source: 'game.lbl' }])
    expect(text).toContain('$C000')
    expect(text).toContain('main')
    expect(text).toContain('game.lbl')
  })

  it('prints something readable for an empty list', () => {
    expect(formatSymbols([])).toBe('(no symbols)')
  })
})
