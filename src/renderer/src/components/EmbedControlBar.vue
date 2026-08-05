<template>
  <div class="flex flex-row items-center justify-center gap-3 py-1.5">
    <!-- Run / Stop toggle -->
    <button @click="toggleRun" :title="runTitle" :class="{ 'opacity-40': store.isHalted }">
      <StopIcon v-if="store.isRunning" class="size-5" />
      <PlayIcon v-else class="size-5" />
    </button>

    <!-- Reset (warm — pulses RESET, keeps RAM) -->
    <button @click="store.reset()" title="Reset (keeps RAM)">
      <ArrowPathIcon class="size-5" />
    </button>

    <!-- Power cycle (cold — zeroes RAM) -->
    <button v-if="mode === 'full'" @click="store.powerCycle()" title="Power Cycle (clears RAM)">
      <PowerIcon class="size-5" />
    </button>

    <!-- CPU frequency toggle -->
    <button
      v-if="mode === 'full'"
      @click="toggleFrequency"
      class="font-mono text-xs tabular-nums px-1.5 py-0.5 rounded border border-white/30 hover:border-white/60 transition-colors"
      :title="store.frequency === 1_000_000 ? 'Switch to 2 MHz' : 'Switch to 1 MHz'"
    >
      {{ store.frequency === 1_000_000 ? '1 MHz' : '2 MHz' }}
    </button>

    <!-- Mute toggle (dimmed until the audio graph is actually running) -->
    <button @click="toggleSound" :title="soundTitle" :class="{ 'opacity-40': !audioReady }">
      <SpeakerXMarkIcon v-if="showsMuted" class="size-5" />
      <SpeakerWaveIcon v-else class="size-5" />
    </button>

    <!-- Fullscreen — owned by EmbedApp, which holds the element to expand -->
    <button @click="$emit('toggle-fullscreen')" :title="fullscreen ? 'Exit fullscreen' : 'Fullscreen'">
      <ArrowsPointingInIcon v-if="fullscreen" class="size-5" />
      <ArrowsPointingOutIcon v-else class="size-5" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { useAudio } from '@/composables/useAudio'
import type { ControlsMode } from '@/embed/params'
import {
  PlayIcon,
  StopIcon,
  ArrowPathIcon,
  PowerIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  ArrowsPointingOutIcon,
  ArrowsPointingInIcon,
} from '@heroicons/vue/24/solid'

/**
 * The embed's control bar: the four things a reader of someone else's page
 * plausibly wants (run, reset, sound, fullscreen), plus two more under
 * `controls=full`. Everything that implies a session of your own — loading
 * files, settings, the serial console, paste — belongs to the full app.
 */
defineProps<{ mode: ControlsMode; fullscreen: boolean }>()

defineEmits<{ 'toggle-fullscreen': [] }>()

const store = useEmulatorStore()
const { initAudio, audioReady, muted, setMuted } = useAudio()

const runTitle = computed(() => {
  if (store.isHalted) return 'Halted by STP — Reset to continue'
  return store.isRunning ? 'Stop' : 'Run'
})

/** Audible right now, never the stored preference alone — see ControlBar. */
const showsMuted = computed(() => !audioReady.value || muted.value)

const soundTitle = computed(() => {
  if (!audioReady.value) return 'Click to enable sound'
  return muted.value ? 'Unmute' : 'Mute'
})

/**
 * `persist: false` throughout: an embed's mute came from its `muted=` parameter
 * and belongs to this frame. Writing it back would let a docs page quietly
 * change the sound setting of the full app on the same origin.
 */
async function toggleSound() {
  if (!audioReady.value) {
    await initAudio()
    setMuted(false, { persist: false })
    return
  }
  setMuted(!muted.value, { persist: false })
}

async function toggleRun() {
  await initAudio()
  if (store.isRunning) store.stop()
  else store.run()
}

/** Not persisted either — `freq=` is per-embed, like everything else here. */
function toggleFrequency() {
  store.setFrequency(store.frequency === 1_000_000 ? 2_000_000 : 1_000_000)
}
</script>
