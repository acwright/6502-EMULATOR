import type { ICartSaveService, CartSaveTarget } from './types'

/**
 * Where a flash cart's `.sav` overlay is written, per platform.
 *
 * 6502-VCS `PLAN.md` §4 gives each host its own answer — the desktop and the
 * CLI put the file beside the `.crt`, the web build keys it by the image's
 * CRC-32 — but the container is the same bytes either way, so this is the only
 * part that differs and the store does not have to know which it got.
 *
 * What the answers have in common is the thing the plan is actually about:
 * **none of them can write a `.crt`.** There is no path from here to the image.
 */

/**
 * Electron: the file `6502 run` named, written through the main process.
 *
 * Only a cartridge that arrived with a path gets one of these. A cart chosen
 * through the app's own file picker has no path to sit beside — the browser
 * file API does not hand one out — so it has no sidecar either.
 */
class FileCartSaveService implements ICartSaveService {
  async save(target: CartSaveTarget, data: Uint8Array): Promise<void> {
    await window.api!.storage.saveCartSave(target.path, data)
  }
}

export function createCartSaveService(): ICartSaveService {
  return new FileCartSaveService()
}
