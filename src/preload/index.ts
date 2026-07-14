import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '../shared/types'
import type { SerialConfig, SerialStatus, AppSettings, PortInfo } from '../shared/types'
import type { AppApi } from '../shared/api'

const api: AppApi = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP_GET_VERSION),
    saveComplete: (): void => { ipcRenderer.invoke(IPC.APP_SAVE_COMPLETE) },
    onBeforeQuit: (callback: () => void): (() => void) => {
      const handler = (): void => callback()
      ipcRenderer.on(IPC.APP_BEFORE_QUIT, handler)
      return () => ipcRenderer.off(IPC.APP_BEFORE_QUIT, handler)
    }
  },

  window: {
    toggleFullscreen: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_TOGGLE_FULLSCREEN),
    isFullscreen: (): Promise<boolean> => ipcRenderer.invoke(IPC.WINDOW_IS_FULLSCREEN),
    onFullscreenChanged: (callback: (value: boolean) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, value: boolean): void => callback(value)
      ipcRenderer.on(IPC.WINDOW_FULLSCREEN_CHANGED, handler)
      return () => ipcRenderer.off(IPC.WINDOW_FULLSCREEN_CHANGED, handler)
    }
  },

  serial: {
    listPorts: (): Promise<PortInfo[]> =>
      ipcRenderer.invoke(IPC.SERIAL_LIST_PORTS),
    connect: (path: string, config: SerialConfig): Promise<void> =>
      ipcRenderer.invoke(IPC.SERIAL_CONNECT, path, config),
    disconnect: (): Promise<void> =>
      ipcRenderer.invoke(IPC.SERIAL_DISCONNECT),
    send: (data: Uint8Array): void => ipcRenderer.send(IPC.SERIAL_SEND, data),
    onData: (callback: (data: Uint8Array) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: Uint8Array): void => callback(data)
      ipcRenderer.on(IPC.SERIAL_DATA, handler)
      return () => ipcRenderer.off(IPC.SERIAL_DATA, handler)
    },
    onStatus: (callback: (status: SerialStatus) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, status: SerialStatus): void =>
        callback(status)
      ipcRenderer.on(IPC.SERIAL_STATUS, handler)
      return () => ipcRenderer.off(IPC.SERIAL_STATUS, handler)
    }
  },

  storage: {
    loadCF: (): Promise<Uint8Array | null> =>
      ipcRenderer.invoke(IPC.STORAGE_LOAD_CF),
    saveCF: (data: Uint8Array): Promise<void> =>
      ipcRenderer.invoke(IPC.STORAGE_SAVE_CF, data),
    loadNVRAM: (): Promise<Uint8Array | null> =>
      ipcRenderer.invoke(IPC.STORAGE_LOAD_NVRAM),
    saveNVRAM: (data: Uint8Array): Promise<void> =>
      ipcRenderer.invoke(IPC.STORAGE_SAVE_NVRAM, data),
    pickCF: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.STORAGE_PICK_CF),
    pickNVRAM: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.STORAGE_PICK_NVRAM),
    resetCF: (): Promise<Uint8Array | null> =>
      ipcRenderer.invoke(IPC.STORAGE_RESET_CF),
    resetNVRAM: (): Promise<Uint8Array | null> =>
      ipcRenderer.invoke(IPC.STORAGE_RESET_NVRAM),
    loadDefaultROM: (): Promise<Uint8Array | null> =>
      ipcRenderer.invoke(IPC.STORAGE_LOAD_DEFAULT_ROM)
  },

  settings: {
    get: (): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (partial: Partial<AppSettings>): Promise<void> =>
      ipcRenderer.invoke(IPC.SETTINGS_SET, partial)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
