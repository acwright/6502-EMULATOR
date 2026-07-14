/**
 * Fetch the bundled default BIOS ROM.
 * - Electron: IPC → main process reads from the app bundle.
 * - Web: fetch from the Vite public URL (BASE_URL + roms/BIOS.bin).
 *
 * Shared by the auto-boot sequence (App.vue) and the "reset ROM to default"
 * action in the settings panel.
 */
export async function loadDefaultBIOS(): Promise<Uint8Array | null> {
  try {
    if (window.api) {
      const data = await window.api.storage.loadDefaultROM()
      return data ? new Uint8Array(data) : null
    } else {
      const r = await fetch(import.meta.env.BASE_URL + 'roms/BIOS.bin')
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null
    }
  } catch (e) {
    console.warn('[useDefaultBIOS] loadDefaultBIOS failed:', e)
    return null
  }
}

export const DEFAULT_ROM_LABEL = 'BIOS (default)'
