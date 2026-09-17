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

/**
 * The saved setting; on when none is saved.
 *
 * Nothing to migrate here, unlike Electron's `settings.json`: the web build
 * only ever wrote this key when someone ticked or unticked the box, so an
 * `off` in it was chosen, not left over from the old default.
 */
export function readSavedFlowControl(): boolean {
  try {
    return localStorage.getItem(LS_KEY_FLOW_CONTROL) !== 'off'
  } catch {
    return true
  }
}

export function saveFlowControl(on: boolean): void {
  try {
    localStorage.setItem(LS_KEY_FLOW_CONTROL, on ? 'on' : 'off')
  } catch {
    /* quota or private mode — the choice still holds for this session */
  }
}
