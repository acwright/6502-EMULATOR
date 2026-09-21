import { join } from 'path'

/**
 * The app's two names, which are deliberately not the same string.
 *
 * Electron derives `userData` from the app's name, and the app has been
 * renamed once already — so the two have to be stated separately or the
 * display name drags everyone's saved machine with it.
 */

/**
 * What the app calls itself: the window, the About panel, and the macOS
 * application menu's *About*, *Hide* and *Quit* items, which Electron builds
 * from `app.name`.
 *
 * It must equal `productName` in `electron-builder.yml`, which is what the
 * bundle is named — the menu saying one thing and the Dock another is exactly
 * the bug this fixes. `userData.test.ts` holds the two to each other.
 *
 * Without `app.setName`, `app.name` falls back to `name` in `package.json`,
 * which is the npm package identifier: up to 3.3.0 the menu read
 * *About 6502-emulator*.
 */
export const APP_NAME = 'AC6502 Emulator'

/**
 * The folder the desktop app keeps its data in, under the OS's app-data
 * directory: the CF image, NVRAM, settings, and the renderer's localStorage
 * and IndexedDB.
 *
 * Pinned rather than left to Electron, which derives it from the app's name.
 * The app was "6502 Emulator" and is now "AC6502 Emulator"; a name that ever
 * reaches that derivation would move everyone's saved machine into a new,
 * empty folder. Never change this string, and never spell it from
 * `APP_NAME` — the whole point is that it does not follow the name.
 */
export const USER_DATA_FOLDER = '6502-emulator'

export function userDataPath(appData: string): string {
  return join(appData, USER_DATA_FOLDER)
}
