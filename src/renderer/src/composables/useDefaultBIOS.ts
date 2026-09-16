import type { VdpModel } from '@core/IO/VideoCard'
import { BUNDLED_ROM } from '@shared/vdp'

/**
 * Fetch the bundled BIOS ROM for a video card.
 * - Electron: IPC → main process reads assets/roms/<BUNDLED_ROM[model]>.
 * - Web: fetch from the Vite public URL (BASE_URL + roms/<BUNDLED_ROM[model]>).
 *
 * Shared by the auto-boot sequence (App.vue, EmbedApp.vue), the "reset ROM to
 * default" action in the settings panel, and a change of card, which brings its
 * own BIOS with it.
 */
export async function loadDefaultBIOS(model: VdpModel): Promise<Uint8Array | null> {
  try {
    if (window.api) {
      const data = await window.api.storage.loadDefaultROM(model)
      return data ? new Uint8Array(data) : null
    } else {
      const r = await fetch(import.meta.env.BASE_URL + 'roms/' + BUNDLED_ROM[model])
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null
    }
  } catch (e) {
    console.warn('[useDefaultBIOS] loadDefaultBIOS failed:', e)
    return null
  }
}

export const DEFAULT_ROM_LABEL = 'BIOS (default)'
