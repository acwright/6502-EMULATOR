<template>
  <div class="control-bar">
    <!-- Load ROM -->
    <button @click="romInput?.click()" title="Load ROM">
      <CpuChipIcon class="size-6" />
    </button>
    <input ref="romInput" type="file" accept=".bin,.rom" class="hidden" @change="onLoadROM" />

    <!-- Load Cart -->
    <button @click="cartInput?.click()" title="Load Cart">
      <DocumentPlusIcon class="size-6" />
    </button>
    <input ref="cartInput" type="file" accept=".bin,.crt,.cart" class="hidden" @change="onLoadCart" />

    <!-- Load Program -->
    <button @click="programInput?.click()" title="Load Program">
      <DocumentCurrencyDollarIcon class="size-6" />
    </button>
    <input ref="programInput" type="file" accept=".prg,.bas" class="hidden" @change="onLoadProgram" />

    <div class="w-px h-6 bg-white/20" />

    <!-- Run / Stop toggle -->
    <button @click="toggleRun" :title="runTitle" :class="{ 'opacity-40': store.isHalted }">
      <StopIcon v-if="store.isRunning" class="size-6" />
      <PlayIcon v-else class="size-6" />
    </button>

    <!-- Reset (warm — pulses RESET, keeps RAM) -->
    <button @click="store.reset()" title="Reset (keeps RAM)">
      <ArrowPathIcon class="size-6" />
    </button>

    <!-- Power cycle (cold — zeroes RAM) -->
    <button @click="store.powerCycle()" title="Power Cycle (clears RAM)">
      <PowerIcon class="size-6" />
    </button>

    <div class="w-px h-6 bg-white/20" />

    <!-- CPU Frequency toggle -->
    <button
      @click="toggleFrequency"
      class="font-mono text-sm tabular-nums px-2 py-0.5 rounded border border-white/30 hover:border-white/60 transition-colors"
      :title="store.frequency === 1_000_000 ? 'Switch to 2 MHz' : 'Switch to 1 MHz'"
    >
      {{ store.frequency === 1_000_000 ? '1 MHz' : '2 MHz' }}
    </button>

    <!-- Mute toggle (dimmed until the audio graph is actually running) -->
    <button @click="toggleSound" :title="soundTitle" :class="{ 'opacity-40': !audioReady }">
      <SpeakerXMarkIcon v-if="showsMuted" class="size-6" />
      <SpeakerWaveIcon v-else class="size-6" />
    </button>

    <div class="w-px h-6 bg-white/20" />

    <!-- Joystick input status -->
    <JoystickIndicator />

    <div class="w-px h-6 bg-white/20" />

    <!-- On-screen keyboard.
         Not a touch-only control: it is the only keyboard a phone has, and it
         is also where Fn, Ins and the arrows are on a laptop that has moved
         them somewhere else. -->
    <button
      :class="{ 'text-indigo-400': keyboardOpen }"
      :title="keyboardOpen ? 'Hide keyboard' : 'Show keyboard'"
      :aria-pressed="keyboardOpen"
      @click="$emit('toggle-keyboard')"
    >
      <KeyboardIcon class="size-6" />
    </button>

    <!-- Paste text -->
    <button @click="$emit('toggle-paste')" title="Paste Text">
      <ClipboardIcon class="size-6" />
    </button>

    <!-- Settings panel toggle -->
    <button @click="$emit('toggle-settings')" title="Settings">
      <Cog6ToothIcon class="size-6" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { useAudio } from '@/composables/useAudio'
import JoystickIndicator from '@/components/JoystickIndicator.vue'
import KeyboardIcon from '@/components/KeyboardIcon.vue'
import {
  PlayIcon,
  StopIcon,
  ArrowPathIcon,
  PowerIcon,
  CpuChipIcon,
  DocumentPlusIcon,
  DocumentCurrencyDollarIcon,
  ClipboardIcon,
  Cog6ToothIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
} from '@heroicons/vue/24/solid'

defineEmits<{ 'toggle-settings': []; 'toggle-paste': []; 'toggle-keyboard': [] }>()

defineProps<{ keyboardOpen?: boolean }>()

const store = useEmulatorStore()
const { initAudio, audioReady, muted, setMuted, toggleMute } = useAudio()

/**
 * A machine halted by STP needs Reset, not Run — pressing Run gets a CPU that
 * cannot fetch another instruction. Saying so on the button is the smallest
 * honest signal; without it a halted machine is indistinguishable from a stopped
 * one, which is the state the same button claims it is in.
 */
const runTitle = computed(() => {
  if (store.isHalted) return 'Halted by STP — Reset to continue'
  return store.isRunning ? 'Stop' : 'Run'
})

/**
 * Whether sound is *audible right now*, never the stored preference on its own.
 *
 * On the web the AudioContext cannot start without a user gesture, so a reload
 * with an unmuted preference still shows the muted icon: nothing can come out
 * of the speaker yet, and a speaker icon over silence is the exact confusion
 * this button removes. When some other gesture starts audio — a keypress into
 * BASIC, say — audioReady flips and this corrects itself with nothing wired.
 */
const showsMuted = computed(() => !audioReady.value || muted.value)

const soundTitle = computed(() => {
  if (!audioReady.value) return 'Click to enable sound'
  return muted.value ? 'Unmute' : 'Mute'
})

/**
 * Before audio exists, a button that reads "muted" means "give me sound" —
 * whatever was stored last time, which is why this unmutes rather than toggles.
 */
async function toggleSound() {
  if (!audioReady.value) {
    await initAudio()
    setMuted(false)
    return
  }
  toggleMute()
}

const romInput = ref<HTMLInputElement | null>(null)
const cartInput = ref<HTMLInputElement | null>(null)
const programInput = ref<HTMLInputElement | null>(null)

async function onLoadROM(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const data = new Uint8Array(await file.arrayBuffer())
  input.value = ''
  store.loadROM(data, file.name)
}

async function onLoadCart(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const data = new Uint8Array(await file.arrayBuffer())
  input.value = ''
  store.loadCart(data, file.name)
}

async function onLoadProgram(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const data = new Uint8Array(await file.arrayBuffer())
  input.value = ''
  store.loadProgram(data, file.name)
}

async function toggleRun() {
  await initAudio()
  if (store.isRunning) {
    store.stop()
  } else {
    store.run()
  }
}

function toggleFrequency() {
  const next = store.frequency === 1_000_000 ? 2_000_000 : 1_000_000
  store.setFrequency(next)
  window.api?.settings.set({ frequency: next }).catch(() => {})
}
</script>

<style scoped>
/*
  Wraps rather than overflowing. At its widest this is eleven controls and two
  joystick chips, which is more than a phone has room for in portrait — and a bar
  that runs off the right-hand edge takes Settings with it, which is the one
  control you need to get back out of whatever went wrong.
*/
.control-bar {
  display: flex;
  flex-flow: row wrap;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  /* The column above centres its children, which left this bar shrink-to-fit —
     so instead of wrapping it grew past both edges of the screen and took
     Settings off the right-hand side with it. Wrapping can only work against a
     width, and this is the width. */
  width: 100%;
  box-sizing: border-box;
  gap: 0.5rem 1rem;
  padding: 0.75rem 0.5rem;
  /* Clear of the home indicator on a phone, and of nothing at all on a desktop,
     where the inset is zero. See index.html for `viewport-fit=cover`, which is
     what makes it non-zero. */
  padding-bottom: calc(0.75rem + env(safe-area-inset-bottom));
}

/*
  A 24px icon is a fine mouse target and a poor thumb one. Growing the button
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
  On a short viewport the bar stops wrapping and scrolls sideways instead.

  Wrapping is right in portrait, where a second row costs nothing anyone wanted.
  In landscape a phone has about 340pt of page and this bar was taking a third of
  it in two rows of icons, which left the machine itself a strip. One row that
  scrolls trades a scroll gesture — for the controls past the edge, which are the
  ones you reach for least — against doubling the height the screen gets.
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
