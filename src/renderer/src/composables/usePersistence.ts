import { onUnmounted } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { createPersistenceService } from '@/services/persistence'

const SAVE_INTERVAL_MS = 30_000

export function usePersistence() {
  const store = useEmulatorStore()
  const service = createPersistenceService()
  let intervalId: ReturnType<typeof setInterval> | null = null

  /**
   * Persist NVRAM and any changed CF sectors.
   *
   * The CF card is the expensive one: copying and shipping the whole 256 MB
   * image blocked the renderer long enough to starve the audio queue every 30 s.
   * Now a clean image costs nothing at all — the common case, since most
   * sessions never write to the card — and a dirty one moves only its sectors.
   *
   * The dirty set is cleared only after the save resolves, so a failed write is
   * retried on the next tick rather than silently dropped.
   */
  async function save() {
    const rtc = store.getRTC()
    const storage = store.getStorage()

    if (rtc) await service.saveNVRAM(rtc.getNVRAM()).catch(e => console.warn('[persistence] saveNVRAM:', e))
    if (!storage) return

    const delta = storage.getDelta()
    if (delta.kind === 'none') return

    try {
      if (delta.kind === 'full') {
        await service.saveCF(storage.getData())
      } else {
        await service.saveCFSectors(delta, () => storage.getData())
      }
      storage.clearDirty()
    } catch (e) {
      console.warn('[persistence] saveCF:', e)
    }
  }

  async function load() {
    const rtc = store.getRTC()
    const storage = store.getStorage()
    if (rtc) {
      const nvram = await service.loadNVRAM().catch(() => null)
      if (nvram) rtc.loadNVRAM(nvram)
    }
    if (storage) {
      const cf = await service.loadCF().catch(() => null)
      if (cf) {
        storage.loadData(cf)
        // Straight from the persistence store, so it already matches. Without
        // this the first autosave would write back the entire image.
        storage.clearDirty()
      }
    }
  }

  function onBeforeUnload() {
    // Best-effort sync NVRAM save; CF async save may not complete before unload.
    const rtc = store.getRTC()
    if (rtc) service.saveNVRAM(rtc.getNVRAM()).catch(() => {})
    save().catch(() => {})
  }

  function start() {
    load().catch(e => console.warn('[persistence] load:', e))
    startAutoSave()
  }

  /**
   * Set up the periodic-save interval and the beforeunload listener WITHOUT
   * triggering an initial load(). Use this when load() has already been awaited
   * externally (e.g. the auto-boot sequence in App.vue).
   */
  function startAutoSave() {
    window.addEventListener('beforeunload', onBeforeUnload)
    if (intervalId === null) {
      intervalId = setInterval(() => save(), SAVE_INTERVAL_MS)
    }
  }

  async function stop() {
    await save().catch(() => {})
  }

  function cleanup() {
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
    window.removeEventListener('beforeunload', onBeforeUnload)
  }

  onUnmounted(cleanup)

  return { save, load, start, startAutoSave, stop }
}

