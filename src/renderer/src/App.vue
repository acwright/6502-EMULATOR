<template>
  <main class="app-main">
    <VideoCanvas />
    <ControlBar
      @toggle-settings="settingsOpen = !settingsOpen"
      @toggle-paste="pasteOpen = !pasteOpen"
    />
  </main>
  <!-- Fixed overlays — outside the flex column so they don't affect VideoCanvas height -->
  <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />
  <PasteModal v-if="pasteOpen" @close="pasteOpen = false" />
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import VideoCanvas from '@/components/VideoCanvas.vue'
import ControlBar from '@/components/ControlBar.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import PasteModal from '@/components/PasteModal.vue'
import { useKeyboard } from '@/composables/useKeyboard'
import { usePersistence } from '@/composables/usePersistence'
import { useAudio } from '@/composables/useAudio'
import { loadDefaultBIOS, DEFAULT_ROM_LABEL } from '@/composables/useDefaultBIOS'
import { useEmulatorStore } from '@/stores/emulator'

const store = useEmulatorStore()
const persistence = usePersistence()
const { initAudio } = useAudio()
const settingsOpen = ref(false)
const pasteOpen = ref(false)

useKeyboard()

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
    store.loadROM(bios, DEFAULT_ROM_LABEL)
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
