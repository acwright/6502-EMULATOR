import { STORAGE_STORE, openDb } from './persistence'
import type { ICartSaveService, CartSaveTarget } from './types'

/**
 * Where a flash cart's `.sav` overlay is kept, per host.
 *
 * 6502-VCS `PLAN.md` §4 gives each host its own answer — the desktop and the
 * CLI put the file beside the `.crt`, the web build keys it by the image's
 * CRC-32 — but the container is the same bytes either way, so this is the only
 * part that differs and the store does not have to know which it got.
 *
 * What the answers have in common is the thing the plan is actually about:
 * **none of them can write a `.crt`.** There is no path from here to the image.
 *
 * Which target a cart gets is decided by what the cart arrived with, not by
 * which build this is. A cartridge `6502 run --cart` named has a path, so its
 * saves go beside it, where the Flash Helper's host tool would look for them. A
 * cartridge chosen through a file picker has no path — the browser's file API
 * does not hand one out, in Electron or anywhere else — so its saves go into
 * IndexedDB under the image's checksum, which is the only stable name it has.
 */

/**
 * The key one image's overlay lives under.
 *
 * Keyed by CRC-32 rather than by filename because a picker gives no path, and
 * because the checksum is what the container already uses to decide whether a
 * save belongs to an image. Rebuild the cart and it gets a new key rather than
 * a stale save — and the old one stays where it is until the browser's storage
 * is cleared, which is the same "never silently deleted" the file case has.
 *
 * `cart-save:` is a new key in the existing store. `DB_VERSION` stays at 1 and
 * `cf` is untouched — see `openDb`.
 */
export const cartSaveKey = (crc: string): string => `cart-save:${crc}`

class CartSaveService implements ICartSaveService {

  /** The overlay already stored for this image, if there is one. */
  async load(target: CartSaveTarget): Promise<Uint8Array | null> {
    // A file target's bytes were read by the main process and arrived in the
    // boot payload; there is nothing here to read, and a second read could only
    // disagree with the first.
    if (target.kind !== 'db') return null
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly')
      const req = tx.objectStore(STORAGE_STORE).get(cartSaveKey(target.crc))
      req.onsuccess = () => {
        db.close()
        resolve(req.result instanceof Uint8Array ? req.result : null)
      }
      req.onerror = () => { db.close(); reject(req.error) }
    })
  }

  async save(target: CartSaveTarget, data: Uint8Array): Promise<void> {
    if (target.kind === 'file') {
      await window.api!.storage.saveCartSave(target.path, data)
      return
    }
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite')
      const req = tx.objectStore(STORAGE_STORE).put(data, cartSaveKey(target.crc))
      req.onsuccess = () => { db.close(); resolve() }
      req.onerror = () => { db.close(); reject(req.error) }
    })
  }

}

let _service: CartSaveService | null = null

export function createCartSaveService(): ICartSaveService {
  if (!_service) _service = new CartSaveService()
  return _service
}
