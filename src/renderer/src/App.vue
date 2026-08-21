<template>
  <main class="app-main">
    <!-- The screen and the keyboard together, so landscape can turn the two of
         them from a column into a row without the control bar joining in. -->
    <div class="stage">
      <VideoCanvas />
      <!-- Above the bar, not below it: the bar is where the toggle lives and the
           one piece of chrome that must not move when the keyboard comes up. -->
      <OnScreenKeyboard v-if="keyboardOpen" />
    </div>
    <ControlBar
      :keyboard-open="keyboardOpen"
      @toggle-settings="settingsOpen = !settingsOpen"
      @toggle-paste="pasteOpen = !pasteOpen"
      @toggle-keyboard="keyboardOpen = !keyboardOpen"
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
import OnScreenKeyboard from '@/components/OnScreenKeyboard.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import PasteModal from '@/components/PasteModal.vue'
import { useKeyboard } from '@/composables/useKeyboard'
import { useJoystick } from '@/composables/useJoystick'
import { usePersistence } from '@/composables/usePersistence'
import { useAudio } from '@/composables/useAudio'
import { useSerial } from '@/composables/useSerial'
import { useDebugBridge } from '@/composables/useDebugBridge'
import { loadDefaultBIOS, DEFAULT_ROM_LABEL } from '@/composables/useDefaultBIOS'
import { bootPayload } from '@/composables/useBoot'
import { useEmulatorStore } from '@/stores/emulator'
import { useJoystickStore } from '@/stores/joystick'
import { DEFAULT_JOYSTICK_SETTINGS } from '@shared/types'
import type { AppSettings } from '@shared/types'

const store = useEmulatorStore()
const joysticks = useJoystickStore()
const persistence = usePersistence()
// Held here for the app's lifetime: the machine's serial link belongs to the
// machine, not to whichever panel happens to be open (see useSerial).
const serial = useSerial()
const { initAudio, armAudioOnFirstGesture } = useAudio()
const settingsOpen = ref(false)
const pasteOpen = ref(false)
const keyboardOpen = ref(false)

useKeyboard()
useJoystick()
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
      // Merged, not assigned: settings saved by an older version are missing
      // whatever has been added to JoystickSettings since.
      if (settings.joystick) {
        joysticks.settings = { ...DEFAULT_JOYSTICK_SETTINGS, ...settings.joystick }
      }
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
    // loadROM resets, so the CPU starts at the BIOS entry point instead of the
    // uninitialised address it took when the machine was constructed empty.
    store.loadROM(rom.bytes, rom.label)
  } else {
    console.warn('[App] BIOS not loaded — machine will run without a ROM')
  }

  // 4b. Anything else the command line attached. Order matters: a cartridge
  //     supplies its own vectors and resets the CPU as it is inserted, so RAM is
  //     written only after that. loadProgram() copes with BASIC not being up yet
  //     by finishing its pointer fixup once it is.
  if (boot?.cart) store.loadCart(boot.cart.bytes, boot.cart.label)
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
/*
  Children stretch across the window; each one centres its own contents.

  This used to centre them instead, which made every child shrink-to-fit — so the
  control bar sized itself to its contents and ran off both edges of a phone
  rather than wrapping, and anything else dropped in here would do the same. The
  canvas already worked around it with `align-self: stretch`; making it the rule
  is what stops the next panel having to.
*/
.app-main {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.stage {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

/*
  Landscape on a phone: the keyboard goes beside the screen, not under it.

  Stacked, the two of them divide about 290pt of height and the screen ends up a
  strip — while several hundred points of width sit empty either side of it,
  because a 4:3 picture in a wide short window is limited by height and nothing
  else. Side by side, both take that height instead of splitting it: the screen
  roughly doubles and the keyboard grows with it.

  The screen asks for exactly the width its height entitles it to — `100cqh` is
  the stage's height — up to a limit that guarantees the keyboard a usable share.
  Whatever is left is the keyboard's, which sizes itself the same way from its
  own box. Below 700px there is no width to do this with, so it stays a column.
*/
@media (max-height: 480px) and (min-width: 700px) {
  .stage {
    flex-direction: row;
    /* With the keyboard up there is no free space to distribute — it takes
       whatever the screen does not. With it hidden the screen is a fixed-width
       item alone in a wide row, and without this it sat against the left edge. */
    justify-content: center;
    /* Makes the stage's height the reference for the screen's width below. */
    container-type: size;
  }

  .stage > .canvas-outer {
    flex: 0 0 auto;
    width: min(62%, calc(100cqh * 4 / 3));
  }

  .stage > .osk {
    flex: 1 1 0;
    min-width: 0;
  }
}
</style>
