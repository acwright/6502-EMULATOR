<template>
  <div class="control-bar">
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

    <!-- On-screen keyboard. Not a touch-only control, but it is the only
         keyboard a touch device has — and inside an iframe with `controls=none`
         there is no button at all, which is what `keyboard=1` is for. -->
    <button
      :class="{ 'text-indigo-400': keyboardOpen }"
      :title="keyboardOpen ? 'Hide keyboard' : 'Show keyboard'"
      :aria-pressed="keyboardOpen"
      @click="$emit('toggle-keyboard')"
    >
      <KeyboardIcon class="size-5" />
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
import KeyboardIcon from '@/components/KeyboardIcon.vue'
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
 * The embed's control bar: the five things a reader of someone else's page
 * plausibly wants (run, reset, sound, the on-screen keyboard, fullscreen), plus
 * two more under `controls=full`. Everything that implies a session of your own
 * — loading files, settings, the serial console, paste — belongs to the full app.
 *
 * The keyboard is here and not in that second list because it is not a
 * convenience: on a touch device it is the machine's only keyboard, and an embed
 * of BASIC that cannot be typed into is a picture of an emulator.
 */
defineProps<{ mode: ControlsMode; fullscreen: boolean; keyboardOpen?: boolean }>()

defineEmits<{ 'toggle-fullscreen': []; 'toggle-keyboard': [] }>()

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

<style scoped>
/*
  Wraps rather than overflowing — the same rule as the full app's ControlBar,
  which is where the reasoning is written down. A bar that runs off the edge of
  the frame takes its rightmost controls with it, and in an embed those are
  fullscreen and the keyboard toggle: the two a reader on a phone most needs.
*/
.control-bar {
  display: flex;
  flex-flow: row wrap;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  /* The frame stretches its children, so this is a real width to wrap against. */
  width: 100%;
  box-sizing: border-box;
  gap: 0.5rem 1rem;
  padding: 0.375rem 0.5rem;
  /* Clear of the home indicator when this page is opened top-level on a phone,
     and of nothing at all inside an iframe or on a desktop, where the inset is
     zero. See embed.html for `viewport-fit=cover`, which is what makes it
     non-zero. */
  padding-bottom: calc(0.375rem + env(safe-area-inset-bottom));
}

/*
  A 20px icon is a fine mouse target and a poor thumb one. Growing the button
  rather than the icon keeps the bar looking the same and makes it hittable;
  `pointer: coarse` keeps desktop density exactly as it was.
*/
@media (pointer: coarse) {
  .control-bar > button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.75rem;
    min-height: 2.75rem;
  }
}

/*
  On a short frame the bar stops wrapping and scrolls sideways instead. Wrapping
  is right in portrait, where a second row costs nothing anyone wanted; in
  landscape it was taking a third of the height and leaving the screen a strip.
*/
@media (max-height: 480px) {
  .control-bar {
    flex-wrap: nowrap;
    justify-content: flex-start;
    overflow-x: auto;
    /* Keeps a sideways flick from turning into a page scroll or a bounce. */
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }

  .control-bar::-webkit-scrollbar {
    display: none;
  }

  /* Nothing may collapse to make room; running off the end is the point. */
  .control-bar > * {
    flex-shrink: 0;
  }
}
</style>
