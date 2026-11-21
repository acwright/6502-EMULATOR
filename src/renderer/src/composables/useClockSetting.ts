/**
 * The web build's saved CPU clock.
 *
 * A key of its own, like flow control's (`useFlowControlSetting`). Electron
 * keeps it in `settings.json` (`AppSettings.frequency`) instead, and the embed
 * takes `freq=` from its URL and never saves one.
 *
 * Both functions swallow storage errors: private-mode localStorage throws on
 * access, and a setting that cannot be remembered still holds for the session.
 */
import { DEFAULT_FREQUENCY, isClockFrequency } from '@shared/clock'

const LS_KEY_FREQUENCY = '6502-emulator-frequency'

/** The saved clock in Hz; 1 MHz when none is saved, or the saved one is not a clock. */
export function readSavedFrequency(): number {
  try {
    const value = Number(localStorage.getItem(LS_KEY_FREQUENCY))
    return isClockFrequency(value) ? value : DEFAULT_FREQUENCY
  } catch {
    return DEFAULT_FREQUENCY
  }
}

export function saveFrequency(frequency: number): void {
  try {
    localStorage.setItem(LS_KEY_FREQUENCY, String(frequency))
  } catch {
    /* quota or private mode — the choice still holds for this session */
  }
}
