import { join } from 'path'

/**
 * The folder the desktop app keeps its data in, under the OS's app-data
 * directory: the CF image, NVRAM, settings, and the renderer's localStorage
 * and IndexedDB.
 *
 * Pinned rather than left to Electron, which derives it from the app's name.
 * The app was "6502 Emulator" and is now "AC6502 Emulator"; a name that ever
 * reaches that derivation would move everyone's saved machine into a new,
 * empty folder. Never change this string.
 */
export const USER_DATA_FOLDER = '6502-emulator'

export function userDataPath(appData: string): string {
  return join(appData, USER_DATA_FOLDER)
}
