import type { SerialCardConfig } from '@core/IO/SerialCard'
import { readSerialCard } from '@shared/serialCard'

/**
 * The web build's saved serial card and jumpers.
 *
 * A key of its own, like the video card's (`useVdpSetting`): a new persisted
 * setting takes a new key, so nothing already stored changes encoding.
 * Electron keeps it in `settings.json` (`AppSettings.serialCard`) instead, and
 * the embed never saves one.
 *
 * Both functions swallow storage errors: private-mode localStorage throws on
 * access, and a card that cannot be remembered still holds for the session.
 */
const LS_KEY_SERIAL_CARD = '6502-emulator-serial-card'

/**
 * The saved card, or null when none is saved or it is not one this app
 * offers. Read as `settings.json`'s is, so a jumper the card lacks is dropped.
 */
export function readSavedSerialCard(): SerialCardConfig | null {
  try {
    const raw = localStorage.getItem(LS_KEY_SERIAL_CARD)
    return raw === null ? null : readSerialCard(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveSerialCard(config: SerialCardConfig): void {
  try {
    localStorage.setItem(LS_KEY_SERIAL_CARD, JSON.stringify(config))
  } catch {
    /* quota or private mode — the choice still holds for this session */
  }
}
