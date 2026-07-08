import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { DEFAULT_APP_SETTINGS } from '../shared/types'
import type { AppSettings } from '../shared/types'

/**
 * Persists application settings to `<userData>/settings.json`.
 * Synchronous I/O is intentional: the file is tiny and reads/writes are
 * infrequent (only on settings changes and startup).
 */
export class SettingsService {
  private readonly filePath: string
  private cache: AppSettings

  constructor() {
    const userDataDir = app.getPath('userData')
    mkdirSync(userDataDir, { recursive: true })
    this.filePath = join(userDataDir, 'settings.json')
    this.cache = this.load()
  }

  get(): AppSettings {
    return { ...this.cache }
  }

  set(partial: Partial<AppSettings>): void {
    this.cache = { ...this.cache, ...partial }
    this.save()
  }

  private load(): AppSettings {
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      return { ...DEFAULT_APP_SETTINGS, ...parsed }
    } catch {
      return { ...DEFAULT_APP_SETTINGS }
    }
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (e) {
      console.error('[settings] save:', e)
    }
  }
}
