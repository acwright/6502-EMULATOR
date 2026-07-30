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
import { useSerial } from '@/composables/useSerial'
import { useDebugBridge } from '@/composables/useDebugBridge'
import { loadDefaultBIOS, DEFAULT_ROM_LABEL } from '@/composables/useDefaultBIOS'
import { bootPayload } from '@/composables/useBoot'
import { useEmulatorStore } from '@/stores/emulator'
import type { AppSettings } from '@shared/types'

const store = useEmulatorStore()
const persistence = usePersistence()
// Held here for the app's lifetime: the machine's serial link belongs to the
// machine, not to whichever panel happens to be open (see useSerial).
const serial = useSerial()
const { initAudio, armAudioOnFirstGesture } = useAudio()
const settingsOpen = ref(false)
const pasteOpen = ref(false)

useKeyboard()
// Registers onUnmounted, so this must run during setup rather than from
// inside the async onMounted below — see useDebugBridge's own doc comment.
useDebugBridge()

// ── Mount: auto-boot sequence ─────────────────────────────────────────────────

onMounted(async () => {
  // 0. What `6502 run` launched this window with, if it did. Null otherwise,
  //    and every step below then behaves exactly as it always has.
  const boot = await bootPayload()
  for (const problem of boot?.errors ?? []) console.error('[boot]', problem)

  // 1. Load settings so the machine starts at the correct frequency. Anything
  //    `6502 run` set — --freq, --baud, --cf, --nvram — is already folded in
  //    here by main, for this launch only, so there is nothing special to do
  //    with it either here or in the Settings panel.
  let settings: AppSettings | undefined
  if (window.api) {
    try {
      settings = await window.api.settings.get()
      store.setFrequency(settings.frequency)
    } catch { /* use defaults */ }
  }

  // 2. Create the Machine instance.
  store.init(boot?.rtc ? { rtc: boot.rtc } : {})

  // 3. Load saved CF card + NVRAM data into the machine BEFORE the CPU starts.
  //    This ensures the BIOS can detect and initialise the storage on boot.
  await persistence.load()

  // 4. Load the ROM: the one the command line named, else the bundled BIOS.
  const rom = boot?.rom ?? (await loadDefaultBIOS().then((bytes) =>
    bytes ? { bytes, label: DEFAULT_ROM_LABEL } : null
  ))
  if (rom) {
    store.loadROM(rom.bytes, rom.label)
    // Re-read the reset vector from the newly loaded ROM so the CPU starts
    // at the BIOS entry point instead of the uninitialised address it reset
    // to when the machine was first constructed with an empty ROM.
    store.resetCPU()
  } else {
    console.warn('[App] BIOS not loaded — machine will run without a ROM')
  }

  // 4b. Anything else the command line attached. Order matters: a cartridge
  //     supplies its own vectors, so the CPU is reset again after it, and only
  //     then is RAM written — a reset would wipe it. loadProgram() copes with
  //     BASIC not being up yet by finishing its pointer fixup once it is.
  if (boot?.cart) {
    store.loadCart(boot.cart.bytes, boot.cart.label)
    store.resetCPU()
  }
  if (boot?.program) store.loadProgram(boot.program.bytes, boot.program.label)
  for (const { address, media } of boot?.binaries ?? []) {
    store.loadBinary(media.bytes, address, media.label)
  }

  // 4c. `--serial <port>`: bridge the ACIA to real hardware before the machine
  //     starts, so nothing the BIOS says on the way up is lost.
  if (boot?.serialPort) {
    await serial.connect(settings?.serialConfig, boot.serialPort)
  }

  // 5. In Electron, initialise audio BEFORE starting the machine so the
  //    AudioWorklet is ready when the BIOS plays its startup beep.
  //
  //    A browser will only start an AudioContext from a user gesture, and the
  //    machine auto-starts below — so the Run button reads "Stop" and nobody
  //    after sound has a reason to press it. Take the first gesture of any
  //    kind instead, or the emulator runs with nowhere to send its samples.
  if (window.api) {
    await initAudio()
  }
  // Also arm on Electron: this is a no-op once audio is up, but it means a
  // failed start-up attempt can still recover on the user's next click.
  armAudioOnFirstGesture()

  // 6. Auto-start: simulates pressing the power button on the real machine.
  //    The BIOS will probe hardware, show the splash screen, and boot to BASIC.
  //    `--pause` holds the CPU at reset instead, so a debugger can attach
  //    before the first instruction; the Run button releases it.
  if (!boot?.pause) store.run()

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
