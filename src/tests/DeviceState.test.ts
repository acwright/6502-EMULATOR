import {
  StateError,
  expectKind,
  fromBase64,
  readBoolean,
  readByteList,
  readBytes,
  readNumber,
  readState,
  readStates,
  readString,
  toBase64
} from '../core/DeviceState'
import type { DeviceState } from '../core/DeviceState'

/**
 * A snapshot is untrusted input — a truncated file, a hand-edited field, a
 * format written by a build this one has never seen. Every one of these readers
 * exists to refuse rather than default, because a device that quietly took
 * `undefined` for a register would leave the machine in a state no real board
 * can be in, and that is far harder to diagnose than a refusal.
 *
 * So these tests are mostly about the failures. The happy paths are covered
 * many times over by Snapshot.test.ts round-tripping real cards.
 */
const state = (fields: Record<string, unknown>): DeviceState => ({ kind: 'test', ...fields })

describe('base64', () => {
  it('round-trips a Uint8Array and a plain array alike', () => {
    expect([...fromBase64(toBase64(Uint8Array.of(1, 2, 3)), 'x')]).toEqual([1, 2, 3])
    expect([...fromBase64(toBase64([4, 5, 6]), 'x')]).toEqual([4, 5, 6])
  })

  it('refuses a corrupted field instead of decoding a shorter array', () => {
    // Buffer.from ignores what it cannot decode, so without the re-encode check
    // a mangled field would silently restore fewer bytes than it should.
    expect(() => fromBase64('not valid base64!!', 'ram.data')).toThrow(
      /ram\.data: not valid base64/
    )
  })
})

describe('readers', () => {
  it('names the device and the field it is complaining about', () => {
    expect(() => readNumber(state({}), 'lba0')).toThrow(/^test\.lba0:/)
  })

  it('refuses a missing or non-numeric number, including NaN', () => {
    expect(() => readNumber(state({}), 'a')).toThrow(StateError)
    expect(() => readNumber(state({ a: '5' }), 'a')).toThrow(/expected a number/)
    expect(() => readNumber(state({ a: null }), 'a')).toThrow(/expected a number/)
    expect(() => readNumber(state({ a: Number.NaN }), 'a')).toThrow(/expected a number/)
    expect(() => readNumber(state({ a: Infinity }), 'a')).toThrow(/expected a number/)
    expect(readNumber(state({ a: 0 }), 'a')).toBe(0)
  })

  it('refuses a truthy value where a boolean belongs', () => {
    expect(() => readBoolean(state({ f: 1 }), 'f')).toThrow(/expected true or false/)
    expect(() => readBoolean(state({}), 'f')).toThrow(/expected true or false/)
    expect(readBoolean(state({ f: false }), 'f')).toBe(false)
  })

  it('refuses a non-string', () => {
    expect(() => readString(state({ s: 7 }), 's')).toThrow(/expected a string/)
    expect(readString(state({ s: '' }), 's')).toBe('')
  })

  it('checks a byte array is exactly the length the device expects', () => {
    const short = state({ vram: toBase64([1, 2]) })
    expect(() => readBytes(short, 'vram', 4)).toThrow(/expected 4 bytes, got 2/)
    expect(readBytes(short, 'vram', 2)).toEqual(Uint8Array.of(1, 2))
    expect(readBytes(short, 'vram')).toHaveLength(2)
  })

  it('checks every entry of a byte list', () => {
    expect(readByteList(state({ q: [1, 255] }), 'q')).toEqual([1, 255])
    expect(() => readByteList(state({ q: 'nope' }), 'q')).toThrow(/expected an array of bytes/)
    expect(() => readByteList(state({ q: [1, 256] }), 'q')).toThrow(/q\[1\]: expected a byte/)
    expect(() => readByteList(state({ q: [1, -1] }), 'q')).toThrow(/q\[1\]/)
    expect(() => readByteList(state({ q: [1.5] }), 'q')).toThrow(/q\[0\]/)
  })

  it('requires a nested state to be an object carrying a kind', () => {
    expect(readState(state({ v: { kind: 'sidvoice' } }), 'v').kind).toBe('sidvoice')
    expect(() => readState(state({ v: null }), 'v')).toThrow(/expected a nested state object/)
    expect(() => readState(state({ v: [] }), 'v')).toThrow(/expected a nested state object/)
    expect(() => readState(state({ v: { a: 1 } }), 'v')).toThrow(/no "kind"/)
  })

  it('requires an exact count of nested states when one is given', () => {
    const voices = state({ voices: [{ kind: 'v' }, { kind: 'v' }] })
    expect(readStates(voices, 'voices')).toHaveLength(2)
    expect(() => readStates(voices, 'voices', 3)).toThrow(/expected 3 entries, got 2/)
    expect(() => readStates(state({ voices: {} }), 'voices')).toThrow(
      /expected an array of nested states/
    )
    expect(() => readStates(state({ voices: [1] }), 'voices')).toThrow(/voices\[0\]/)
  })
})

describe('expectKind', () => {
  it('accepts its own kind and refuses another device entirely', () => {
    expect(() => expectKind(state({}), 'test')).not.toThrow()
    expect(() => expectKind({ kind: 'video' }, 'sound')).toThrow(
      /expected sound state here, got "video"/
    )
  })

  it('says what the real cause usually is', () => {
    expect(() => expectKind({ kind: 'video' }, 'empty')).toThrow(/different configuration/)
  })
})
