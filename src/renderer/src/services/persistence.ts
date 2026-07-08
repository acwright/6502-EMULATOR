import type { IPersistenceService } from './types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function isElectron(): boolean {
  return typeof window !== 'undefined' && 'api' in window && !!window.api
}

const DB_NAME = '6502-emulator'
const DB_VERSION = 1
const STORE_NAME = 'storage'
const LS_KEY_NVRAM = '6502-emulator-nvram'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function toBase64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]!)
  return btoa(binary)
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ── Web Persistence Service ───────────────────────────────────────────────────
//
// CF image → IndexedDB (handles up to 256 MB without base64 inflation)
// NVRAM (256 B) → LocalStorage (synchronous, survives session)

class WebPersistenceService implements IPersistenceService {
  async loadCF(): Promise<Uint8Array | null> {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get('cf')
      req.onsuccess = () => {
        db.close()
        resolve(req.result instanceof Uint8Array ? req.result : null)
      }
      req.onerror = () => { db.close(); reject(req.error) }
    })
  }

  async saveCF(data: Uint8Array): Promise<void> {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const req = tx.objectStore(STORE_NAME).put(data, 'cf')
      req.onsuccess = () => { db.close(); resolve() }
      req.onerror = () => { db.close(); reject(req.error) }
    })
  }

  async loadNVRAM(): Promise<Uint8Array | null> {
    const data = localStorage.getItem(LS_KEY_NVRAM)
    if (!data) return null
    try { return fromBase64(data) } catch { return null }
  }

  async saveNVRAM(data: Uint8Array): Promise<void> {
    try { localStorage.setItem(LS_KEY_NVRAM, toBase64(data)) } catch { /* quota exceeded */ }
  }
}

// ── Electron Persistence Service ─────────────────────────────────────────────
//
// Calls window.api.storage.* (IPC handlers wired in Phase 4).
// Falls back to WebPersistenceService until Phase 4 IPC handlers are registered,
// so the app is functional end-to-end after Phase 3.

class ElectronPersistenceService implements IPersistenceService {
  private fallback = new WebPersistenceService()

  async loadCF(): Promise<Uint8Array | null> {
    try {
      const result = await window.api!.storage.loadCF()
      // Convert Buffer → Uint8Array (Node.js IPC may return Buffer).
      return result ? new Uint8Array(result) : null
    } catch {
      return this.fallback.loadCF()
    }
  }

  async saveCF(data: Uint8Array): Promise<void> {
    try {
      await window.api!.storage.saveCF(data)
    } catch {
      return this.fallback.saveCF(data)
    }
  }

  async loadNVRAM(): Promise<Uint8Array | null> {
    try {
      const result = await window.api!.storage.loadNVRAM()
      return result ? new Uint8Array(result) : null
    } catch {
      return this.fallback.loadNVRAM()
    }
  }

  async saveNVRAM(data: Uint8Array): Promise<void> {
    try {
      await window.api!.storage.saveNVRAM(data)
    } catch {
      return this.fallback.saveNVRAM(data)
    }
  }
}

// ── Factory (singletons per platform) ────────────────────────────────────────

let _web: WebPersistenceService | null = null
let _electron: ElectronPersistenceService | null = null

export function createPersistenceService(): IPersistenceService {
  if (isElectron()) {
    if (!_electron) _electron = new ElectronPersistenceService()
    return _electron
  }
  if (!_web) _web = new WebPersistenceService()
  return _web
}
