import { onMounted, onUnmounted } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'

const CODE_TO_HID: Record<string, number> = {
  // Letters
  KeyA: 0x04, KeyB: 0x05, KeyC: 0x06, KeyD: 0x07,
  KeyE: 0x08, KeyF: 0x09, KeyG: 0x0a, KeyH: 0x0b,
  KeyI: 0x0c, KeyJ: 0x0d, KeyK: 0x0e, KeyL: 0x0f,
  KeyM: 0x10, KeyN: 0x11, KeyO: 0x12, KeyP: 0x13,
  KeyQ: 0x14, KeyR: 0x15, KeyS: 0x16, KeyT: 0x17,
  KeyU: 0x18, KeyV: 0x19, KeyW: 0x1a, KeyX: 0x1b,
  KeyY: 0x1c, KeyZ: 0x1d,

  // Numbers
  Digit1: 0x1e, Digit2: 0x1f, Digit3: 0x20, Digit4: 0x21,
  Digit5: 0x22, Digit6: 0x23, Digit7: 0x24, Digit8: 0x25,
  Digit9: 0x26, Digit0: 0x27,

  // Control keys
  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b,
  Space: 0x2c,

  // Symbols
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30,
  Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
  Comma: 0x36, Period: 0x37, Slash: 0x38,

  // Lock & function keys
  CapsLock: 0x39,
  F1: 0x3a, F2: 0x3b, F3: 0x3c, F4: 0x3d, F5: 0x3e, F6: 0x3f,
  F7: 0x40, F8: 0x41, F9: 0x42, F10: 0x43, F11: 0x44, F12: 0x45,

  // Navigation
  PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48,
  Insert: 0x49, Home: 0x4a, PageUp: 0x4b,
  Delete: 0x4c, End: 0x4d, PageDown: 0x4e,

  // Arrow keys
  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,

  // Modifiers
  ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
  ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7,
}

export function useKeyboard() {
  const store = useEmulatorStore()

  function handleKeyDown(e: KeyboardEvent) {
    if (!store.isRunning) return
    const hid = CODE_TO_HID[e.code]
    if (hid === undefined) return
    e.preventDefault()
    store.machine?.onKeyDown(hid)
  }

  function handleKeyUp(e: KeyboardEvent) {
    if (!store.isRunning) return
    const hid = CODE_TO_HID[e.code]
    if (hid === undefined) return
    e.preventDefault()
    store.machine?.onKeyUp(hid)
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener('keyup', handleKeyUp)
  })
}
