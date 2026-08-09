import { JoystickAttachment as J } from '@core/IO/Attachments/JoystickAttachment'
import type { JoystickKeyMap } from '@shared/types'

/**
 * The pure half of the keyboard fallback in useJoystick: what a key map makes
 * of a set of held `KeyboardEvent.code`s. Separate from the composable so it
 * can be tested without a browser — the mapping is the part that has to be
 * right, and a wrong bit shows up as a stick that moves the wrong way.
 *
 * An empty binding means unbound, which is how the `off` preset works: every
 * signal is `''`, so nothing is held and nothing is claimed from the keyboard
 * matrix.
 */

/** The mask a keyboard map yields for the currently held key codes. */
export function keyboardMask(map: JoystickKeyMap, held: Set<string>): number {
  let mask = 0
  if (map.up && held.has(map.up)) mask |= J.BUTTON_UP
  if (map.down && held.has(map.down)) mask |= J.BUTTON_DOWN
  if (map.left && held.has(map.left)) mask |= J.BUTTON_LEFT
  if (map.right && held.has(map.right)) mask |= J.BUTTON_RIGHT
  if (map.a && held.has(map.a)) mask |= J.BUTTON_A
  if (map.b && held.has(map.b)) mask |= J.BUTTON_B
  if (map.x && held.has(map.x)) mask |= J.BUTTON_X
  if (map.y && held.has(map.y)) mask |= J.BUTTON_Y
  return mask
}

/** True when `code` is bound to any signal in `map`. */
export function isBound(map: JoystickKeyMap, code: string): boolean {
  if (!code) return false
  return (
    code === map.up || code === map.down || code === map.left || code === map.right ||
    code === map.a || code === map.b || code === map.x || code === map.y
  )
}
