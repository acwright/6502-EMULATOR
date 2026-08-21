import { KeyboardEncoderAttachment } from '../../core/IO/Attachments/KeyboardEncoderAttachment'
import { HID_NAMES } from '../../debug/KeyCodes'
import { KEY_CAPS } from '../../renderer/src/keyboard/layout'
import type { KeyCap } from '../../renderer/src/keyboard/layout'

/**
 * The on-screen keyboard against the machine's own keyboard controller.
 *
 * `KeyboardLayout.test.ts` checks the table against itself — that the caps tile
 * the board and that the bytes are bytes. This checks it against something that
 * did not come from it: `KeyboardEncoderAttachment` is the emulator's model of
 * the AB Controller and was written years before this layout, from the same
 * hardware. Press a cap's HID code into the encoder and the ASCII that comes out
 * of the port has to be the byte `docs/reference/keyboard-matrix.md` says that
 * switch sends.
 *
 * That is the whole chain the on-screen keyboard relies on: the component sends
 * `hid`, the encoder turns it into ASCII, and the `code` column is what this
 * repo claims will happen. If any one of the three is a transcription away from
 * the other two, this is where it shows up rather than under someone's thumb.
 *
 * 6502-KIMULATOR has no keyboard controller to check against — it puts `code`
 * on the wire directly — so this test is this repo's alone. Its copy of
 * `KeyboardLayout.test.ts` is the shared one.
 */

/** A fresh encoder with a port enabled, matching the attachment's own tests. */
function encoder(): KeyboardEncoderAttachment {
  const built = new KeyboardEncoderAttachment(5)
  built.activePort = 'both'
  built.updateControlLines(false, false, false, false)
  return built
}

/** Press a cap with the given modifiers held, and read the byte it produced. */
function press(cap: KeyCap, modifiers: { shift?: boolean; ctrl?: boolean } = {}): number {
  const keyboard = encoder()
  if (modifiers.shift) keyboard.updateKey(HID_NAMES.ShiftLeft!, true)
  if (modifiers.ctrl) keyboard.updateKey(HID_NAMES.ControlLeft!, true)
  keyboard.updateKey(cap.hid!, true)
  return keyboard.readPortA(0xff, 0x00)
}

const sending = KEY_CAPS.filter((cap) => cap.code !== null && cap.hid !== null)

describe('the on-screen keyboard against the encoder', () => {
  it('has a HID code for every cap that sends something', () => {
    // Fn is the only cap without one, and it sends nothing — no keyboard has an
    // Fn code, the host is told F1…F10 and infers it.
    const missing = KEY_CAPS.filter((cap) => cap.hid === null)
    expect(missing.map((cap) => cap.legend)).toEqual(['Fn'])
  })

  it('names its HID codes the same way the debugger does', () => {
    // Two tables in this repo, one USB spec. `HID_NAMES` is what `input.key`
    // resolves against, so a cap that disagreed with it would type one thing
    // under a finger and another under a debugger script.
    const byName = (name: string): number => HID_NAMES[name]!
    const expected: Array<[string, string]> = [
      ['Q', 'KeyQ'], ['A', 'KeyA'], ['Z', 'KeyZ'],
      ['1', 'Digit1'], ['0', 'Digit0'],
      ['Enter', 'Enter'], ['Esc', 'Escape'], ['Tab', 'Tab'],
      ['Backspace', 'Backspace'], ['Ins', 'Insert'], ['Del', 'Delete'],
      ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['←', 'ArrowLeft'], ['→', 'ArrowRight'],
      ['`', 'Backquote'], ['-', 'Minus'], ['=', 'Equal'],
      ['[', 'BracketLeft'], [']', 'BracketRight'], ['\\', 'Backslash'],
      [';', 'Semicolon'], ["'", 'Quote'], [',', 'Comma'], ['.', 'Period'], ['/', 'Slash'],
      ['Caps Lock', 'CapsLock']
    ]
    for (const [legend, name] of expected) {
      const cap = KEY_CAPS.find((c) => c.legend === legend)!
      expect([legend, cap.hid]).toEqual([legend, byName(name)])
    }
  })

  it('produces the reference byte for every cap that sends one', () => {
    for (const cap of sending) {
      expect([cap.legend, press(cap)]).toEqual([cap.legend, cap.code])
    }
  })

  it('produces the upper legend for every cap that has one, with Shift held', () => {
    const shifted = sending.filter((cap) => cap.shifted)
    // Every cap with two legends: the number row, and the punctuation.
    expect(shifted).toHaveLength(21)

    for (const cap of shifted) {
      expect([cap.legend, press(cap, { shift: true })]).toEqual([
        cap.legend,
        cap.shifted!.charCodeAt(0)
      ])
    }
  })

  it('leaves letters in capitals whether Shift is held or not', () => {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const cap = KEY_CAPS.find((c) => c.legend === letter)!
      expect(press(cap)).toBe(letter.charCodeAt(0))
      expect(press(cap, { shift: true })).toBe(letter.charCodeAt(0))
    }
  })

  it('sends control codes for Ctrl and a letter', () => {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const cap = KEY_CAPS.find((c) => c.legend === letter)!
      expect(press(cap, { ctrl: true })).toBe(letter.charCodeAt(0) - 0x40)
    }
  })

  it('types PRINT 2+2 the way the on-screen keyboard would', () => {
    // The whole point, end to end: the caps a finger would land on, in order,
    // with Shift held across the one that needs it, coming out as the line
    // BASIC would receive.
    const keyboard = encoder()
    const cap = (legend: string): KeyCap => KEY_CAPS.find((c) => c.legend === legend)!

    let typed = ''
    const tap = (legend: string, shift = false): void => {
      if (shift) keyboard.updateKey(HID_NAMES.ShiftLeft!, true)
      keyboard.updateKey(cap(legend).hid!, true)
      typed += String.fromCharCode(keyboard.readPortA(0xff, 0x00))
      keyboard.updateKey(cap(legend).hid!, false)
      if (shift) keyboard.updateKey(HID_NAMES.ShiftLeft!, false)
    }

    for (const legend of ['P', 'R', 'I', 'N', 'T']) tap(legend)
    keyboard.updateKey(cap('').hid!, true) // the space bar has no legend
    typed += String.fromCharCode(keyboard.readPortA(0xff, 0x00))
    keyboard.updateKey(cap('').hid!, false)
    tap('2')
    tap('=', true) // Shift and `=` is `+`
    tap('2')

    expect(typed).toBe('PRINT 2+2')
  })
})
