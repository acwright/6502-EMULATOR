<template>
  <div class="flex flex-row items-center justify-center gap-4 mt-4 mb-4">
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

defineEmits<{ 'toggle-settings': []; 'toggle-paste': [] }>()

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
