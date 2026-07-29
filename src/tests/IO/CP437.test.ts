import { CP437 } from '../../core/IO/CP437'

describe('CP437', () => {
  it('has exactly 256 entries, one per byte value', () => {
    expect(CP437).toHaveLength(256)
  })

  // $20-$7E coincides with ASCII — the range a BASIC program's own PRINT
  // output actually uses — which is the part screen.text has to get right.
  it('matches ASCII for the printable range', () => {
    expect(CP437[0x20]).toBe(' ')
    expect(CP437[0x41]).toBe('A')
    expect(CP437[0x61]).toBe('a')
    expect(CP437[0x30]).toBe('0')
    expect(CP437[0x7e]).toBe('~')
  })

  it('every entry is exactly one character', () => {
    for (const entry of CP437) expect([...entry]).toHaveLength(1)
  })
})
