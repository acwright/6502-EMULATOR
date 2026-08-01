import { ref } from 'vue'
import { defineStore } from 'pinia'
import { DEFAULT_JOYSTICK_SETTINGS } from '@shared/types'
import type { JoystickSettings } from '@shared/types'

/** A connected gamepad and the emulated stick it drives. */
export interface PadStatus {
  /** navigator.getGamepads() index. */
  index: number
  /** The pad's reported id string. */
  id: string
  /** VIA port the pad drives: 'B' = JOY(1), 'A' = JOY(2). */
  port: 'A' | 'B'
  /** BASIC's JOY() number for that port. */
  joy: 1 | 2
}

/**
 * Host-side joystick status, for the on-screen indicator, plus the live
 * keyboard/gamepad settings the input composable reads.
 */
export const useJoystickStore = defineStore('joystick', () => {
  // Connected gamepads (at most two), in the order they drive B then A.
  const pads = ref<PadStatus[]>([])

  // Live copy of the persisted joystick settings; App loads it from settings on
  // boot and the Settings panel writes it back.
  const settings = ref<JoystickSettings>(structuredClone(DEFAULT_JOYSTICK_SETTINGS))

  return { pads, settings }
})
