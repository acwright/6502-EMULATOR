/**
 * Shared types and IPC channel constants used by the main, preload, and
 * renderer processes.
 */

import { DEFAULT_VDP } from './vdp'
import { DEFAULT_SERIAL_CARD } from './serialCard'
import type { VdpModel } from '../core/IO/VideoCard'
import type { SerialCardConfig } from '../core/IO/SerialCard'
import type { SerialLines } from '../core/SerialPeer'

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
  /**
   * @deprecated Since 3.3, ignored, and dropped in a later release. It was the
   * OS doing RTS/CTS on the host's port, on behalf of a machine it knew
   * nothing about.
   *
   * The port is the far end of the *emulated* machine's serial card, not a
   * terminal for a real board. It now opens with the OS's RTS/CTS off, and the
   * machine does the handshake itself: its RTS drives the port's RTS, and the
   * port's CTS, DCD and DSR reach the chip wherever the card's jumpers connect
   * them to the cable (`AppSettings.serialCard`). The OS doing it as well would
   * fight the machine for the RTS line.
   *
   * Kept in the type, so a settings file that has it still loads.
   */
  rtscts?: boolean
}

/** Default matches the real machine's 19200 8-N-1 boot config. */
export const DEFAULT_SERIAL_CONFIG: SerialConfig = {
  baudRate: 19200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1
}

export type SerialStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** A real port's CTS, DCD and DSR, as it last read them: true is asserted. */
export type SerialSignals = SerialLines

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
  /**
   * The version of this file's format, for one-off migrations when a default
   * changes. Missing in files written before 3.2; see `SETTINGS_VERSION`.
   */
  settingsVersion?: number
  serialConfig: SerialConfig
  /** The video card (`--vdp`). A change is a power cycle with the other card. */
  vdp: VdpModel
  frequency: number       // 1_000_000 or 2_000_000
  /**
   * Whether the console honours the machine's RTS (`--peer-rts`, and the
   * older `--[no-]flow-control`): input waits while RTS is high. On by
   * default, as a terminal set up for the board is.
   *
   * Also holds bytes a real port has already delivered, which a device that
   * honours RTS itself sent before it saw RTS rise.
   */
  flowControl: boolean
  /**
   * The serial card and its jumpers (`--serial-card`, `--cts`, `--dcd`). Not
   * in a file written before 3.3, which loads with `DEFAULT_SERIAL_CARD`.
   */
  serialCard: SerialCardConfig
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

/**
 * The current `AppSettings.settingsVersion`.
 *
 * 2: flow control became on by default. Every save writes the whole settings
 * object, so 3.0.1 to 3.1.1 wrote `flowControl: false` as soon as anything was
 * changed, whether or not anyone chose it. A file without a version therefore
 * has its `flowControl` reset to the new default, once; the file then carries
 * version 2, and someone who turns flow control off afterwards keeps it off.
 */
export const SETTINGS_VERSION = 2

export const DEFAULT_APP_SETTINGS: AppSettings = {
  settingsVersion: SETTINGS_VERSION,
  serialConfig: DEFAULT_SERIAL_CONFIG,
  vdp: DEFAULT_VDP,
  frequency: 1_000_000,
  flowControl: true,
  serialCard: DEFAULT_SERIAL_CARD,
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
  // The machine's RTS out to the port, and the port's CTS/DCD/DSR back in
  SERIAL_SET_RTS: 'serial:setRts',
  SERIAL_SIGNALS: 'serial:signals',
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

