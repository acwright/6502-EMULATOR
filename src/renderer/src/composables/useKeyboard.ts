import { onMounted, onUnmounted } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { HID_NAMES as CODE_TO_HID } from '@debug/KeyCodes'

/**
 * True when the event originated from an editable element (a modal textarea,
 * a settings field, …). We must not forward those keystrokes to the machine
 * or preventDefault them, otherwise the user can't type into the field.
 */
function isEditableTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

export function useKeyboard() {
  const store = useEmulatorStore()

  function handleKeyDown(e: KeyboardEvent) {
    if (!store.isRunning || isEditableTarget(e)) return
    const hid = CODE_TO_HID[e.code]
    if (hid === undefined) return
    e.preventDefault()
    store.machine?.onKeyDown(hid)
  }

  function handleKeyUp(e: KeyboardEvent) {
    if (!store.isRunning || isEditableTarget(e)) return
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
