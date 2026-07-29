import { onUnmounted, watch } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { RendererTarget } from '@/debug/RendererTarget'
import { createMethods } from '@debug/server/Methods'
import { ErrorCode, RpcMethodError } from '@debug/server/Protocol'

/**
 * Wires the desktop app's own machine into the debug protocol (§4.3).
 *
 * Registers the renderer as main's method dispatcher and forwards this
 * machine's stop/resume events to it, regardless of whether the debug server
 * is currently switched on — main simply has nothing to forward the events to
 * until a client is listening, so there is no "turn this on too" step to
 * coordinate with the Settings toggle.
 *
 * A no-op outside Electron: `window.api` does not exist in the web build.
 *
 * Call this at the top level of a component's `<script setup>`, the same way
 * as `useKeyboard()` — it registers `onUnmounted`, which Vue only accepts
 * during a component's synchronous setup, not from inside an async
 * `onMounted` callback after that component has already awaited something.
 * `store.session` is still null at that point (App.vue's own onMounted hasn't
 * run store.init() yet), so the actual wiring waits for it via `watch`
 * instead of requiring it up front.
 */
export function useDebugBridge(): void {
  if (!window.api) return
  const api = window.api

  const store = useEmulatorStore()

  // Populated once store.session becomes available. Collected in one place so
  // the single onUnmounted below — registered synchronously, before this
  // function returns — can always find them, regardless of how much async
  // work has happened by the time the component is torn down.
  let unmounted = false
  const cleanups: (() => void)[] = []

  const stopWatch = watch(
    () => store.session,
    async (session) => {
      if (!session) return
      stopWatch()

      const target = new RendererTarget(session, await api.app.getVersion())
      // The component may have been torn down while that await was pending.
      if (unmounted) return

      const methods = createMethods(target)

      const offCall = api.debug.onCall(async (method, params) => {
        const handler = methods[method]
        if (!handler) {
          return { error: { code: ErrorCode.METHOD_NOT_FOUND, message: `no such method "${method}"` } }
        }
        try {
          return { result: await handler(params) }
        } catch (e) {
          if (e instanceof RpcMethodError) {
            return { error: { code: e.code, message: e.message, data: e.data } }
          }
          const message = e instanceof Error ? e.message : String(e)
          return { error: { code: ErrorCode.INTERNAL_ERROR, message: `${method}: ${message}` } }
        }
      })

      const offStop = session.onStop((reason) => api.debug.emitEvent('stopped', { stop: reason }))
      const offResume = session.onResume((mode) => api.debug.emitEvent('resumed', { mode }))

      cleanups.push(offCall, offStop, offResume)
    },
    { immediate: true }
  )

  onUnmounted(() => {
    unmounted = true
    stopWatch()
    for (const cleanup of cleanups) cleanup()
  })
}
