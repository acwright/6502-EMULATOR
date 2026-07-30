import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_APP_SETTINGS } from '../../shared/types'
import { SettingsService } from '../../main/settings'

/**
 * `6502 run --freq 2 --cf build/disk.img` sets what the Settings panel sets,
 * but for one launch — someone trying a build out has not decided to change
 * what the app does tomorrow. That only holds if a launch value can never
 * reach the file, including by riding along with an unrelated save.
 */

const dir = mkdtempSync(join(tmpdir(), '6502-settings-test-'))
const settingsFile = join(dir, 'settings.json')

jest.mock('electron', () => ({ app: { getPath: () => (global as { __settingsDir?: string }).__settingsDir } }))

beforeAll(() => {
  ;(global as { __settingsDir?: string }).__settingsDir = dir
})

const onDisk = (): unknown =>
  existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : undefined

describe('SettingsService', () => {
  it('serves a launch override without writing it anywhere', () => {
    const settings = new SettingsService()
    settings.override({ frequency: 2_000_000, cfPath: '/tmp/build.img' })

    expect(settings.get()).toMatchObject({ frequency: 2_000_000, cfPath: '/tmp/build.img' })
    expect(onDisk()).toBeUndefined()
  })

  it('saves only what was actually chosen, never the launch values alongside it', () => {
    const settings = new SettingsService()
    settings.override({ frequency: 2_000_000, cfPath: '/tmp/build.img' })

    // The panel writing an unrelated setting must not drag the overrides in —
    // this is how a one-launch --freq used to become the saved default.
    settings.set({ serialConfig: { ...DEFAULT_APP_SETTINGS.serialConfig, baudRate: 4800 } })

    expect(onDisk()).toEqual({
      ...DEFAULT_APP_SETTINGS,
      serialConfig: { ...DEFAULT_APP_SETTINGS.serialConfig, baudRate: 4800 }
    })
    // Still in effect for the machine, still only in memory.
    expect(settings.get().frequency).toBe(2_000_000)
  })

  it('lets a deliberate change win over the launch value for that setting', () => {
    const settings = new SettingsService()
    settings.override({ frequency: 2_000_000 })
    settings.set({ frequency: 1_000_000 })

    // Otherwise the panel would appear to ignore the user for the rest of the
    // session, and the value they chose would be lost at the same time.
    expect(settings.get().frequency).toBe(1_000_000)
    expect(onDisk()).toMatchObject({ frequency: 1_000_000 })
  })
})
