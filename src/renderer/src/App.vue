<template>
  <main class="app-main">
    <VideoCanvas />
    <ControlBar @toggle-settings="settingsOpen = !settingsOpen" />
  </main>
  <!-- Fixed overlay — outside the flex column so it doesn't affect VideoCanvas height -->
  <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import VideoCanvas from '@/components/VideoCanvas.vue'
import ControlBar from '@/components/ControlBar.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import { useKeyboard } from '@/composables/useKeyboard'
import { usePersistence } from '@/composables/usePersistence'
import { useAudio } from '@/composables/useAudio'
import { useEmulatorStore } from '@/stores/emulator'

const store = useEmulatorStore()
const persistence = usePersistence()
const { initAudio } = useAudio()
const settingsOpen = ref(false)

useKeyboard()

// ── BIOS loader ──────────────────────────────────────────────────────────────

/**
 * Fetch the default BIOS ROM.
 * - Electron: IPC → main process reads from the app bundle.
 * - Web: fetch from the Vite public URL (BASE_URL + roms/BIOS.bin).
 */
async function loadDefaultBIOS(): Promise<Uint8Array | null> {
  try {
    if (window.api) {
      const data = await window.api.storage.loadDefaultROM()
      return data ? new Uint8Array(data) : null
    } else {
      const r = await fetch(import.meta.env.BASE_URL + 'roms/BIOS.bin')
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null
    }
  } catch (e) {
    console.warn('[App] loadDefaultBIOS failed:', e)
    return null
  }
}

// ── Mount: auto-boot sequence ─────────────────────────────────────────────────

onMounted(async () => {
  // 1. Load persisted settings so the machine starts at the correct frequency.
  if (window.api) {
    try {
      const settings = await window.api.settings.get()
      store.setFrequency(settings.frequency)
    } catch { /* use defaults */ }
  }

  // 2. Create the Machine instance.
  store.init()

  // 3. Load saved CF card + NVRAM data into the machine BEFORE the CPU starts.
  //    This ensures the BIOS can detect and initialise the storage on boot.
  await persistence.load()

  // 4. Load the bundled BIOS ROM as the default ROM.
  const bios = await loadDefaultBIOS()
  if (bios) {
    store.loadROM(bios, 'BIOS (default)')
    // Re-read the reset vector from the newly loaded ROM so the CPU starts
    // at the BIOS entry point instead of the uninitialised address it reset
    // to when the machine was first constructed with an empty ROM.
    store.resetCPU()
  } else {
    console.warn('[App] BIOS not loaded — machine will run without a ROM')
  }

  // 5. In Electron, initialise audio BEFORE starting the machine so the
  //    AudioWorklet is ready when the BIOS plays its startup beep.
  //    On web, audio requires a user gesture — deferred to ControlBar's Run click.
  if (window.api) {
    await initAudio()
  }

  // 6. Auto-start: simulates pressing the power button on the real machine.
  //    The BIOS will probe hardware, show the splash screen, and boot to BASIC.
  store.run()

  // 7. Set up periodic auto-saves and the beforeunload listener.
  //    Uses startAutoSave (not start) to avoid re-running the load we already awaited.
  persistence.startAutoSave()

  // 7. F11 / Cmd+Enter — fullscreen toggle (Electron only).
  const onFullscreenKey = (e: KeyboardEvent) => {
    if (e.key === 'F11' || (e.metaKey && e.key === 'Enter')) {
      e.preventDefault()
      window.api?.window.toggleFullscreen()
    }
  }
  window.addEventListener('keydown', onFullscreenKey, true)

  // 8. Electron quit: save all state before the window is destroyed.
  const stopBeforeQuit = window.api?.app.onBeforeQuit(async () => {
    await persistence.save()
    window.api?.app.saveComplete()
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', onFullscreenKey, true)
    stopBeforeQuit?.()
  })
})

// Save persistence whenever the emulator stops.
watch(() => store.isRunning, async (running, wasRunning) => {
  if (wasRunning && !running) {
    await persistence.stop()
  }
})
</script>

<style scoped>
.app-main {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  width: 100%;
}
</style>
