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
    <input ref="programInput" type="file" accept=".bin,.prg" class="hidden" @change="onLoadProgram" />

    <div class="w-px h-6 bg-white/20" />

    <!-- Run / Stop toggle -->
    <button @click="toggleRun" :title="store.isRunning ? 'Stop' : 'Run'">
      <StopIcon v-if="store.isRunning" class="size-6" />
      <PlayIcon v-else class="size-6" />
    </button>

    <!-- Reset -->
    <button @click="store.reset()" title="Reset">
      <ArrowPathIcon class="size-6" />
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
import { ref } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { useAudio } from '@/composables/useAudio'
import {
  PlayIcon,
  StopIcon,
  ArrowPathIcon,
  CpuChipIcon,
  DocumentPlusIcon,
  DocumentCurrencyDollarIcon,
  ClipboardIcon,
  Cog6ToothIcon,
} from '@heroicons/vue/24/solid'

defineEmits<{ 'toggle-settings': []; 'toggle-paste': [] }>()

const store = useEmulatorStore()
const { initAudio } = useAudio()

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
