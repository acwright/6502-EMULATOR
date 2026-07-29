/**
 * USB HID usage IDs for the keys `Machine.onKeyDown`/`onKeyUp` accept.
 *
 * The canonical copy — `useKeyboard.ts` in the renderer maps a browser
 * `KeyboardEvent.code` to the same values, and imports this table rather than
 * keeping its own, so a debugger's `input.key` and a person's real keyboard
 * agree on what every key means.
 */
export const HID_NAMES: Readonly<Record<string, number>> = {
  KeyA: 0x04, KeyB: 0x05, KeyC: 0x06, KeyD: 0x07,
  KeyE: 0x08, KeyF: 0x09, KeyG: 0x0a, KeyH: 0x0b,
  KeyI: 0x0c, KeyJ: 0x0d, KeyK: 0x0e, KeyL: 0x0f,
  KeyM: 0x10, KeyN: 0x11, KeyO: 0x12, KeyP: 0x13,
  KeyQ: 0x14, KeyR: 0x15, KeyS: 0x16, KeyT: 0x17,
  KeyU: 0x18, KeyV: 0x19, KeyW: 0x1a, KeyX: 0x1b,
  KeyY: 0x1c, KeyZ: 0x1d,

  Digit1: 0x1e, Digit2: 0x1f, Digit3: 0x20, Digit4: 0x21,
  Digit5: 0x22, Digit6: 0x23, Digit7: 0x24, Digit8: 0x25,
  Digit9: 0x26, Digit0: 0x27,

  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b,
  Space: 0x2c,

  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30,
  Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
  Comma: 0x36, Period: 0x37, Slash: 0x38,

  CapsLock: 0x39,
  F1: 0x3a, F2: 0x3b, F3: 0x3c, F4: 0x3d, F5: 0x3e, F6: 0x3f,
  F7: 0x40, F8: 0x41, F9: 0x42, F10: 0x43, F11: 0x44, F12: 0x45,

  PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48,
  Insert: 0x49, Home: 0x4a, PageUp: 0x4b,
  Delete: 0x4c, End: 0x4d, PageDown: 0x4e,

  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,

  ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
  ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7
}

/** One character's worth of keystroke, for typing plain text. */
export interface KeyPress {
  code: number
  shift?: boolean
}

/**
 * ASCII → keystroke, standard US QWERTY.
 *
 * What `input.type` drives: which key, and whether Shift needs to be held.
 * Shift itself is not special-cased in emulated hardware — the keyboard
 * matrix reports raw make/break codes and the BIOS's own scan routine
 * decides what "Shift held" plus a key means, exactly as real hardware would.
 * A caller wanting a character outside this table (anything not on a US
 * keyboard) gets a clear error naming it rather than a silently wrong key.
 */
export const ASCII_TO_KEY: Readonly<Record<string, KeyPress>> = (() => {
  const table: Record<string, KeyPress> = {}
  const letter = (ch: string, code: number): void => {
    table[ch.toLowerCase()] = { code }
    table[ch.toUpperCase()] = { code, shift: true }
  }
  for (let i = 0; i < 26; i++) letter(String.fromCharCode(0x61 + i), HID_NAMES[`Key${String.fromCharCode(0x41 + i)}`]!)

  const digitCodes = [
    HID_NAMES.Digit1!, HID_NAMES.Digit2!, HID_NAMES.Digit3!, HID_NAMES.Digit4!,
    HID_NAMES.Digit5!, HID_NAMES.Digit6!, HID_NAMES.Digit7!, HID_NAMES.Digit8!,
    HID_NAMES.Digit9!, HID_NAMES.Digit0!
  ]
  const shiftedDigits = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')']
  digitCodes.forEach((code, i) => {
    table[String((i + 1) % 10)] = { code }
    table[shiftedDigits[i]!] = { code, shift: true }
  })

  const punctuation: [string, string, number][] = [
    ['-', '_', HID_NAMES.Minus!],
    ['=', '+', HID_NAMES.Equal!],
    ['[', '{', HID_NAMES.BracketLeft!],
    [']', '}', HID_NAMES.BracketRight!],
    ['\\', '|', HID_NAMES.Backslash!],
    [';', ':', HID_NAMES.Semicolon!],
    ["'", '"', HID_NAMES.Quote!],
    ['`', '~', HID_NAMES.Backquote!],
    [',', '<', HID_NAMES.Comma!],
    ['.', '>', HID_NAMES.Period!],
    ['/', '?', HID_NAMES.Slash!]
  ]
  for (const [plain, shifted, code] of punctuation) {
    table[plain] = { code }
    table[shifted] = { code, shift: true }
  }

  table[' '] = { code: HID_NAMES.Space! }
  table['\r'] = { code: HID_NAMES.Enter! }
  table['\n'] = { code: HID_NAMES.Enter! }
  table['\t'] = { code: HID_NAMES.Tab! }
  table['\b'] = { code: HID_NAMES.Backspace! }
  table['\x1b'] = { code: HID_NAMES.Escape! }

  return table
})()

/** A key argument as either a raw HID code or a name from HID_NAMES. */
export function resolveKeyCode(value: number | string): number | undefined {
  if (typeof value === 'number') return value
  return HID_NAMES[value]
}
