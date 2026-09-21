import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_NAME, USER_DATA_FOLDER, userDataPath } from '../../main/userData'

/**
 * The product name changed from "6502 Emulator" to "AC6502 Emulator" in 3.1.1.
 * Everything a person has saved lives in this folder, so it must not follow.
 */
describe('userDataPath', () => {
  it('is the folder every release before the rename used', () => {
    expect(USER_DATA_FOLDER).toBe('6502-emulator')
    expect(userDataPath('/Users/me/Library/Application Support')).toBe(
      join('/Users/me/Library/Application Support', '6502-emulator')
    )
  })

  it('is not spelled from the app\u2019s name, which is the point', () => {
    expect(USER_DATA_FOLDER).not.toBe(APP_NAME)
  })
})

/**
 * `app.name` is what the macOS application menu's About, Hide and Quit items
 * are built from, and the bundle is named by `productName` in
 * `electron-builder.yml`. They are two strings in two files, and until 3.4.0
 * they disagreed: the menu read "About 6502-emulator", the npm package's name,
 * because nothing ever called `app.setName`.
 */
describe('APP_NAME', () => {
  it('is what the bundle is called', () => {
    const yml = readFileSync(join(__dirname, '..', '..', '..', 'electron-builder.yml'), 'utf8')
    const productName = /^productName:\s*(.+?)\s*$/m.exec(yml)?.[1]
    expect(productName).toBeDefined()
    expect(APP_NAME).toBe(productName)
  })

  /**
   * Order matters. `userData` is pinned to an absolute path first, so renaming
   * the app cannot move it; the other order would leave a window in which
   * Electron's name-derived default is the live one.
   */
  it('is set after the folder is pinned, and before ready', () => {
    const main = readFileSync(join(__dirname, '..', '..', 'main', 'index.ts'), 'utf8')
    const pin = main.indexOf("app.setPath('userData'")
    const name = main.indexOf('app.setName(APP_NAME)')
    expect(pin).toBeGreaterThan(-1)
    expect(name).toBeGreaterThan(pin)
    expect(name).toBeLessThan(main.indexOf('app.whenReady()'))
  })
})
