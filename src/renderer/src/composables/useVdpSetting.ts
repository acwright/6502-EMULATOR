import type { VdpModel } from '@core/IO/VideoCard'
import { parseVdp } from '@shared/vdp'

/**
 * The web build's saved video card.
 *
 * A key of its own rather than a field in anything already stored: the Part 1
 * storage rules say a new persisted setting takes a new key, so the CF and NVRAM
 * records keep their encodings. Electron keeps the card in `settings.json`
 * (`AppSettings.vdp`) instead, and the embed never saves one.
 *
 * Both functions swallow storage errors: private-mode localStorage throws on
 * access, and a card that cannot be remembered is still a card that works.
 */
const LS_KEY_VDP = '6502-emulator-vdp'

/** The saved card, or null when none is saved or it names no card. */
export function readSavedVdp(): VdpModel | null {
  try {
    return parseVdp(localStorage.getItem(LS_KEY_VDP))
  } catch {
    return null
  }
}

export function saveVdp(model: VdpModel): void {
  try {
    localStorage.setItem(LS_KEY_VDP, model)
  } catch {
    /* quota or private mode — the choice still holds for this session */
  }
}
