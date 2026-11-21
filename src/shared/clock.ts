/**
 * PHI2, the CPU clock: 1 MHz, the AC6502's standard, or 2 MHz.
 *
 * Every machine in the family is drawn, built and tested at 1 MHz. 2 MHz is
 * what the bench found an ACE Rev 1.1 can run, with a 74HCT00 in U14 for the
 * RAM's RB/WB gate (6502-ACE, 2026-11-11), at the builder's risk; no other
 * machine is cleared for it. So the emulator offers it as a Setting with that
 * said beside it, and on the command line, but never on the control bar, where
 * a toggle presented it as tested and expected (3.5 removed that toggle).
 */
export const CLOCK_1MHZ = 1_000_000
export const CLOCK_2MHZ = 2_000_000

/** The clocks a machine can run at, in Hz. */
export const CLOCK_FREQUENCIES: readonly number[] = [CLOCK_1MHZ, CLOCK_2MHZ]

export const DEFAULT_FREQUENCY = CLOCK_1MHZ

/** What the Settings panel, `--help` and the docs say beside the choice. */
export const CLOCK_NOTE =
  '1 MHz is the AC6502 standard, and every machine is tested at it. 2 MHz is untested on most machines: ' +
  'it is a builder’s option on an ACE Rev 1.1 with a 74HCT00 at U14, at the builder’s risk. ' +
  'At 2 MHz the SID, which runs on the CPU’s clock, plays an octave higher.'

/** True for a clock this emulator runs at. */
export function isClockFrequency(value: unknown): value is number {
  return typeof value === 'number' && CLOCK_FREQUENCIES.includes(value)
}

/**
 * `1`, `2`, `1MHz`, `2 MHz`, `1000000` or `2_000_000` as Hz, or null for
 * anything else. The command line, `dbg config` and an embed's `freq=` all read
 * it this way.
 */
export function readClockText(text: string): number | null {
  const normalised = text.trim().toLowerCase().replace(/[\s_]/g, '')
  if (normalised === '1' || normalised === '1mhz') return CLOCK_1MHZ
  if (normalised === '2' || normalised === '2mhz') return CLOCK_2MHZ
  const value = Number(normalised)
  return isClockFrequency(value) ? value : null
}

/** `1 MHz` or `2 MHz`. */
export function describeClock(frequency: number): string {
  return `${frequency / 1e6} MHz`
}
