import { HID_NAMES, ASCII_TO_KEY, resolveKeyCode } from '../../debug/KeyCodes'

describe('HID_NAMES', () => {
  it('matches the known USB HID usage IDs', () => {
    expect(HID_NAMES.KeyA).toBe(0x04)
    expect(HID_NAMES.Enter).toBe(0x28)
    expect(HID_NAMES.ShiftLeft).toBe(0xe1)
  })
})

describe('resolveKeyCode', () => {
  it('passes a numeric code through unchanged', () => {
    expect(resolveKeyCode(0x04)).toBe(0x04)
  })

  it('resolves a name to its code', () => {
    expect(resolveKeyCode('KeyA')).toBe(0x04)
    expect(resolveKeyCode('Enter')).toBe(0x28)
  })

  it('reports nothing for an unknown name', () => {
    expect(resolveKeyCode('NotAKey')).toBeUndefined()
  })
})

describe('ASCII_TO_KEY', () => {
  it('maps lowercase letters unshifted and uppercase shifted', () => {
    expect(ASCII_TO_KEY.a).toEqual({ code: HID_NAMES.KeyA })
    expect(ASCII_TO_KEY.A).toEqual({ code: HID_NAMES.KeyA, shift: true })
  })

  it('maps digits unshifted and their US-layout shifted symbols', () => {
    expect(ASCII_TO_KEY['1']).toEqual({ code: HID_NAMES.Digit1 })
    expect(ASCII_TO_KEY['!']).toEqual({ code: HID_NAMES.Digit1, shift: true })
    expect(ASCII_TO_KEY['0']).toEqual({ code: HID_NAMES.Digit0 })
    expect(ASCII_TO_KEY[')']).toEqual({ code: HID_NAMES.Digit0, shift: true })
  })

  it('maps punctuation both plain and shifted', () => {
    expect(ASCII_TO_KEY[',']).toEqual({ code: HID_NAMES.Comma })
    expect(ASCII_TO_KEY['<']).toEqual({ code: HID_NAMES.Comma, shift: true })
    expect(ASCII_TO_KEY['/']).toEqual({ code: HID_NAMES.Slash })
    expect(ASCII_TO_KEY['?']).toEqual({ code: HID_NAMES.Slash, shift: true })
  })

  it('maps whitespace and control characters used in BASIC input', () => {
    expect(ASCII_TO_KEY[' ']).toEqual({ code: HID_NAMES.Space })
    expect(ASCII_TO_KEY['\r']).toEqual({ code: HID_NAMES.Enter })
    expect(ASCII_TO_KEY['\n']).toEqual({ code: HID_NAMES.Enter })
    expect(ASCII_TO_KEY['\t']).toEqual({ code: HID_NAMES.Tab })
  })

  it('has no entry for a character outside a US keyboard', () => {
    expect(ASCII_TO_KEY['€']).toBeUndefined()
    expect(ASCII_TO_KEY['字']).toBeUndefined()
  })
})
