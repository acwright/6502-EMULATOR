import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC } from '../shared/types'
import type {
  SerialConfig,
  AppSettings,
  CFSectorWrite,
  DebugCallReply,
  DebugEventMessage,
  DebugStartOptions
} from '../shared/types'
import type { BootPayload } from '../shared/boot'
import { SerialService } from './serial'
import { StorageService } from './storage'
import { SettingsService } from './settings'
import { DebugBridgeService } from './debugBridge'
import { CliShimService } from './cliShim'
import { bootConfigFrom, readBootPayload } from './boot'

// ── Singletons ───────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null
let serialService: SerialService
let storageService: StorageService
let settingsService: SettingsService
let debugBridge: DebugBridgeService
let cliShim: CliShimService
// Flag set when the renderer has finished saving and it is safe to
// actually close the window (bypasses the save-before-quit intercept).
let readyToQuit = false

// What `6502 run` asked this launch to boot with, if it launched us at all.
// Read before `ready` so the window can be created knowing about it.
const boot = bootConfigFrom(process.argv)
let bootPayload: Promise<BootPayload> | undefined

// Chromium gates SharedArrayBuffer behind cross-origin isolation, which a
// file:// renderer can't satisfy. Without this switch the audio worklet has to
// fall back to copying every buffer over postMessage. Must run before ready.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

// ── Window ───────────────────────────────────────────────────────────────────

// Native VDP resolution is 320×240 (4:3). The app window preserves this ratio.
const ASPECT = 4 / 3
const BASE_WIDTH = 1024
const BASE_HEIGHT = Math.round(BASE_WIDTH / ASPECT) // 768

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: BASE_WIDTH,
    height: BASE_HEIGHT,
    minWidth: BASE_WIDTH,
    maxWidth: BASE_WIDTH,
    minHeight: BASE_HEIGHT,
    maxHeight: BASE_HEIGHT,
    fullscreenable: true,
    center: true,
    title: '6502 Emulator',
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Required for serialport's native Node.js bindings.
      sandbox: false
    }
  })

  serialService.setWindow(mainWindow)
  debugBridge.setWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (boot?.fullscreen) mainWindow?.setFullScreen(true)
    // Launched from a terminal, the window is the thing the user just asked
    // for — it belongs in front of the shell they typed into.
    if (boot) app.focus({ steal: true })
  })

  // Fullscreen state → renderer
  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send(IPC.WINDOW_FULLSCREEN_CHANGED, true)
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send(IPC.WINDOW_FULLSCREEN_CHANGED, false)
  })

  // Intercept close: ask renderer to save, then close for real.
  mainWindow.on('close', (e) => {
    if (readyToQuit) return          // save completed — allow the close
    e.preventDefault()
    // A debug client mid-call against a renderer that's about to be torn down
    // would just hang until its own timeout; end it cleanly instead.
    void debugBridge.stop()
    mainWindow?.webContents.send(IPC.APP_BEFORE_QUIT)
    // Safety valve: force-close after 5 s if renderer never responds.
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        readyToQuit = true
        mainWindow.close()
      }
    }, 5000)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.acwright.emulator6502')

  app.on('browser-window-created', (_, win) => {
    optimizer.watchWindowShortcuts(win)
  })

  // Instantiate services (requires app to be ready for getPath).
  serialService = new SerialService()
  storageService = new StorageService()
  settingsService = new SettingsService()
  debugBridge = new DebugBridgeService()
  cliShim = new CliShimService()
  await storageService.init()

  // Anything `6502 run` set on the command line stands in for the saved value
  // for this launch, so everything below reads one settled set of settings.
  if (boot?.settings) settingsService.override(boot.settings)

  // Apply any persisted custom CF / NVRAM paths so the correct files are loaded
  // when the renderer calls storage:loadCF / storage:loadNVRAM on first mount.
  const saved = settingsService.get()
  if (saved.cfPath) storageService.setCFPath(saved.cfPath)
  if (saved.nvramPath) storageService.setNVRAMPath(saved.nvramPath)

  // ── App / window IPC ───────────────────────────────────────────────────────

  ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion())

  ipcMain.handle(IPC.APP_SAVE_COMPLETE, () => {
    // Renderer finished saving — set the flag and close normally so the
    // OS handles the tear-down correctly (important for macOS).
    readyToQuit = true
    mainWindow?.close()
  })

  ipcMain.handle(IPC.WINDOW_TOGGLE_FULLSCREEN, () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen())
  })

  ipcMain.handle(IPC.WINDOW_IS_FULLSCREEN, () => mainWindow?.isFullScreen() ?? false)

  // ── Boot config (`6502 run` with a window) ─────────────────────────────────

  // Read once and remembered: a reload of the renderer gets the same machine
  // it was launched with rather than a bare one.
  ipcMain.handle(IPC.BOOT_GET, () => {
    if (!boot) return null
    bootPayload ??= readBootPayload(boot)
    return bootPayload
  })

  // ── Serial IPC ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SERIAL_LIST_PORTS, () => serialService.listPorts())

  ipcMain.handle(IPC.SERIAL_CONNECT, async (_e, path: string, config: SerialConfig) => {
    if (!mainWindow) throw new Error('No main window')
    serialService.setWindow(mainWindow)
    return serialService.connect(path, config)
  })

  ipcMain.handle(IPC.SERIAL_DISCONNECT, () => serialService.disconnect())

  // Fire-and-forget (ipcMain.on not handle) for low-latency serial TX.
  ipcMain.on(IPC.SERIAL_SEND, (_e, data: Uint8Array) => serialService.send(data))

  // ── Storage IPC ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.STORAGE_LOAD_CF, () => storageService.loadCF())
  ipcMain.handle(IPC.STORAGE_SAVE_CF, (_e, data: Uint8Array) => storageService.saveCF(data))

  ipcMain.handle(IPC.STORAGE_SAVE_CF_SECTORS, (_e, sectors: CFSectorWrite) =>
    storageService.saveCFSectors(sectors)
  )
  ipcMain.handle(IPC.STORAGE_LOAD_NVRAM, () => storageService.loadNVRAM())
  ipcMain.handle(IPC.STORAGE_SAVE_NVRAM, (_e, data: Uint8Array) => storageService.saveNVRAM(data))

  ipcMain.handle(IPC.STORAGE_PICK_CF, () => {
    if (!mainWindow) return null
    return storageService.pickCF(mainWindow)
  })

  ipcMain.handle(IPC.STORAGE_PICK_NVRAM, () => {
    if (!mainWindow) return null
    return storageService.pickNVRAM(mainWindow)
  })

  ipcMain.handle(IPC.STORAGE_RESET_CF, async () => {
    const data = await storageService.resetCF()
    settingsService.set({ cfPath: undefined })
    return data
  })

  ipcMain.handle(IPC.STORAGE_RESET_NVRAM, async () => {
    const data = await storageService.resetNVRAM()
    settingsService.set({ nvramPath: undefined })
    return data
  })

  ipcMain.handle(IPC.STORAGE_LOAD_DEFAULT_ROM, () => storageService.loadDefaultROM())

  // ── Settings IPC ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SETTINGS_GET, () => settingsService.get())

  ipcMain.handle(IPC.SETTINGS_SET, (_e, partial: Partial<AppSettings>) => {
    settingsService.set(partial)
  })

  // ── Debug server IPC (§4.3) ────────────────────────────────────────────────

  const broadcastDebugStatus = (): void => {
    mainWindow?.webContents.send(IPC.DEBUG_STATUS_CHANGED, debugBridge.status())
  }

  ipcMain.handle(IPC.DEBUG_START, async (_e, options?: DebugStartOptions) => {
    const status = await debugBridge.start(options)
    broadcastDebugStatus()
    return status
  })

  ipcMain.handle(IPC.DEBUG_STOP, async () => {
    await debugBridge.stop()
    broadcastDebugStatus()
  })

  ipcMain.handle(IPC.DEBUG_STATUS, () => debugBridge.status())

  // Fire-and-forget (ipcMain.on not handle): these are one-way, main→renderer
  // requests already got their answer, and the renderer expects no reply.
  ipcMain.on(IPC.DEBUG_CALL_REPLY, (_e, reply: DebugCallReply) => debugBridge.handleReply(reply))
  ipcMain.on(IPC.DEBUG_EVENT, (_e, event: DebugEventMessage) => debugBridge.handleEvent(event))

  // The renderer has no filesystem of its own; `sym.load`/`media.load*` reach
  // one through here when driven by a debug client.
  ipcMain.handle(IPC.DEBUG_READ_TEXT_FILE, (_e, path: string) => readFile(path, 'utf8'))
  ipcMain.handle(IPC.DEBUG_READ_BINARY_FILE, async (_e, path: string) => new Uint8Array(await readFile(path)))

  // ── CLI shim IPC (§6.3) ────────────────────────────────────────────────────

  ipcMain.handle(IPC.CLI_STATUS, () => cliShim.status())
  ipcMain.handle(IPC.CLI_INSTALL, () => cliShim.install())
  ipcMain.handle(IPC.CLI_UNINSTALL, () => cliShim.uninstall())

  // ── Start ──────────────────────────────────────────────────────────────────

  createWindow()

  // `6502 run --debug`: serve from launch, so a debugger has something to
  // attach to before the BIOS has run an instruction (with --pause it does).
  if (boot?.debug) {
    try {
      const status = await debugBridge.start(boot.debug)
      broadcastDebugStatus()
      process.stderr.write(`6502: debug server on ${status.url}\n`)
    } catch (e) {
      process.stderr.write(`6502: could not start the debug server: ${(e as Error).message}\n`)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Quit on all platforms. The user expects closing the window to exit the app.
  app.quit()
})
