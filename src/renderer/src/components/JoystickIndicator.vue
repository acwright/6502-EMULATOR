<template>
  <div class="flex flex-row items-center gap-2 font-mono text-xs" title="Joystick input">
    <span
      v-for="stick in sticks"
      :key="stick.joy"
      class="px-1.5 py-0.5 rounded border transition-colors"
      :class="stick.active
        ? 'border-emerald-400/70 text-emerald-300'
        : 'border-white/20 text-white/40'"
      :title="stick.title"
    >
      JOY{{ stick.joy }}: {{ stick.label }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useJoystickStore } from '@/stores/joystick'

const joysticks = useJoystickStore()

interface StickInfo {
  joy: 1 | 2
  label: string
  title: string
  active: boolean
}

// JOY(1) is Port B (first pad); JOY(2) is Port A (second pad). The numpad
// fallback always backs JOY(1); WASD backs JOY(2) only when armed.
const sticks = computed<StickInfo[]>(() => {
  const padFor = (joy: 1 | 2) => joysticks.pads.find((p) => p.joy === joy)

  const first = padFor(1)
  const second = padFor(2)

  return [
    first
      ? { joy: 1, label: 'PAD', title: first.id, active: true }
      : { joy: 1, label: 'NUM', title: 'Numpad fallback', active: true },
    second
      ? { joy: 2, label: 'PAD', title: second.id, active: true }
      : joysticks.settings.keyboard2Enabled
        ? { joy: 2, label: 'WASD', title: 'WASD keyboard fallback', active: true }
        : { joy: 2, label: 'off', title: 'No second pad; WASD fallback disabled', active: false }
  ]
})
</script>
