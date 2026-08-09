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

// ── Storage ──────────────────────────────────────────────────────────────────

/**
 * An incremental CF card save: only the sectors that changed.
 *
 * `data` holds every sector's bytes concatenated in `offsets` order rather than
 * an array of per-sector arrays — structured clone would otherwise copy the
 * whole 256 MB backing buffer once per sector.
 */
export interface CFSectorWrite {
  sectorSize: number
  /** Byte offset of each sector within the image, ascending. */
  offsets: number[]
  data: Uint8Array
}

// ── Debug server ─────────────────────────────────────────────────────────────

export interface DebugServerStatus {
  running: boolean
  host?: string
  port?: number
  token?: string
  url?: string
}

export interface DebugStartOptions {
  port?: number
  host?: string
  requireToken?: boolean
  /** Use this token instead of generating one — `6502 run --debug-token`. */
  token?: string
}

/** Main → renderer: run this call against the local Session and reply. */
export interface DebugCallRequest {
  id: number
  method: string
  params: unknown
}

/** Renderer → main: the result of a DebugCallRequest. */
export interface DebugCallReply {
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** Renderer → main: a push notification (`stopped`, `resumed`, ...) to broadcast. */
export interface DebugEventMessage {
  method: string
  params?: unknown
}

// ── CLI shim ─────────────────────────────────────────────────────────────────

export interface CliShimStatus {
  installed: boolean
  /** Where the shim was written, when installed. */
  path?: string
  /** True when this platform's install step is handled by the installer, not this action. */
  managedByInstaller?: boolean
}

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * A host key binding for each of the eight joystick signals, by KeyboardEvent
 * `code` (e.g. `Numpad8`, `KeyW`). Empty string means unbound.
 */
export interface JoystickKeyMap {
  up: string
  down: string
  left: string
  right: string
  a: string
  b: string
  x: string
  y: string
}

/**
 * Which stock key map `JOY(1)` uses. A laptop keyboard has no numpad, which
 * left the primary stick unreachable without a gamepad; `arrows` is the way in.
 */
export type JoystickPreset = 'numpad' | 'arrows' | 'off'

/**
 * The `JOY(1)` presets. Arrows deliberately keeps its fire buttons under the
 * right hand, next to the arrow keys on a laptop, and away from the modifiers —
 * a held modifier can swallow its own keyup and stick a button on.
 */
export const JOYSTICK_PRESETS: Record<JoystickPreset, JoystickKeyMap> = {
  numpad: {
    up: 'Numpad8',
    down: 'Numpad2',
    left: 'Numpad4',
    right: 'Numpad6',
    a: 'Numpad0',
    b: 'NumpadDecimal',
    x: 'Numpad5',
    y: 'NumpadEnter'
  },
  arrows: {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    a: 'Space',
    b: 'Slash',
    x: 'Period',
    y: 'Comma'
  },
  off: { up: '', down: '', left: '', right: '', a: '', b: '', x: '', y: '' }
}

export interface JoystickSettings {
  /**
   * Which preset `keyboard1` came from. Stored rather than inferred by
   * comparing key maps — the map is the input the machine reads, this is what
   * the panel shows.
   */
  keyboard1Preset: JoystickPreset
  /**
   * Keyboard fallback for joystick 1 (VIA Port B → `JOY(1)`). Numpad by
   * default, which is collision-free: the 8×8 matrix has no keypad and the
   * firmware discards PS/2 keypad scancodes, so nothing here can reach BASIC as
   * a typed character. The arrows preset is not collision-free and says so.
   */
  keyboard1: JoystickKeyMap
  /**
   * Keyboard fallback for joystick 2 (VIA Port A → `JOY(2)`). Every candidate
   * key collides with typing, so it is off by default and behind this toggle.
   */
  keyboard2Enabled: boolean
  keyboard2: JoystickKeyMap
}

export const DEFAULT_JOYSTICK_SETTINGS: JoystickSettings = {
  keyboard1Preset: 'numpad',
  keyboard1: { ...JOYSTICK_PRESETS.numpad },
  keyboard2Enabled: false,
  keyboard2: {
    up: 'KeyW',
    down: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
    a: 'Space',
    b: 'KeyE',
    x: 'KeyQ',
    y: 'KeyR'
  }
}

export interface AppSettings {
  serialConfig: SerialConfig
  frequency: number       // 1_000_000 or 2_000_000
  cfPath?: string         // desktop: last-used CF image path
  nvramPath?: string      // desktop: last-used NVRAM file path
  joystick: JoystickSettings
  /**
   * Mute *preference*, not mute state. It decides what the output gain starts
   * at once the audio graph exists; it never decides what the mute button
   * shows, because sound is inaudible before the AudioContext runs whatever
   * this says. See useAudio.
   */
  muted?: boolean
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  serialConfig: DEFAULT_SERIAL_CONFIG,
  frequency: 1_000_000,
  joystick: DEFAULT_JOYSTICK_SETTINGS,
  muted: false
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
  // What `6502 run` asked this launch to boot with (see shared/boot.ts)
  BOOT_GET: 'boot:get',
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
  STORAGE_SAVE_CF_SECTORS: 'storage:saveCFSectors',
  STORAGE_LOAD_NVRAM: 'storage:loadNVRAM',
  STORAGE_SAVE_NVRAM: 'storage:saveNVRAM',
  STORAGE_PICK_CF: 'storage:pickCF',
  STORAGE_PICK_NVRAM: 'storage:pickNVRAM',
  STORAGE_RESET_CF: 'storage:resetCF',
  STORAGE_RESET_NVRAM: 'storage:resetNVRAM',
  STORAGE_LOAD_DEFAULT_ROM: 'storage:loadDefaultROM',
  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  // Debug server (Phase 7, §4.3) — main hosts the socket, the renderer's
  // Session actually executes calls, so every RPC crosses this bridge twice.
  DEBUG_START: 'debug:start',
  DEBUG_STOP: 'debug:stop',
  DEBUG_STATUS: 'debug:status',
  DEBUG_STATUS_CHANGED: 'debug:statusChanged',
  DEBUG_CALL_REQUEST: 'debug:callRequest',
  DEBUG_CALL_REPLY: 'debug:callReply',
  DEBUG_EVENT: 'debug:event',
  DEBUG_READ_TEXT_FILE: 'debug:readTextFile',
  DEBUG_READ_BINARY_FILE: 'debug:readBinaryFile',
  // CLI shim (§6.3)
  CLI_STATUS: 'cli:status',
  CLI_INSTALL: 'cli:install',
  CLI_UNINSTALL: 'cli:uninstall',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

