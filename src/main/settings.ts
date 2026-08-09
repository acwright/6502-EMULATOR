import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { DEFAULT_APP_SETTINGS, DEFAULT_JOYSTICK_SETTINGS } from '../shared/types'
import type { AppSettings } from '../shared/types'

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
   * `6502 run --freq 2 --cf build/disk.img` is someone trying a build out, not
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
      // Nested, so it needs its own merge: a spread would take a `joystick`
      // written by an older version wholesale, and every field added since
      // would arrive undefined.
      return {
        ...DEFAULT_APP_SETTINGS,
        ...parsed,
        joystick: { ...DEFAULT_JOYSTICK_SETTINGS, ...parsed.joystick }
      }
    } catch {
      return { ...DEFAULT_APP_SETTINGS }
    }
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.saved, null, 2), 'utf-8')
    } catch (e) {
      console.error('[settings] save:', e)
    }
  }
}
