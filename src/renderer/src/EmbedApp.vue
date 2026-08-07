<template>
  <div
    ref="frameRef"
    class="embed-frame"
    :class="{ 'is-focused': focused }"
    tabindex="0"
    @focusin="focused = true"
    @focusout="onFocusOut"
    @pointerdown="activate"
  >
    <VideoCanvas />

    <EmbedControlBar
      v-if="params.controls !== 'none'"
      :mode="params.controls"
      :fullscreen="fullscreen"
      @toggle-fullscreen="toggleFullscreen"
    />

    <!--
      Two shapes, because the prompt has two different jobs.

      Under `autostart=0` the screen is blank and clicking really is what starts
      the machine, so the prompt covers the frame and says so.

      Under `autostart=1` the machine is already booting — and typing, if
      `autotype` is set — and "Click to start" would be describing something
      that has already happened, over the top of the one thing that proves the
      embed works. All that is left to ask for is the keyboard and the sound, so
      the prompt shrinks to a corner badge and says that instead. It loses
      nothing by being small: the whole wrapper is the click target either way.
    -->
    <div v-if="!activated && !params.autostart" class="embed-overlay" @click="activate">
      <div class="embed-prompt">
        <PlayIcon class="size-8" />
        <span>Click to start</span>
      </div>
    </div>
    <div v-else-if="!activated" class="embed-prompt embed-badge" @click="activate">
      <CursorArrowRaysIcon class="size-4" />
      <span>{{ badgeText }}</span>
    </div>

    <div v-if="problems.length && problemsOpen" class="embed-problems">
      <button class="embed-problems-close" title="Dismiss" @click.stop="problemsOpen = false">
        &times;
      </button>
      <p v-for="(problem, i) in problems" :key="i">{{ problem }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { PlayIcon, CursorArrowRaysIcon } from '@heroicons/vue/24/solid'
import VideoCanvas from '@/components/VideoCanvas.vue'
import EmbedControlBar from '@/components/EmbedControlBar.vue'
import { useKeyboard } from '@/composables/useKeyboard'
import { useJoystick } from '@/composables/useJoystick'
import { usePersistence } from '@/composables/usePersistence'
import { usePaste } from '@/composables/usePaste'
import { useAudio } from '@/composables/useAudio'
import { loadDefaultBIOS, DEFAULT_ROM_LABEL } from '@/composables/useDefaultBIOS'
import { useEmulatorStore } from '@/stores/emulator'
import { parseEmbedParams } from '@/embed/params'
import type { MediaSource } from '@/embed/params'
import { tryLoadMedia } from '@/embed/media'
import { useEmbedMessaging } from '@/embed/messaging'
import { isBasicReady } from '@core/ProgramImage'

/**
 * The emulator as a guest on someone else's page.
 *
 * Everything below the component layer is shared with the full app — the store,
 * the composables, the whole of `src/core`. What differs is what is *absent*:
 * no settings panel, no serial console, no paste modal, no debug bridge, and no
 * persistence unless the URL asked for it. That is the reason this is a second
 * entry point rather than a flag on `App.vue`; the two component trees have
 * almost nothing in common, and shipping one as dead code inside the other
 * would make both harder to follow.
 */

// Parsed before anything else: `cfSize` decides how the machine is built, and
// `origins` has to be known before the first inbound message can arrive.
const params = parseEmbedParams(window.location.search)

const store = useEmulatorStore()
const { initAudio, setMuted, armAudioOnFirstGesture } = useAudio()
const paste = usePaste()

const frameRef = ref<HTMLElement | null>(null)
const focused = ref(false)
const fullscreen = ref(false)
/** First interaction with the frame: what starts audio and takes the keyboard. */
const activated = ref(false)
const problems = ref<string[]>([...params.warnings])
const problemsOpen = ref(true)

/**
 * What the badge promises, which depends on what the click can actually deliver.
 *
 * A browser will not start an AudioContext without a gesture, so the click is
 * what makes sound possible at all — but only if this frame is not also starting
 * muted, in which case it buys the keyboard and nothing else. Saying "click for
 * sound" over an embed that then stays silent is precisely the confusion the
 * mute button was added to remove.
 */
const badgeText = computed(() =>
  params.muted ? 'Click to use the keyboard' : 'Click for sound and keyboard'
)

/**
 * Host input reaches the machine only while the frame has focus.
 *
 * Inside an iframe `window` key listeners already only fire when the frame is
 * focused, so this is mostly belt and braces — but it is also what keeps the
 * `preventDefault()` in useKeyboard from firing for a reader who is arrowing
 * or space-barring their way down the article the embed is sitting in.
 */
const inputEnabled = () => focused.value

useKeyboard({ enabled: inputEnabled })
useJoystick({ enabled: inputEnabled })

// Built during setup rather than in onMounted, because the postMessage layer
// subscribes to the Session's stop events and registers an onUnmounted hook —
// both of which have to happen while the component is still setting up.
store.init({ cfSize: params.cfSize })
store.setFrequency(params.frequency)
// The URL is the authority on this frame's sound, and it must not be written
// back over the full app's stored preference on the same origin.
setMuted(params.muted, { persist: false })

const persistence = params.persist ? usePersistence() : null

const messaging = useEmbedMessaging({
  origins: params.origins,
  setMuted: (muted: boolean) => setMuted(muted, { persist: false }),
  describe: () => ({
    rom: store.romName,
    program: store.programName,
    controls: params.controls,
    warnings: params.warnings,
  }),
})

// ── Boot ─────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Bounds the autotype wait when BASIC never comes up — a cart, say. */
const AUTOTYPE_READY_TIMEOUT_MS = 10_000
const AUTOTYPE_RUN_TIMEOUT_MS = 60_000
/** BASIC writes its warm-start magic just before the prompt appears. */
const AUTOTYPE_SETTLE_MS = 250
const POLL_MS = 100

let disposed = false

function note(problem: string): void {
  console.warn('[embed]', problem)
  problems.value = [...problems.value, problem]
}

async function bytesFor(source: MediaSource, what: string): Promise<Uint8Array | null> {
  const failures: string[] = []
  const bytes = await tryLoadMedia(source, what, failures)
  for (const failure of failures) note(failure)
  return bytes
}

onMounted(async () => {
  for (const warning of params.warnings) console.warn('[embed]', warning)

  // 1. Anything kept from a previous visit, before the ROM so the BIOS can see
  //    a formatted card on the way up. Off unless `persist=1`.
  if (persistence) await persistence.load().catch((e) => note(`persistence: ${e}`))

  // 2. A CF image named in the URL wins over whatever was restored — it is the
  //    more specific instruction, and with `persist=1` it becomes what is saved.
  if (params.cf) {
    const bytes = await bytesFor(params.cf, 'cf')
    if (bytes) store.reloadCF(bytes)
  }

  // 3. ROM. loadROM resets, so the CPU takes its vectors from the ROM actually
  //    loaded rather than from the empty one it was constructed with.
  const rom = params.rom
    ? await bytesFor(params.rom, 'rom')
    : await loadDefaultBIOS()
  if (rom) {
    store.loadROM(rom, params.rom?.label ?? DEFAULT_ROM_LABEL)
  } else {
    note('no ROM loaded — the machine will not boot')
  }

  // 4. A cartridge supplies its own vectors, so inserting it resets again; RAM
  //    is written only after that, since a reset would wipe it.
  if (params.cart) {
    const bytes = await bytesFor(params.cart, 'cart')
    if (bytes) store.loadCart(bytes, params.cart.label)
  }
  if (params.program) {
    const bytes = await bytesFor(params.program, 'prg')
    if (bytes) store.loadProgram(bytes, params.program.label)
  }
  for (const { address, source } of params.binaries) {
    const bytes = await bytesFor(source, 'bin')
    if (bytes) store.loadBinary(bytes, address, source.label)
  }
  void reportLoadProblem()

  // 5. Audio: a browser will not start a context in a background iframe without
  //    a gesture, so this arms rather than starts. The overlay is the obvious
  //    gesture; any other one does just as well.
  armAudioOnFirstGesture()

  if (persistence) persistence.startAutoSave()

  if (params.autostart) store.run()

  messaging.announceReady()

  if (params.autotype) void autotype(params.autotype)
})

/**
 * Report a program that failed to load — but not one that is merely early.
 *
 * Every embed carrying `prg` loads it before the machine has booted, which is
 * the supported way to do it: the store writes the image now and fixes BASIC's
 * end-of-program pointers as soon as BASIC is up. While that is pending it sets
 * `loadWarning` as a *status*, and snapshotting that at mount put "waiting for
 * BASIC" into the red problem banner permanently — an alarming answer to a
 * question nobody asked, on a frame where nothing was wrong.
 *
 * So the warning is read after BASIC is ready rather than before. By then it
 * has cleared itself unless the load genuinely failed, which is the only case
 * worth a banner.
 */
async function reportLoadProblem(): Promise<void> {
  // Under `autostart=0` the machine waits for the reader, and so does this —
  // a program that has not had a chance to load has not failed to load.
  const runDeadline = performance.now() + AUTOTYPE_RUN_TIMEOUT_MS
  while (!disposed && !store.isRunning && performance.now() < runDeadline) await sleep(POLL_MS)
  if (disposed || !store.isRunning) return

  const readyDeadline = performance.now() + AUTOTYPE_READY_TIMEOUT_MS
  while (!disposed && performance.now() < readyDeadline) {
    const machine = store.machine
    if (machine && isBasicReady(machine)) break
    await sleep(POLL_MS)
  }

  // One more poll interval, so the fixup that clears it has had its turn.
  await sleep(POLL_MS * 2)
  if (!disposed && store.loadWarning) note(store.loadWarning)
}

/**
 * Type into the machine once it can receive keystrokes.
 *
 * Two waits, both bounded. The first is for the machine to be running at all,
 * which under `autostart=0` means waiting for the reader to press Run. The
 * second is for BASIC to finish initialising — `isBasicReady` is the same signal
 * the program-pointer fixup uses. A cartridge never satisfies it, so that wait
 * times out and types anyway rather than silently doing nothing.
 */
async function autotype(text: string): Promise<void> {
  const runDeadline = performance.now() + AUTOTYPE_RUN_TIMEOUT_MS
  while (!disposed && !store.isRunning && performance.now() < runDeadline) await sleep(POLL_MS)

  const readyDeadline = performance.now() + AUTOTYPE_READY_TIMEOUT_MS
  while (!disposed && performance.now() < readyDeadline) {
    const machine = store.machine
    if (machine && isBasicReady(machine)) break
    await sleep(POLL_MS)
  }

  if (disposed || !store.isRunning) return
  await sleep(AUTOTYPE_SETTLE_MS)
  await paste.injectText(text)
}

// ── Focus, activation and fullscreen ─────────────────────────────────────────

/**
 * `focusin`/`focusout` rather than `focus`/`blur` because they bubble: pressing
 * a control-bar button moves focus to the button, and the machine must not stop
 * listening to the keyboard because the reader pressed Reset. Focus only leaves
 * the embed when it lands somewhere outside the wrapper entirely.
 */
function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  focused.value = !!next && !!frameRef.value?.contains(next)
}

/**
 * A click into the frame.
 *
 * Every click takes the keyboard — the canvas is not focusable, so without this
 * clicking the screen would leave the machine deaf. The rest happens once:
 * starting the audio graph, and, under `autostart=0`, starting the machine,
 * which is the promise the overlay makes.
 *
 * It deliberately does *not* touch the mute state. `setMuted` already ran during
 * setup, `useAudio.start()` builds the gain node from it, and re-applying the
 * URL's value here would race the control bar's own unmute — both are chained
 * off the same in-flight `initAudio()`, so whichever landed last would win.
 */
function activate(): void {
  const frame = frameRef.value
  if (frame && !frame.contains(document.activeElement)) frame.focus()
  if (activated.value) return

  activated.value = true
  void initAudio().catch((e) => console.warn('[embed] audio init failed:', e))
  if (!store.isRunning && !store.isHalted) store.run()
}

async function toggleFullscreen(): Promise<void> {
  const element = frameRef.value
  if (!element) return
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await element.requestFullscreen()
  } catch (e) {
    // Refused unless the host page's <iframe> carries allow="fullscreen".
    note(`fullscreen unavailable: ${(e as Error).message}`)
  }
}

function onFullscreenChange(): void {
  fullscreen.value = document.fullscreenElement === frameRef.value
}

onMounted(() => document.addEventListener('fullscreenchange', onFullscreenChange))

onUnmounted(() => {
  disposed = true
  paste.cancel()
  document.removeEventListener('fullscreenchange', onFullscreenChange)
})
</script>

<style scoped>
.embed-frame {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  width: 100%;
  position: relative;
  outline: none;
  background: #000;
}

/*
  A visible focus ring is not decoration here: the embed only receives keys
  while it has focus, so "is this thing listening to me?" needs an answer on
  screen. Inset so it is not clipped by the host page's iframe border.
*/
.embed-frame.is-focused::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 0 2px rgb(255 255 255 / 0.45);
  border-radius: 0.25rem;
}

.embed-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 0.55);
  cursor: pointer;
}

.embed-prompt {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  border-radius: 0.5rem;
  border: 1px solid rgb(255 255 255 / 0.3);
  background: rgb(0 0 0 / 0.6);
  font: 500 0.95rem/1.2 system-ui, sans-serif;
  color: #fff;
}

/*
  The same prompt, out of the way. Pinned to a corner over a running machine
  rather than centred over a dimmed one, and small enough that it obscures a
  couple of characters of a 40-column screen at worst.

  The offset is measured from the frame, but the screen is inset 8px inside it
  by .canvas-outer's padding and has an 8px corner radius of its own — so
  anything under about 1rem here lands flush on that rounded corner and reads as
  a mistake. This clears it by roughly its own height.
*/
.embed-badge {
  position: absolute;
  top: 1.25rem;
  right: 1.25rem;
  padding: 0.3rem 0.6rem;
  border-radius: 999px;
  font-size: 0.75rem;
  cursor: pointer;
}

/*
 * Advisory, not alarming. Nothing that reaches this banner is fatal — a
 * malformed parameter has already fallen back to its default and a file that
 * would not load has left a working BASIC prompt behind it — so it is styled as
 * a note over the picture rather than as an error. Red said "this frame is
 * broken" about a machine that was running perfectly.
 */
.embed-problems {
  position: absolute;
  left: 0.5rem;
  right: 0.5rem;
  bottom: 0.5rem;
  padding: 0.5rem 1.75rem 0.5rem 0.6rem;
  border-radius: 0.375rem;
  border: 1px solid rgb(255 255 255 / 0.25);
  background: rgb(20 20 20 / 0.88);
  font: 400 0.75rem/1.35 ui-monospace, monospace;
  color: rgb(255 255 255 / 0.82);
  max-height: 40%;
  overflow-y: auto;
}

.embed-problems-close {
  position: absolute;
  top: 0.15rem;
  right: 0.4rem;
  font-size: 1rem;
  line-height: 1;
  color: inherit;
  cursor: pointer;
}
</style>
