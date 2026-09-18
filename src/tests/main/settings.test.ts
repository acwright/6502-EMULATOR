import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_APP_SETTINGS, SETTINGS_VERSION } from '../../shared/types'
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

  it('fills in joystick fields a settings file predates', () => {
    // A file written before JoystickSettings grew a field: a plain spread
    // would take this object whole and hand the app an undefined preset.
    writeFileSync(
      settingsFile,
      JSON.stringify({ joystick: { keyboard1: DEFAULT_APP_SETTINGS.joystick.keyboard1 } })
    )

    expect(new SettingsService().get().joystick).toEqual(DEFAULT_APP_SETTINGS.joystick)
    rmSync(settingsFile)
  })

  /**
   * A saved `serialConfig` missing a field added since takes the default for
   * it, rather than arriving undefined — the same merge the joystick needed.
   * A file from 3.2 with the port's `rtscts` in it still loads: the field is
   * deprecated and ignored (the machine drives the port's RTS), not an error.
   */
  it('merges a saved serial config over the defaults, and still loads one with rtscts', () => {
    writeFileSync(settingsFile, JSON.stringify({ serialConfig: { baudRate: 4800 } }))
    expect(new SettingsService().get().serialConfig).toEqual({
      ...DEFAULT_APP_SETTINGS.serialConfig,
      baudRate: 4800
    })

    writeFileSync(
      settingsFile,
      JSON.stringify({
        ...DEFAULT_APP_SETTINGS,
        serialConfig: { ...DEFAULT_APP_SETTINGS.serialConfig, baudRate: 9600, rtscts: false }
      })
    )
    expect(new SettingsService().get().serialConfig.baudRate).toBe(9600)
    rmSync(settingsFile)
  })

  /**
   * The serial card, added in 3.3. A file that predates it gets the ACE with
   * both jumpers at ground, which is the machine it always ran; one naming a
   * card this app does not offer, or a jumper the card lacks, is not something
   * to build a machine from.
   */
  it('reads the serial card, and falls back to the ACE at ground for anything else', () => {
    writeFileSync(settingsFile, JSON.stringify({ frequency: 2_000_000 }))
    expect(new SettingsService().get().serialCard).toEqual({
      card: 'ace',
      jumpers: { cts: 'ground', dcd: 'ground' }
    })

    writeFileSync(
      settingsFile,
      JSON.stringify({ serialCard: { card: 'pro', jumpers: { cts: 'cable', dcd: 'cable' } } })
    )
    expect(new SettingsService().get().serialCard).toEqual({ card: 'pro', jumpers: { dcd: 'cable' } })

    writeFileSync(settingsFile, JSON.stringify({ serialCard: { card: 'kim', jumpers: {} } }))
    expect(new SettingsService().get().serialCard.card).toBe('ace')
    rmSync(settingsFile)
  })

  it('reads flow control as on from a settings file that predates it, and keeps a --no-flow-control launch out of the file', () => {
    writeFileSync(settingsFile, JSON.stringify({ frequency: 2_000_000 }))
    const settings = new SettingsService()
    expect(settings.get().flowControl).toBe(true)

    settings.override({ flowControl: false })
    settings.set({ frequency: 1_000_000 })
    expect(settings.get().flowControl).toBe(false)
    expect(onDisk()).toMatchObject({ flowControl: true })
    rmSync(settingsFile)
  })

  describe('migrating a file from before settings had a version', () => {
    // 3.0.1 to 3.1.1 wrote the whole settings object on every change, so their
    // files hold `flowControl: false` whether or not anyone chose it.
    const legacy = { ...DEFAULT_APP_SETTINGS, frequency: 2_000_000, flowControl: false }
    delete (legacy as { settingsVersion?: number }).settingsVersion

    afterEach(() => rmSync(settingsFile, { force: true }))

    it('turns flow control on once, keeps everything else, and writes the version back', () => {
      writeFileSync(settingsFile, JSON.stringify(legacy))
      const settings = new SettingsService()
      expect(settings.get()).toMatchObject({ flowControl: true, frequency: 2_000_000, settingsVersion: SETTINGS_VERSION })
      expect(onDisk()).toMatchObject({ flowControl: true, frequency: 2_000_000, settingsVersion: SETTINGS_VERSION })
    })

    it('keeps flow control off when it is turned off after the migration', () => {
      writeFileSync(settingsFile, JSON.stringify(legacy))
      new SettingsService().set({ flowControl: false })

      const reopened = new SettingsService()
      expect(reopened.get().flowControl).toBe(false)
      expect(onDisk()).toMatchObject({ flowControl: false, settingsVersion: SETTINGS_VERSION })
    })

    it('leaves a current file alone', () => {
      writeFileSync(settingsFile, JSON.stringify({ ...DEFAULT_APP_SETTINGS, flowControl: false }))
      const before = readFileSync(settingsFile, 'utf8')
      expect(new SettingsService().get().flowControl).toBe(false)
      expect(readFileSync(settingsFile, 'utf8')).toBe(before)
    })

    it('does not write a file that does not exist', () => {
      expect(new SettingsService().get()).toMatchObject({ flowControl: true, settingsVersion: SETTINGS_VERSION })
      expect(onDisk()).toBeUndefined()
    })
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
