/**
 * Shared types and IPC channel constants used by the main, preload, and
 * renderer processes.
 */

// ── Serial ───────────────────────────────────────────────────────────────────

export interface PortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
}

export interface SerialConfig {
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  parity: 'none' | 'odd' | 'even'
  stopBits: 1 | 1.5 | 2
}

/** Default matches the real machine's 19200 8-N-1 boot config. */
export const DEFAULT_SERIAL_CONFIG: SerialConfig = {
  baudRate: 19200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1
}

export type SerialStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// ── Settings ─────────────────────────────────────────────────────────────────

export interface AppSettings {
  serialConfig: SerialConfig
  frequency: number       // 1_000_000 or 2_000_000
  cfPath?: string         // desktop: last-used CF image path
  nvramPath?: string      // desktop: last-used NVRAM file path
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  serialConfig: DEFAULT_SERIAL_CONFIG,
  frequency: 1_000_000
}

// ── IPC channels ─────────────────────────────────────────────────────────────

export const IPC = {
  // App / window
  APP_GET_VERSION: 'app:getVersion',
  APP_BEFORE_QUIT: 'app:beforeQuit',
  APP_SAVE_COMPLETE: 'app:saveComplete',
  WINDOW_TOGGLE_FULLSCREEN: 'window:toggleFullscreen',
  WINDOW_IS_FULLSCREEN: 'window:isFullscreen',
  WINDOW_FULLSCREEN_CHANGED: 'window:fullscreenChanged',
  // Serial port
  SERIAL_LIST_PORTS: 'serial:listPorts',
  SERIAL_CONNECT: 'serial:connect',
  SERIAL_DISCONNECT: 'serial:disconnect',
  SERIAL_SEND: 'serial:send',
  SERIAL_DATA: 'serial:data',
  SERIAL_STATUS: 'serial:status',
  // Storage (CF card + NVRAM)
  STORAGE_LOAD_CF: 'storage:loadCF',
  STORAGE_SAVE_CF: 'storage:saveCF',
  STORAGE_LOAD_NVRAM: 'storage:loadNVRAM',
  STORAGE_SAVE_NVRAM: 'storage:saveNVRAM',
  STORAGE_PICK_CF: 'storage:pickCF',
  STORAGE_PICK_NVRAM: 'storage:pickNVRAM',
  STORAGE_LOAD_DEFAULT_ROM: 'storage:loadDefaultROM',
  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

