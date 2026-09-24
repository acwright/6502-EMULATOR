import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_JOYSTICK_SETTINGS,
  DEFAULT_SERIAL_CONFIG,
  SETTINGS_VERSION
} from '../shared/types'
import type { AppSettings } from '../shared/types'
import { DEFAULT_SERIAL_CARD, readSerialCard } from '../shared/serialCard'

/**
 * Persists application settings to `<userData>/settings.json`.
 * Synchronous I/O is intentional: the file is tiny and reads/writes are
 * infrequent (only on settings changes and startup).
 */
export class SettingsService {
  private readonly filePath: string
  /** What is on disk. */
  private saved: AppSettings
  /** What `6502 run` set for this launch, and nothing else. */
  private launch: Partial<AppSettings> = {}

  constructor() {
    const userDataDir = app.getPath('userData')
    mkdirSync(userDataDir, { recursive: true })
    this.filePath = join(userDataDir, 'settings.json')
    this.saved = this.load()
  }

  get(): AppSettings {
    return { ...this.saved, ...this.launch }
  }

  set(partial: Partial<AppSettings>): void {
    this.saved = { ...this.saved, ...partial }
    // Deliberately changing a setting the command line also set has to win, or
    // the panel would appear to ignore what the user just did for the rest of
    // the session — and the value they chose is the one worth keeping.
    for (const key of Object.keys(partial) as (keyof AppSettings)[]) delete this.launch[key]
    this.save()
  }

  /**
   * Apply settings for this launch alone, leaving the file untouched.
   *
   * `6502 run --baud 9600 --cf build/disk.img` is someone trying a build out, not
   * changing what the app does tomorrow. Kept apart from the saved settings
   * rather than merged into them: everything reading `get()` — the machine, the
   * Settings panel — sees what is actually in effect, while a later `set()`
   * writes only what was really chosen.
   */
  override(partial: Partial<AppSettings>): void {
    this.launch = { ...this.launch, ...partial }
  }

  private load(): AppSettings {
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      // Nested, so they need their own merge: a spread would take a
      // `serialConfig` or a `joystick` written by an older version wholesale,
      // and every field added since would arrive undefined. That is also the
      // whole migration a new connection setting needs.
      const settings: AppSettings = {
        ...DEFAULT_APP_SETTINGS,
        ...parsed,
        serialConfig: { ...DEFAULT_SERIAL_CONFIG, ...parsed.serialConfig },
        joystick: { ...DEFAULT_JOYSTICK_SETTINGS, ...parsed.joystick },
        // Read, not spread: a card this app does not offer, or a jumper that
        // card lacks, is not something to build a machine from.
        serialCard: readSerialCard(parsed.serialCard) ?? DEFAULT_SERIAL_CARD
      }
      return this.migrate(settings, parsed.settingsVersion ?? 1)
    } catch {
      return { ...DEFAULT_APP_SETTINGS }
    }
  }

  /**
   * Bring a file written by an older version up to `SETTINGS_VERSION`, and
   * write it back so the migration happens once.
   *
   * Version 1 to 2: flow control's default went from off to on. A version 1
   * file's `flowControl: false` is most likely the old default saved along with
   * some other change, so it takes the new default. From then on the file says
   * version 2, and a later choice to turn it off is kept.
   *
   * Version 2 to 3: the port's own flow control went, and the serial card
   * came. `flowControl` carries over as it is — it was always the far end
   * honouring RTS, which is what it still says. `serialConfig.rtscts` is
   * dropped: the port opens without the OS's RTS/CTS whatever it says, and a
   * field that is written back but never read would read as a choice still in
   * force. The card takes `DEFAULT_SERIAL_CARD` (see `load`), the ACE with both
   * jumpers at ground, which is the machine every earlier version ran. So a
   * version 2 file behaves exactly as it did.
   *
   * Version 3 to 4: `frequency` is dropped. The ACE runs at 1 MHz only, and
   * a field that is written back but never read would read as a choice still in
   * force, as `rtscts` would have.
   */
  private migrate(settings: AppSettings, from: number): AppSettings {
    if (from >= SETTINGS_VERSION) return settings
    const migrated = { ...settings, settingsVersion: SETTINGS_VERSION }
    if (from < 2) migrated.flowControl = DEFAULT_APP_SETTINGS.flowControl
    if (from < 3) {
      const { rtscts: _dropped, ...serialConfig } = migrated.serialConfig
      migrated.serialConfig = serialConfig
    }
    if (from < 4) delete (migrated as { frequency?: unknown }).frequency
    this.saved = migrated
    this.save()
    return migrated
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.saved, null, 2), 'utf-8')
    } catch (e) {
      console.error('[settings] save:', e)
    }
  }
}
