import { keyboardMask, isBound } from '../renderer/src/composables/joystickKeys'
import { JOYSTICK_PRESETS, DEFAULT_JOYSTICK_SETTINGS } from '../shared/types'
import { JoystickAttachment as J } from '../core/IO/Attachments/JoystickAttachment'

/**
 * The `JOY(1)` keyboard presets and the map → mask step they feed.
 *
 * The presets are the only way to reach the primary stick without a gamepad,
 * and a laptop has no numpad — so "arrows moves the stick the way it is
 * labelled" is the whole point of the feature, and a swapped bit here is a
 * game that walks the wrong way with nothing else looking broken.
 */
describe('JOY(1) keyboard presets', () => {
  const held = (...codes: string[]): Set<string> => new Set(codes)

  it('defaults to numpad, and the default map is that preset', () => {
    expect(DEFAULT_JOYSTICK_SETTINGS.keyboard1Preset).toBe('numpad')
    expect(DEFAULT_JOYSTICK_SETTINGS.keyboard1).toEqual(JOYSTICK_PRESETS.numpad)
  })

  it('maps every numpad key to the signal the panel advertises', () => {
    const map = JOYSTICK_PRESETS.numpad
    expect(keyboardMask(map, held('Numpad8'))).toBe(J.BUTTON_UP)
    expect(keyboardMask(map, held('Numpad2'))).toBe(J.BUTTON_DOWN)
    expect(keyboardMask(map, held('Numpad4'))).toBe(J.BUTTON_LEFT)
    expect(keyboardMask(map, held('Numpad6'))).toBe(J.BUTTON_RIGHT)
    expect(keyboardMask(map, held('Numpad0'))).toBe(J.BUTTON_A)
    expect(keyboardMask(map, held('NumpadDecimal'))).toBe(J.BUTTON_B)
    expect(keyboardMask(map, held('Numpad5'))).toBe(J.BUTTON_X)
    expect(keyboardMask(map, held('NumpadEnter'))).toBe(J.BUTTON_Y)
  })

  it('maps every arrows key to the signal the panel advertises', () => {
    const map = JOYSTICK_PRESETS.arrows
    expect(keyboardMask(map, held('ArrowUp'))).toBe(J.BUTTON_UP)
    expect(keyboardMask(map, held('ArrowDown'))).toBe(J.BUTTON_DOWN)
    expect(keyboardMask(map, held('ArrowLeft'))).toBe(J.BUTTON_LEFT)
    expect(keyboardMask(map, held('ArrowRight'))).toBe(J.BUTTON_RIGHT)
    expect(keyboardMask(map, held('Space'))).toBe(J.BUTTON_A)
    expect(keyboardMask(map, held('Slash'))).toBe(J.BUTTON_B)
    expect(keyboardMask(map, held('Period'))).toBe(J.BUTTON_X)
    expect(keyboardMask(map, held('Comma'))).toBe(J.BUTTON_Y)
  })

  it('binds each signal to a distinct key within a preset', () => {
    for (const map of [JOYSTICK_PRESETS.numpad, JOYSTICK_PRESETS.arrows]) {
      const codes = Object.values(map)
      expect(new Set(codes).size).toBe(codes.length)
    }
  })

  it("does not put the arrows preset's fire buttons on the second stick's keys", () => {
    // Both keyboards can be live at once and their masks are OR'd, so a key
    // shared between them would move two sticks at once. Space is the one
    // exception, and it is deliberate: JOY(2) is opt-in and only reachable
    // while its own toggle is on.
    const arrows = JOYSTICK_PRESETS.arrows
    const wasd = DEFAULT_JOYSTICK_SETTINGS.keyboard2
    const shared = Object.values(arrows).filter((code) => isBound(wasd, code))
    expect(shared).toEqual(['Space'])
  })

  it('combines held keys into one mask, diagonals included', () => {
    const map = JOYSTICK_PRESETS.arrows
    expect(keyboardMask(map, held('ArrowUp', 'ArrowRight', 'Space')))
      .toBe(J.BUTTON_UP | J.BUTTON_RIGHT | J.BUTTON_A)
  })

  it('reports a centred stick for the off preset, whatever is held', () => {
    const map = JOYSTICK_PRESETS.off
    expect(keyboardMask(map, held('ArrowUp', 'Numpad8', 'Space'))).toBe(0)
    // An unbound signal is the empty string; nothing may match it, or every
    // key not in the map would read as pressed.
    expect(keyboardMask(map, held(''))).toBe(0)
    expect(isBound(map, '')).toBe(false)
    expect(isBound(map, 'ArrowUp')).toBe(false)
  })

  it('claims a key only when the active preset binds it', () => {
    expect(isBound(JOYSTICK_PRESETS.numpad, 'ArrowUp')).toBe(false)
    expect(isBound(JOYSTICK_PRESETS.arrows, 'ArrowUp')).toBe(true)
    // Which is the collision the panel warns about: with arrows selected the
    // cursor keys stop reaching BASIC's line editor.
    expect(isBound(JOYSTICK_PRESETS.numpad, 'Numpad8')).toBe(true)
  })
})
