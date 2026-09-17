import { join } from 'node:path'
import { USER_DATA_FOLDER, userDataPath } from '../../main/userData'

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
})
