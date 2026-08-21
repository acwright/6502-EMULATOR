import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  FUNCTION_ROW,
  KEY_CAPS,
  byteFor
} from '../../renderer/src/keyboard/layout'
import type { KeyCap } from '../../renderer/src/keyboard/layout'

/**
 * The on-screen board against the board it is a picture of.
 *
 * Two documents in 6502-DOCS are the source — `assets/keyboard/keyboard-layout.json`
 * for where the caps are and what is printed on them, and
 * `docs/reference/keyboard-matrix.md` for what each switch sends — and the table
 * in `keyboard/layout.ts` is a transcription of both. What a transcription gets
 * wrong is a number, so this checks the numbers that have a right answer
 * independent of the table: the caps tile their rows exactly, the letters send
 * capitals, the four dead caps are the four named ones, and Shift and Ctrl do
 * what the reference says they do.
 *
 * It deliberately does not restate the layout cap by cap. A test that repeated
 * the table would only prove the table equals itself.
 */

const row = (index: number): KeyCap[] => KEY_CAPS.filter((cap) => cap.row === index)

const rightEdge = (caps: KeyCap[]): number =>
  caps.reduce((max, cap) => Math.max(max, cap.x + cap.w), 0)

describe('the 6502 keyboard’s layout', () => {
  it('has the board’s 67 keys', () => {
    // "Sixty-seven mechanical keys across the front of the board" — docs/using/keyboard.md.
    expect(KEY_CAPS).toHaveLength(67)
  })

  it('fills five rows', () => {
    expect(new Set(KEY_CAPS.map((cap) => cap.row))).toEqual(new Set([0, 1, 2, 3, 4]))
    expect(BOARD_HEIGHT).toBe(5)
  })

  describe('the caps tile their rows', () => {
    it.each([0, 1, 2, 4])('row %i reaches the right-hand edge', (index) => {
      expect(rightEdge(row(index))).toBeCloseTo(BOARD_WIDTH, 5)
    })

    it('leaves the shift row one unit short, for the inverted T', () => {
      // Up sits above Down rather than out at the edge: the arrow cluster is one
      // cap narrower on this row than the right-hand column is on the others.
      const up = row(3).find((cap) => cap.legend === '↑')!
      const down = row(4).find((cap) => cap.legend === '↓')!

      expect(rightEdge(row(3))).toBeCloseTo(BOARD_WIDTH - 1, 5)
      expect(up.x).toBeCloseTo(down.x, 5)
    })

    it('never overlaps two caps', () => {
      for (let index = 0; index < BOARD_HEIGHT; index++) {
        const caps = [...row(index)].sort((a, b) => a.x - b.x)
        for (let i = 1; i < caps.length; i++) {
          // Equal is a butted pair; less is an overlap. Greater is the channel
          // before the right-hand column, which only rows 0–2 have.
          expect(caps[i]!.x).toBeGreaterThanOrEqual(caps[i - 1]!.x + caps[i - 1]!.w)
        }
      }
    })
  })

  describe('what a cap sends', () => {
    const capsFor = (legend: string): KeyCap =>
      KEY_CAPS.find((cap) => cap.legend === legend)!

    it('types capitals, because the machine has no lower case', () => {
      // "Letters are always capitals. Shift changes the symbols and the number
      // row and nothing else." — docs/reference/keyboard-matrix.md.
      const q = capsFor('Q')
      expect(q.code).toBe(0x51)
      expect(byteFor(q, { shift: false, ctrl: false })).toBe(0x51)
      expect(byteFor(q, { shift: true, ctrl: false })).toBe(0x51)

      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        expect(capsFor(letter).code).toBe(letter.charCodeAt(0))
      }
    })

    it('sends the upper legend with Shift held', () => {
      expect(byteFor(capsFor('2'), { shift: true, ctrl: false })).toBe('@'.charCodeAt(0))
      expect(byteFor(capsFor('/'), { shift: true, ctrl: false })).toBe('?'.charCodeAt(0))
      expect(byteFor(capsFor('`'), { shift: true, ctrl: false })).toBe('~'.charCodeAt(0))
    })

    it('sends 1 to 26 for Ctrl and a letter', () => {
      // "Ctrl+C is $03 — the break — and Ctrl+H is $08, the same as backspace."
      expect(byteFor(capsFor('C'), { shift: false, ctrl: true })).toBe(0x03)
      expect(byteFor(capsFor('H'), { shift: false, ctrl: true })).toBe(0x08)
      expect(byteFor(capsFor('A'), { shift: false, ctrl: true })).toBe(0x01)
      expect(byteFor(capsFor('Z'), { shift: false, ctrl: true })).toBe(0x1a)
    })

    it('sends Esc for Ctrl and the left bracket', () => {
      expect(byteFor(capsFor('['), { shift: false, ctrl: true })).toBe(0x1b)
      expect(capsFor('Esc').code).toBe(0x1b)
    })

    it('gives the arrows, Ins and Del the codes nothing in BASIC listens for', () => {
      expect(capsFor('↑').code).toBe(0x1e)
      expect(capsFor('↓').code).toBe(0x1f)
      expect(capsFor('←').code).toBe(0x1c)
      expect(capsFor('→').code).toBe(0x1d)
      expect(capsFor('Ins').code).toBe(0x1a)
      expect(capsFor('Del').code).toBe(0x7f)
    })

    it('never sends a byte that is not a byte', () => {
      for (const cap of KEY_CAPS) {
        if (cap.code === null) continue
        expect(cap.code).toBeGreaterThanOrEqual(0)
        expect(cap.code).toBeLessThanOrEqual(0xff)
      }
    })
  })

  describe('the caps that send nothing', () => {
    it('is exactly the four the controller drops, plus the modifiers', () => {
      // "Caps Lock, Menu, Alt and Fn are scanned like all the others and then
      // dropped: no character, no state."
      const silent = KEY_CAPS.filter((cap) => cap.code === null && !cap.modifier)
      expect(silent.map((cap) => cap.legend).sort()).toEqual(['Caps Lock', 'Menu'])

      // Alt and Fn are silent too, but they latch on this board, so they come
      // out as modifiers rather than as dead caps.
      const modifiers = KEY_CAPS.filter((cap) => cap.modifier)
      expect(new Set(modifiers.map((cap) => cap.modifier))).toEqual(
        new Set(['shift', 'ctrl', 'alt', 'fn'])
      )
      for (const cap of modifiers) {
        expect(cap.code).toBeNull()
        expect(byteFor(cap, { shift: true, ctrl: true })).toBeNull()
      }
    })
  })

  describe('Fn', () => {
    it('turns the whole number row into F1 to F10 and nothing else', () => {
      expect(Object.keys(FUNCTION_ROW).sort()).toEqual(
        ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].sort()
      )
      expect(FUNCTION_ROW['1']).toEqual({ legend: 'F1', hid: 0x3a })
      expect(FUNCTION_ROW['0']).toEqual({ legend: 'F10', hid: 0x43 })
    })

    it('lands on the number caps that are actually on the number row', () => {
      for (const legend of Object.keys(FUNCTION_ROW)) {
        const cap = KEY_CAPS.find((c) => c.legend === legend)!
        expect(cap.row).toBe(0)
      }
    })

    it('has no code of its own to send', () => {
      // No keyboard sends an Fn code; the host is told F1…F10 and infers it.
      expect(KEY_CAPS.find((cap) => cap.modifier === 'fn')!.hid).toBeNull()
    })
  })
})
