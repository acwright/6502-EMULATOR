import type { BootPayload } from '@shared/boot'

/**
 * What `6502 run` launched this window with, if anything.
 *
 * Fetched once and shared: App.vue applies the media, useDebugBridge wants the
 * symbols, and both run during the same mount. Null in the browser build and
 * whenever the app was opened by hand — every caller treats that as "boot
 * normally", so there is no separate flag for it.
 */
let pending: Promise<BootPayload | null> | undefined

export function bootPayload(): Promise<BootPayload | null> {
  pending ??= window.api ? window.api.boot.get().catch(() => null) : Promise.resolve(null)
  return pending
}
