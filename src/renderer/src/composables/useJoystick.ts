import { onMounted, onUnmounted } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { useJoystickStore } from '@/stores/joystick'
import type { PadStatus } from '@/stores/joystick'
import { JoystickAttachment as J } from '@core/IO/Attachments/JoystickAttachment'
import { keyboardMask, isBound } from '@/composables/joystickKeys'

/**
 * Host joystick input: gamepads via the Gamepad API and a keyboard fallback.
 *
 * Port assignment follows the C64 convention the rest of the stack uses: the
 * first pad drives VIA Port B — `JOY(1)`, the primary — and the second drives
 * Port A — `JOY(2)`. The first stick's keyboard fallback is a preset the
 * Settings panel picks: numpad (safe — the matrix has no keypad), arrows (which
 * takes the cursor keys away from BASIC while it is on), or off. The WASD
 * fallback for the second stick collides with typing and is gated behind a
 * setting of its own.
 *
 * A gamepad and the keyboard can drive the same port at once; their masks are
 * OR'd. Buttons are active-high here — the JoystickAttachment inverts them to
 * the active-low port on the way in.
 */

/** Left-stick axis threshold before it counts as a direction. */
const DEADZONE = 0.5

/** Standard-mapping gamepad → our 8-bit button mask. */
function padMask(pad: Gamepad): number {
  let mask = 0
  const pressed = (i: number): boolean => !!pad.buttons[i]?.pressed
  // Face buttons: standard A/B/X/Y in the same order.
  if (pressed(0)) mask |= J.BUTTON_A
  if (pressed(1)) mask |= J.BUTTON_B
  if (pressed(2)) mask |= J.BUTTON_X
  if (pressed(3)) mask |= J.BUTTON_Y
  // D-pad.
  if (pressed(12)) mask |= J.BUTTON_UP
  if (pressed(13)) mask |= J.BUTTON_DOWN
  if (pressed(14)) mask |= J.BUTTON_LEFT
  if (pressed(15)) mask |= J.BUTTON_RIGHT
  // Left stick, in parallel with the D-pad.
  const ax = pad.axes[0] ?? 0
  const ay = pad.axes[1] ?? 0
  if (ay <= -DEADZONE) mask |= J.BUTTON_UP
  if (ay >= DEADZONE) mask |= J.BUTTON_DOWN
  if (ax <= -DEADZONE) mask |= J.BUTTON_LEFT
  if (ax >= DEADZONE) mask |= J.BUTTON_RIGHT
  return mask
}

function isEditableTarget(e: Event): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

export interface JoystickOptions {
  /**
   * Whether host input should reach the machine right now. Defaults to true;
   * the embed passes its focus state, for the same reason useKeyboard takes
   * one — an unfocused frame must not consume the reader's keystrokes.
   */
  enabled?: () => boolean
}

export function useJoystick(options: JoystickOptions = {}): void {
  const store = useEmulatorStore()
  const joysticks = useJoystickStore()
  const enabled = options.enabled ?? (() => true)

  const held = new Set<string>()
  let raf = 0
  // Last mask sent per port, so we only touch the machine on a change.
  let lastA = -1
  let lastB = -1

  /** Non-null connected pads, in index order (first → B, second → A). */
  function connectedPads(): Gamepad[] {
    const list = navigator.getGamepads ? navigator.getGamepads() : []
    return Array.from(list).filter((p): p is Gamepad => p !== null)
  }

  /** Refresh the store's pad list for the indicator, without churning on no-op. */
  function syncPadStatus(pads: Gamepad[]): void {
    const next: PadStatus[] = pads.slice(0, 2).map((p, i) => ({
      index: p.index,
      id: p.id,
      port: i === 0 ? 'B' : 'A',
      joy: i === 0 ? 1 : 2
    }))
    const same =
      next.length === joysticks.pads.length &&
      next.every((p, i) => {
        const cur = joysticks.pads[i]
        return cur && cur.index === p.index && cur.id === p.id
      })
    if (!same) joysticks.pads = next
  }

  function poll(): void {
    raf = requestAnimationFrame(poll)
    const machine = store.machine
    if (!machine) return

    const pads = connectedPads()
    syncPadStatus(pads)

    // An unfocused embed keeps polling — the indicator still wants to know what
    // is plugged in — but sends centred sticks, so a direction held while the
    // reader clicks away does not stay held.
    if (!enabled()) {
      if (lastB !== 0) { machine.onJoystickB(0); lastB = 0 }
      if (lastA !== 0) { machine.onJoystickA(0); lastA = 0 }
      return
    }

    const map = joysticks.settings
    let maskB = keyboardMask(map.keyboard1, held)
    let maskA = map.keyboard2Enabled ? keyboardMask(map.keyboard2, held) : 0

    if (pads[0]) maskB |= padMask(pads[0]) // first pad → Port B / JOY(1)
    if (pads[1]) maskA |= padMask(pads[1]) // second pad → Port A / JOY(2)

    if (maskB !== lastB) {
      machine.onJoystickB(maskB)
      lastB = maskB
    }
    if (maskA !== lastA) {
      machine.onJoystickA(maskA)
      lastA = maskA
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!enabled() || isEditableTarget(e)) return
    const map = joysticks.settings
    const bound =
      isBound(map.keyboard1, e.code) ||
      (map.keyboard2Enabled && isBound(map.keyboard2, e.code))
    if (!bound) return
    // Consume it so the same key does not also type into BASIC (WASD) or scroll
    // the page (numpad). Capture phase + stopImmediatePropagation beats the
    // keyboard-matrix listener in useKeyboard.
    e.preventDefault()
    e.stopImmediatePropagation()
    held.add(e.code)
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (!held.has(e.code)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    held.delete(e.code)
  }

  function releaseAll(): void {
    held.clear()
    store.machine?.onJoystickA(0)
    store.machine?.onJoystickB(0)
    lastA = 0
    lastB = 0
  }

  onMounted(() => {
    // Capture phase so a bound key is claimed before useKeyboard sees it.
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    // A pad unplugged mid-direction must not leave that direction stuck.
    window.addEventListener('gamepaddisconnected', releaseAll)
    // Losing focus (Alt-Tab) strands held keys; drop them.
    window.addEventListener('blur', releaseAll)
    raf = requestAnimationFrame(poll)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('gamepaddisconnected', releaseAll)
    window.removeEventListener('blur', releaseAll)
    cancelAnimationFrame(raf)
  })
}
