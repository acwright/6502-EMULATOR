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

export interface KeyboardOptions {
  /**
   * Whether the machine should be receiving keystrokes at all right now.
   *
   * The whole window belongs to the emulator in the app and in the standalone
   * page, so this defaults to true there. An embed is a guest on someone else's
   * page: until the reader has clicked into the frame, arrow keys and space
   * have to keep scrolling the article around it. That is a `preventDefault`
   * decision as much as a routing one, so the check has to happen before it —
   * swallowing the key and then declining to use it is the worst of both.
   */
  enabled?: () => boolean
}

export function useKeyboard(options: KeyboardOptions = {}) {
  const store = useEmulatorStore()
  const enabled = options.enabled ?? (() => true)

  function handleKeyDown(e: KeyboardEvent) {
    if (!store.isRunning || !enabled() || isEditableTarget(e)) return
    const hid = CODE_TO_HID[e.code]
    if (hid === undefined) return
    e.preventDefault()
    store.machine?.onKeyDown(hid)
  }

  function handleKeyUp(e: KeyboardEvent) {
    if (!store.isRunning || !enabled() || isEditableTarget(e)) return
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
