import { useEmulatorStore } from '@/stores/emulator'

// USB HID scancodes shared with useKeyboard's CODE_TO_HID map.
const HID_SHIFT = 0xe1
const HID_ENTER = 0x28

/**
 * Map a printable ASCII character to the USB HID scancode (and whether Shift is
 * held) that produces it on a US keyboard layout. Newlines map to Enter; tabs
 * and spaces map to their scancodes. Returns null for characters we can't type.
 */
function charToKey(ch: string): { hid: number; shift: boolean } | null {
  // Letters
  if (ch >= 'a' && ch <= 'z') return { hid: 0x04 + (ch.charCodeAt(0) - 97), shift: false }
  if (ch >= 'A' && ch <= 'Z') return { hid: 0x04 + (ch.charCodeAt(0) - 65), shift: true }

  // Digits (unshifted)
  if (ch >= '1' && ch <= '9') return { hid: 0x1e + (ch.charCodeAt(0) - 49), shift: false }
  if (ch === '0') return { hid: 0x27, shift: false }

  // Shifted digit symbols (US layout)
  const shiftedDigits: Record<string, number> = {
    '!': 0x1e, '@': 0x1f, '#': 0x20, '$': 0x21, '%': 0x22,
    '^': 0x23, '&': 0x24, '*': 0x25, '(': 0x26, ')': 0x27,
  }
  if (ch in shiftedDigits) return { hid: shiftedDigits[ch]!, shift: true }

  // Whitespace / control
  if (ch === '\n' || ch === '\r') return { hid: HID_ENTER, shift: false }
  if (ch === '\t') return { hid: 0x2b, shift: false }
  if (ch === ' ') return { hid: 0x2c, shift: false }

  // Punctuation: [hid, unshiftedChar, shiftedChar]
  const punctuation: Array<[number, string, string]> = [
    [0x2d, '-', '_'], [0x2e, '=', '+'], [0x2f, '[', '{'], [0x30, ']', '}'],
    [0x31, '\\', '|'], [0x33, ';', ':'], [0x34, '\'', '"'], [0x35, '`', '~'],
    [0x36, ',', '<'], [0x37, '.', '>'], [0x38, '/', '?'],
  ]
  for (const [hid, lower, upper] of punctuation) {
    if (ch === lower) return { hid, shift: false }
    if (ch === upper) return { hid, shift: true }
  }

  return null
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Key press/release durations. Long enough for the BIOS keyboard scan to
// register each transition without dropping characters.
const KEY_DOWN_MS = 20
const KEY_UP_MS = 20

export function usePaste() {
  const store = useEmulatorStore()

  let cancelled = false

  /**
   * Type `text` into the running machine as a sequence of emulated key presses.
   * Resolves once the whole string has been sent (or cancel() is called).
   */
  async function injectText(text: string): Promise<void> {
    const machine = store.machine
    if (!machine || !store.isRunning) return
    cancelled = false

    for (const ch of text) {
      if (cancelled) break
      const key = charToKey(ch)
      if (!key) continue

      if (key.shift) machine.onKeyDown(HID_SHIFT)
      machine.onKeyDown(key.hid)
      await sleep(KEY_DOWN_MS)

      machine.onKeyUp(key.hid)
      if (key.shift) machine.onKeyUp(HID_SHIFT)
      await sleep(KEY_UP_MS)
    }
  }

  function cancel() {
    cancelled = true
  }

  return { injectText, cancel }
}
