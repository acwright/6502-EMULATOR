import type {
  PortInfo,
  SerialConfig,
  SerialStatus,
  AppSettings,
  CFSectorWrite,
  DebugServerStatus,
  DebugStartOptions,
  CliShimStatus
} from './types'

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
    /**
     * Write only the sectors that changed, at their offsets in the image.
     * Preferred over saveCF(): shipping a 256 MB image across IPC every autosave
     * stalls the renderer long enough to starve the audio queue.
     */
    saveCFSectors(sectors: CFSectorWrite): Promise<void>
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
  debug: {
    start(options?: DebugStartOptions): Promise<DebugServerStatus>
    stop(): Promise<void>
    status(): Promise<DebugServerStatus>
    onStatusChanged(callback: (status: DebugServerStatus) => void): () => void
    /**
     * Register the renderer's method dispatcher.
     *
     * Main hosts the socket but has no Session of its own (§4.3) — every RPC
     * request main receives is forwarded here. The callback returns a plain
     * result-or-error object rather than throwing: thrown values cross the
     * preload context-isolation boundary as generic Errors, losing the
     * `RpcMethodError` code a client depends on, so the renderer catches its
     * own errors and hands back data instead. Only one registration is
     * meaningful at a time; a second call replaces the first.
     */
    onCall(
      callback: (
        method: string,
        params: unknown
      ) => Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>
    ): () => void
    /** Push a notification — `stopped`, `resumed` — for main to broadcast. */
    emitEvent(method: string, params?: unknown): void
    /** Proxies to the main process, which has the filesystem access the renderer lacks. */
    readTextFile(path: string): Promise<string>
    readBinaryFile(path: string): Promise<Uint8Array>
  }
  cli: {
    status(): Promise<CliShimStatus>
    install(): Promise<{ ok: boolean; message: string }>
    uninstall(): Promise<{ ok: boolean; message: string }>
  }
}
