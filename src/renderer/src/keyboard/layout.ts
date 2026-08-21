/**
 * The board's own 67-key keyboard, as an on-screen one.
 *
 * Two sources, and neither is derived from the other:
 *
 *   • `assets/keyboard/keyboard-layout.json` in 6502-DOCS — the board's KLE
 *     layout. Every position, width, legend and keycap colour below is that
 *     file, converted from KLE's cursor-and-offset form to absolute `x`.
 *   • `docs/reference/keyboard-matrix.md` — what the AB Controller sends when a
 *     switch closes.
 *
 * The byte a cap sends is not guessable from what is printed on it, which is
 * why both are written down here. `Q` sends $51 and never $71 — the ACE types
 * in capitals, and Shift changes the number row and the symbols and nothing
 * else. `Ins` sends $1A and `Del` sends $7F. The arrows send $1C–$1F. And four
 * caps — Caps Lock, Menu, Alt, Fn — are scanned like every other switch and
 * then dropped: no character, no state.
 *
 * One description, two machines:
 *
 *   • 6502-EMULATOR hands `hid` to `Machine.onKeyDown`, and the keyboard
 *     attachments work out the matrix position and the ASCII exactly as the
 *     controller does. Shift and Ctrl go down and up around the key like real
 *     modifiers rather than being resolved here.
 *   • 6502-KIMULATOR has no such keyboard on the board. It puts `code` on the
 *     wire, which is what this keyboard wired to its serial port would send.
 */

/** The board is 16.5 keycaps wide and 5 tall. Everything below is in those units. */
export const BOARD_WIDTH = 16.5
export const BOARD_HEIGHT = 5

/** Held rather than sent. Fn is the odd one — see `FUNCTION_ROW`. */
export type Modifier = 'shift' | 'ctrl' | 'alt' | 'fn'

export interface KeyCap {
  /** Row, 0 at the top. */
  row: number
  /** Left edge, in keycap units. */
  x: number
  /** Width, in keycap units. */
  w: number
  /** The lower legend — what the cap sends on its own. */
  legend: string
  /** The upper legend, on the caps that have one. What Shift sends instead. */
  shifted?: string
  /** USB HID usage ID, for a machine that wants a keyboard rather than a wire. */
  hid: number | null
  /** The byte the controller puts on the wire. Null for the four it drops. */
  code: number | null
  /** Latches on this board instead of sending, for as long as the next key. */
  modifier?: Modifier
  /** The dark keycaps: Esc, Enter, Space and the arrows. */
  dark?: boolean
  /** A word or an arrow rather than a character, so it is set smaller. */
  wide?: boolean
}

// USB HID usage IDs. The same numbers as `HID_NAMES` in `src/debug/KeyCodes.ts`,
// written out here because this table is the keyboard and that one is the map.
const A = 0x04 // KeyA; letters run in alphabet order from here
const DIGIT = [0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27] // 1…9, 0

/** A row builder that walks left to right, so only widths have to be written. */
function row(index: number, start: number) {
  let x = start
  const caps: KeyCap[] = []
  return {
    /** One cap, `w` units wide, advancing the cursor past it. */
    add(cap: Omit<KeyCap, 'row' | 'x' | 'w'> & { w?: number }): void {
      const w = cap.w ?? 1
      caps.push({ ...cap, row: index, x, w })
      x += w
    },
    /** A gap, for the channel between the main block and the right-hand column. */
    gap(units: number): void {
      x += units
    },
    caps
  }
}

/** The number row, and Backspace and Esc. */
function digitRow(): KeyCap[] {
  const r = row(0, 0)
  r.add({ legend: '`', shifted: '~', hid: 0x35, code: 0x60 })
  for (let i = 0; i < 10; i++) {
    const digit = String((i + 1) % 10)
    r.add({
      legend: digit,
      shifted: ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'][i],
      hid: DIGIT[i]!,
      code: digit.charCodeAt(0)
    })
  }
  r.add({ legend: '-', shifted: '_', hid: 0x2d, code: 0x2d })
  r.add({ legend: '=', shifted: '+', hid: 0x2e, code: 0x3d })
  r.add({ legend: 'Backspace', hid: 0x2a, code: 0x08, w: 2, wide: true })
  r.gap(0.5)
  r.add({ legend: 'Esc', hid: 0x29, code: 0x1b, dark: true, wide: true })
  return r.caps
}

/** Tab, QWERTY, and Insert. */
function topRow(): KeyCap[] {
  const r = row(1, 0)
  r.add({ legend: 'Tab', hid: 0x2b, code: 0x09, w: 1.5, wide: true })
  for (const letter of 'QWERTYUIOP') r.add(letterCap(letter))
  r.add({ legend: '[', shifted: '{', hid: 0x2f, code: 0x5b })
  r.add({ legend: ']', shifted: '}', hid: 0x30, code: 0x5d })
  r.add({ legend: '\\', shifted: '|', hid: 0x31, code: 0x5c, w: 1.5 })
  r.gap(0.5)
  r.add({ legend: 'Ins', hid: 0x49, code: 0x1a, wide: true })
  return r.caps
}

/** Caps Lock, the home row, Enter, and Delete. */
function homeRow(): KeyCap[] {
  const r = row(2, 0)
  // A real switch in the grid, and the controller drops it: there is no lower
  // case at the machine, so there is no case for it to lock.
  r.add({ legend: 'Caps Lock', hid: 0x39, code: null, w: 1.75, wide: true })
  for (const letter of 'ASDFGHJKL') r.add(letterCap(letter))
  r.add({ legend: ';', shifted: ':', hid: 0x33, code: 0x3b })
  r.add({ legend: "'", shifted: '"', hid: 0x34, code: 0x27 })
  r.add({ legend: 'Enter', hid: 0x28, code: 0x0d, w: 2.25, dark: true, wide: true })
  r.gap(0.5)
  r.add({ legend: 'Del', hid: 0x4c, code: 0x7f, wide: true })
  return r.caps
}

/** The shift row, and the top of the inverted T. */
function shiftRow(): KeyCap[] {
  const r = row(3, 0)
  r.add({ legend: 'Shift', hid: 0xe1, code: null, w: 2.25, modifier: 'shift', wide: true })
  for (const letter of 'ZXCVBNM') r.add(letterCap(letter))
  r.add({ legend: ',', shifted: '<', hid: 0x36, code: 0x2c })
  r.add({ legend: '.', shifted: '>', hid: 0x37, code: 0x2e })
  r.add({ legend: '/', shifted: '?', hid: 0x38, code: 0x2f })
  r.add({ legend: 'Shift', hid: 0xe1, code: null, w: 2.25, modifier: 'shift', wide: true })
  r.add({ legend: '↑', hid: 0x52, code: 0x1e, dark: true, wide: true })
  return r.caps
}

/** The modifiers, the space bar, and the rest of the inverted T. */
function bottomRow(): KeyCap[] {
  const r = row(4, 0)
  r.add({ legend: 'Ctrl', hid: 0xe0, code: null, w: 1.25, modifier: 'ctrl', wide: true })
  // Menu is the fourth cap the controller drops. It is still a switch, so it
  // goes down and comes back up; nothing listens.
  r.add({ legend: 'Menu', hid: 0xe3, code: null, wide: true })
  r.add({ legend: 'Alt', hid: 0xe2, code: null, w: 1.25, modifier: 'alt', wide: true })
  r.add({ legend: '', hid: 0x2c, code: 0x20, w: 6.25, dark: true })
  r.add({ legend: 'Alt', hid: 0xe2, code: null, w: 1.25, modifier: 'alt', wide: true })
  // No HID usage ID exists for Fn, because no keyboard sends one — the host sees
  // F1…F10 and infers it. `FUNCTION_ROW` below is the same inference, run the
  // other way, which is exactly what KeyboardMatrixAttachment expects.
  r.add({ legend: 'Fn', hid: null, code: null, w: 1.25, modifier: 'fn', wide: true })
  r.add({ legend: 'Ctrl', hid: 0xe0, code: null, w: 1.25, modifier: 'ctrl', wide: true })
  r.add({ legend: '←', hid: 0x50, code: 0x1c, dark: true, wide: true })
  r.add({ legend: '↓', hid: 0x51, code: 0x1f, dark: true, wide: true })
  r.add({ legend: '→', hid: 0x4f, code: 0x1d, dark: true, wide: true })
  return r.caps
}

function letterCap(letter: string): Omit<KeyCap, 'row' | 'x' | 'w'> {
  return {
    legend: letter,
    hid: A + (letter.charCodeAt(0) - 65),
    // Capitals, not lower case. The controller sends $51 for Q.
    code: letter.charCodeAt(0)
  }
}

/** All 67 caps, in rows from the top. */
export const KEY_CAPS: readonly KeyCap[] = [
  ...digitRow(),
  ...topRow(),
  ...homeRow(),
  ...shiftRow(),
  ...bottomRow()
]

/**
 * What Fn turns the number row into: F1…F10 on `1`…`0`, the arrangement every
 * 65% board uses and the one `KeyboardMatrixAttachment` decodes back into a held
 * Fn plus a digit. Nothing else on the board moves under Fn.
 */
export const FUNCTION_ROW: Readonly<Record<string, { legend: string; hid: number }>> = {
  '1': { legend: 'F1', hid: 0x3a },
  '2': { legend: 'F2', hid: 0x3b },
  '3': { legend: 'F3', hid: 0x3c },
  '4': { legend: 'F4', hid: 0x3d },
  '5': { legend: 'F5', hid: 0x3e },
  '6': { legend: 'F6', hid: 0x3f },
  '7': { legend: 'F7', hid: 0x40 },
  '8': { legend: 'F8', hid: 0x41 },
  '9': { legend: 'F9', hid: 0x42 },
  '0': { legend: 'F10', hid: 0x43 }
}

/**
 * The byte this cap puts on the wire, given the modifiers held with it.
 *
 * For a machine reading a serial line rather than a keyboard matrix — the
 * KIMulator's terminal. Ctrl+A…Ctrl+Z send 1 to 26 and Ctrl+[ sends $1B, so
 * Ctrl+C is the break and Ctrl+H is backspace, exactly as the reference says.
 * Null means the cap sends nothing, which is a real answer for four of them.
 */
export function byteFor(cap: KeyCap, held: { shift: boolean; ctrl: boolean }): number | null {
  if (cap.modifier) return null

  if (held.ctrl) {
    // Ctrl works off the unshifted legend: the control codes are $01–$1F, and
    // the letter's position in the alphabet is what picks one.
    const base = cap.legend.length === 1 ? cap.legend.toUpperCase().charCodeAt(0) : null
    if (base !== null && base >= 0x40 && base <= 0x5f) return base & 0x1f
    return null
  }

  if (held.shift && cap.shifted) return cap.shifted.charCodeAt(0)
  return cap.code
}
