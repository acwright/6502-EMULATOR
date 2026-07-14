import type { PortInfo, SerialConfig, SerialStatus, AppSettings } from './types'

/**
 * Public API surface exposed by the Electron preload to the renderer via
 * contextBridge. The same interface is used by the renderer's service layer to
 * type `window.api`, allowing TypeScript to verify both sides of the bridge.
 */
export interface AppApi {
  app: {
    getVersion(): Promise<string>
    /** Renderer calls this after saving all state; main process then destroys the window. */
    saveComplete(): void
    /** Main process notifies the renderer that a quit has been requested. */
    onBeforeQuit(callback: () => void): () => void
  }
  window: {
    toggleFullscreen(): Promise<void>
    isFullscreen(): Promise<boolean>
    onFullscreenChanged(callback: (value: boolean) => void): () => void
  }
  serial: {
    listPorts(): Promise<PortInfo[]>
    connect(path: string, config: SerialConfig): Promise<void>
    disconnect(): Promise<void>
    /** Send bytes to the connected port. Fire-and-forget for performance. */
    send(data: Uint8Array): void
    onData(callback: (data: Uint8Array) => void): () => void
    onStatus(callback: (status: SerialStatus) => void): () => void
  }
  storage: {
    loadCF(): Promise<Uint8Array | null>
    saveCF(data: Uint8Array): Promise<void>
    loadNVRAM(): Promise<Uint8Array | null>
    saveNVRAM(data: Uint8Array): Promise<void>
    pickCF(): Promise<string | null>
    pickNVRAM(): Promise<string | null>
    /** Revert the CF card to the app's default image and return its data. */
    resetCF(): Promise<Uint8Array | null>
    /** Revert NVRAM to the app's default file and return its data. */
    resetNVRAM(): Promise<Uint8Array | null>
    /** Load the bundled default BIOS ROM binary from the app bundle. */
    loadDefaultROM(): Promise<Uint8Array | null>
  }
  settings: {
    get(): Promise<AppSettings>
    set(partial: Partial<AppSettings>): Promise<void>
  }
}
