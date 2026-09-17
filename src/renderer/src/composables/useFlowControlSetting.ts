/**
 * The web build's saved flow-control setting.
 *
 * A key of its own, like the video card's (`useVdpSetting`): a new persisted
 * setting takes a new key, so nothing already stored changes encoding.
 * Electron keeps it in `settings.json` (`AppSettings.flowControl`) instead, and
 * the embed has no host serial port and never saves one.
 *
 * Both functions swallow storage errors: private-mode localStorage throws on
 * access, and a setting that cannot be remembered still holds for the session.
 */
const LS_KEY_FLOW_CONTROL = '6502-emulator-flow-control'

/** The saved setting; off when none is saved. */
export function readSavedFlowControl(): boolean {
  try {
    return localStorage.getItem(LS_KEY_FLOW_CONTROL) === 'on'
  } catch {
    return false
  }
}

export function saveFlowControl(on: boolean): void {
  try {
    localStorage.setItem(LS_KEY_FLOW_CONTROL, on ? 'on' : 'off')
  } catch {
    /* quota or private mode — the choice still holds for this session */
  }
}
