import { ref } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'

/**
 * Placeholder until a real AudioContext reports its own rate, which the
 * emulator is then retuned to. It matches Sound's default so that the two
 * agree in the window before the graph exists.
 */
const SAMPLE_RATE = 44_100

/** Ring size. This is headroom for jitter, not the latency we aim to run at. */
const RING_BUFFER_CAPACITY = 16_384

/**
 * Queue depth we steer towards, and the depth at which the worklet gives up and
 * skips forward. The real SID has no buffer at all — a register write is
 * audible within a microsecond — so the goal here is the smallest queue that
 * still absorbs main-thread hitches.
 *
 * After a long stall the emulator loop catches up in one burst (up to Machine's
 * 250 ms clamp) and dumps that much audio at once. The ceiling is where the
 * worklet gives up on drift correction and skips forward; it has to clear the
 * queue's normal working range, or an ordinary hitch costs a chunk of dropped
 * audio every time it grazes the limit.
 */
const TARGET_FILL_MS = 50
const MAX_FILL_MS = 120

/**
 * How far the emulator's sample rate may be pulled to hold the queue at target.
 * 0.5 % is about 8 cents of pitch — inaudible, and enough to absorb the drift
 * between the system clock driving the emulator and the sound card's clock.
 */
const MAX_DRIFT = 0.005
const DRIFT_INTERVAL_MS = 250

/**
 * How long initAudio() waits for the audio graph to start rendering before
 * giving up and letting the machine start anyway. A broken audio device hits
 * this, and so does a browser that has decided the gesture behind the attempt
 * didn't count — the difference is only that the second one is worth trying
 * again. The alternative to giving up is an app that never boots.
 */
const GRAPH_START_TIMEOUT_MS = 3000
const GRAPH_POLL_MS = 50

/**
 * The same wait for a graph that is already built and merely suspended, where
 * there is no output device to open and a granted resume starts pulling within
 * a quantum or two. Short because this one is paid on the user's click — a Run
 * or speaker press on a browser that keeps refusing shouldn't sit for three
 * seconds each time — and because a resume that lands late is picked up by the
 * context's own statechange rather than by anyone waiting here.
 */
const GRAPH_RESUME_TIMEOUT_MS = 750

// ── Module-level shared audio state ──────────────────────────────────────────
//
// All useAudio() calls across any component share the same AudioContext so
// that: (a) initAudio() is idempotent — a caller arriving with the graph
//     already running just returns early;
// (b) App.vue can call initAudio() on Electron startup (no user-gesture
//     restriction) while ControlBar can still call it on first user click.
//
// Note that a context existing is *not* the same as sound working: iOS hands
// back a perfectly good AudioContext that stays suspended, and suspends a
// running one whenever the tab goes to the background. Everything below keys
// off ctx.state, never off the context being non-null.

let audioCtx: AudioContext | null = null
let workletNode: AudioWorkletNode | null = null

/**
 * Mute lives here, between the worklet and the destination, and nowhere else.
 *
 * Not in Sound.masterVolume: that is emulated register state a program reads
 * back and writes, so muting there would corrupt what the machine believes
 * about itself. And not by withholding pushSamples() either — the drift
 * controller steers on queue depth and would drag the emulator's sample rate to
 * the MAX_DRIFT rail while the queue sat empty. Everything upstream of this
 * node runs identically whether the speaker is on or off.
 */
let gainNode: GainNode | null = null

/**
 * In-flight initAudio() call. Without this, a second caller arriving before the
 * first resolves — easy now that any gesture can trigger it — would build a
 * whole second AudioContext and graph.
 */
let initInFlight: Promise<void> | null = null

/** Removes the gesture listeners, once the graph is actually running. */
let disarmGesture: (() => void) | null = null

/**
 * Set when this browser cannot do Web Audio at all, as opposed to not doing it
 * yet. The gesture listeners now stay armed until sound is genuinely playing,
 * so without this every tap on such a browser would build — and leak — another
 * AudioContext, and Safari allows an origin only a handful of them.
 */
let audioUnsupported = false

/** Non-null only on the SharedArrayBuffer transport. */
let ringView: Float32Array | null = null

let baseSampleRate = SAMPLE_RATE
let targetFill = 0

// postMessage transport only: the worklet reports its fill periodically, and we
// track what we've pushed since that report to keep the estimate current.
let reportedFill = 0
let pushedSinceReport = 0

let driftTimer: ReturnType<typeof setInterval> | null = null
const globalAudioReady = ref(false)

// ── Mute ─────────────────────────────────────────────────────────────────────

/** Web only; Electron keeps this in AppSettings. */
const LS_KEY_MUTED = '6502-emulator-muted'

/**
 * The mute *preference*, restored from the previous session.
 *
 * Read this only for what the gain node should do. It is deliberately not what
 * the mute button renders: before the AudioContext is running nothing is
 * audible whatever this says, so the button derives its icon from
 * `!audioReady || muted` instead. Binding an icon straight to this ref puts the
 * app back to showing a speaker while no sound can come out, which is the
 * confusion the button exists to remove.
 */
const globalMuted = ref(false)

/**
 * A choice made in this session beats one restored from the last. Without this,
 * clicking the muted button on a fresh web load — which starts audio *and*
 * unmutes — could be overwritten a moment later by the stored preference
 * landing, and the click would appear to do nothing.
 */
let muteChosen = false

let hydrateMutePromise: Promise<void> | null = null

async function readMutePreference(): Promise<boolean> {
  if (window.api) {
    try {
      return (await window.api.settings.get()).muted ?? false
    } catch {
      return false
    }
  }
  try {
    return localStorage.getItem(LS_KEY_MUTED) === '1'
  } catch {
    return false // private-mode localStorage throws on access
  }
}

function writeMutePreference(value: boolean): void {
  if (window.api) {
    window.api.settings.set({ muted: value }).catch(() => {})
    return
  }
  try {
    localStorage.setItem(LS_KEY_MUTED, value ? '1' : '0')
  } catch {
    /* quota or private mode — the session still honours the choice */
  }
}

/** Idempotent; the settings read behind it is async on Electron. */
function hydrateMutePreference(): Promise<void> {
  hydrateMutePromise ??= readMutePreference().then((stored) => {
    if (!muteChosen) globalMuted.value = stored
  })
  return hydrateMutePromise
}

function applyGain(): void {
  if (gainNode) gainNode.gain.value = globalMuted.value ? 0 : 1
}

function pushSamples(samples: Float32Array) {
  if (ringView) {
    const cap = RING_BUFFER_CAPACITY
    let writeHead = ringView[0]! | 0
    for (let i = 0; i < samples.length; i++) {
      const nextWrite = (writeHead + 1) % cap
      if (nextWrite === (ringView[1]! | 0)) break
      ringView[2 + writeHead] = samples[i]!
      writeHead = nextWrite
    }
    ringView[0] = writeHead
  } else if (workletNode) {
    pushedSinceReport += samples.length
    // Sound hands us a fresh buffer each flush, so it's safe to transfer.
    workletNode.port.postMessage({ type: 'samples', buffer: samples.buffer }, [samples.buffer])
  }
}

/** Samples currently queued for playback. */
function currentFill(): number {
  if (ringView) {
    const writeHead = ringView[0]! | 0
    const readHead = ringView[1]! | 0
    return (writeHead - readHead + RING_BUFFER_CAPACITY) % RING_BUFFER_CAPACITY
  }
  return reportedFill + pushedSinceReport
}

/** Drop everything queued — used when the machine stops or resets. */
function flushAudio() {
  workletNode?.port.postMessage({ type: 'flush' })
  reportedFill = 0
  pushedSinceReport = 0
}

/**
 * Nudge the emulator's sample rate so the queue settles at targetFill.
 *
 * The emulator produces samples off the system clock and the sound card
 * consumes them off its own; left alone the two drift apart until the queue
 * either empties (dropouts) or pins at its ceiling (permanent lag). Correcting
 * the producer's rate keeps the depth stable without ever dropping audio.
 */
function startDriftControl(emulator: ReturnType<typeof useEmulatorStore>) {
  if (driftTimer) clearInterval(driftTimer)
  driftTimer = setInterval(() => {
    const sound = emulator.getSound()
    if (!sound || targetFill <= 0) return
    const error = (targetFill - currentFill()) / targetFill
    const adjust = Math.max(-MAX_DRIFT, Math.min(MAX_DRIFT, error * MAX_DRIFT))
    sound.sampleRate = baseSampleRate * (1 + adjust)
  }, DRIFT_INTERVAL_MS)
}

/**
 * Safari 16.4+ (iOS, iPadOS, macOS) — the WebKit AudioSession API.
 *
 * Web Audio defaults to the 'auto' session, which on an iPhone or iPad means
 * the *ambient* route: silenced by the ringer switch and by the mute in
 * Control Center, and at the ringer's volume rather than the media volume.
 * That is right for a page that beeps at you and wrong for a machine whose
 * speaker you asked for by name — a muted iPad plays nothing at all through it
 * however healthy the audio graph is, which looks exactly like sound being
 * broken. 'playback' is the route media players take and is not muted by that
 * switch.
 *
 * Feature-detected, and failure is ignored: everywhere else this is simply
 * absent, and nothing else about the graph depends on it.
 */
function claimPlaybackAudioSession(): void {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
  if (!session) return
  try {
    session.type = 'playback'
  } catch {
    /* a browser that has the property but not this value */
  }
}

/**
 * Resolve once the audio graph is genuinely rendering in step with the wall
 * clock.
 *
 * connect() returning, and even the worklet's first process() call, do not mean
 * the graph is running: Chrome renders an opening quantum and can then sit idle
 * for several hundred milliseconds while the output device opens, with
 * currentTime frozen the whole time. Starting the machine during that gap fills
 * the ring to capacity, and the first real render trims all of it away — which
 * is exactly how the BIOS startup beep was being reduced to a blip.
 *
 * Watching currentTime actually advance is the only reliable signal.
 */
async function waitForRunningGraph(ctx: AudioContext, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  let previous = ctx.currentTime
  while (performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, GRAPH_POLL_MS))
    const now = ctx.currentTime
    // Advancing at even half of real time means the device is live.
    if (now > previous + GRAPH_POLL_MS / 2000) return
    previous = now
  }
  // No warning here: the caller reports the outcome, with the context's state,
  // which says rather more than a timeout does about why nothing is playing.
}

export function useAudio() {
  const emulator = useEmulatorStore()

  // Start the read early so the button settles to the stored preference as soon
  // as the graph is up, rather than a frame or two after it.
  void hydrateMutePreference()

  /**
   * Silences the output without touching a single thing the machine can see.
   *
   * `persist: false` is for the embed, whose mute comes from a URL parameter and
   * belongs to that one frame. Writing it back would let an `<iframe>` on a docs
   * page silently reset the mute preference of the full app on the same origin.
   */
  function setMuted(value: boolean, options: { persist?: boolean } = {}): void {
    muteChosen = true
    globalMuted.value = value
    applyGain()
    if (options.persist !== false) writeMutePreference(value)
  }

  function toggleMute(): void {
    setMuted(!globalMuted.value)
  }

  /**
   * Start audio, or revive a context that exists but is not making sound.
   *
   * Must be called from a user gesture on web; may be called freely in
   * Electron. The early return is on the graph *running*, not on the context
   * existing: on iOS a context can be built, wired up and left suspended
   * forever, and returning early on `audioCtx !== null` meant the very first
   * touch consumed the one attempt anyone ever got. Every later tap — the
   * speaker button included — walked into `if (audioCtx) return` and did
   * nothing at all, which is exactly how an iPad ends up with no way to turn
   * the sound on. iOS also suspends the context whenever the tab is
   * backgrounded, so this is the recovery path for that too.
   */
  async function initAudio(): Promise<void> {
    if (audioCtx?.state === 'running' || audioUnsupported) return
    if (initInFlight) return initInFlight

    // Called, not awaited, so that resume() below is reached with the user
    // gesture still in hand: WebKit checks for activation synchronously, and
    // anything after an `await` has already handed it back.
    const attempt = audioCtx ? resume(audioCtx) : start()
    initInFlight = attempt.finally(() => {
      initInFlight = null
    })
    return initInFlight
  }

  /**
   * Second and later attempts: the graph is built, it just isn't pulling.
   *
   * The resume() promise is deliberately not awaited. A browser that has
   * decided this gesture doesn't count may reject it, and Safari may simply
   * never settle it — either way the answer to "did that work" is the same
   * one waitForRunningGraph already asks the clock, and awaiting first risks
   * wedging initInFlight so that no later gesture can even try.
   */
  async function resume(ctx: AudioContext): Promise<void> {
    void ctx.resume().catch(() => {})
    await waitForRunningGraph(ctx, GRAPH_RESUME_TIMEOUT_MS)
    settleReady(ctx)
  }

  async function start(): Promise<void> {
    claimPlaybackAudioSession()

    // No sampleRate constraint: the device's own rate is the one it will never
    // refuse, and Sound is retuned to whatever comes back a few lines down, so
    // asking for 44.1 kHz on hardware that runs at 48 buys a resampler and, on
    // iOS, a context that may decline to start at all.
    const ctx = new AudioContext()
    // Not awaited — see resume() for why the clock, not this promise, is what
    // gets asked whether audio started.
    if (ctx.state !== 'running') void ctx.resume().catch(() => {})

    if (!ctx.audioWorklet) {
      console.warn('[useAudio] AudioWorklet unavailable — running without sound')
      audioUnsupported = true
      await ctx.close()
      disarmGesture?.()
      return
    }

    try {
      await build(ctx)
    } catch (e) {
      // Leave no half-built context behind for the next gesture to trip over,
      // and none of Safari's small allowance of contexts spent on it either.
      await ctx.close().catch(() => {})
      if (audioCtx === ctx) audioCtx = null
      throw e
    }
  }

  /** Everything between a bare AudioContext and a graph that plays samples. */
  async function build(ctx: AudioContext): Promise<void> {
    // Trust the context over our request: if the device forced a different
    // rate, the emulator must produce at that rate or the queue will drift.
    baseSampleRate = ctx.sampleRate
    targetFill = Math.round((baseSampleRate * TARGET_FILL_MS) / 1000)

    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}audio-worklet-processor.js`)

    // Shared memory is the better transport but needs cross-origin isolation,
    // which the web build can't get. Fall back to transferring chunks.
    let sab: SharedArrayBuffer | null = null
    try {
      sab = new SharedArrayBuffer((RING_BUFFER_CAPACITY + 2) * Float32Array.BYTES_PER_ELEMENT)
    } catch {
      sab = null
    }

    workletNode = new AudioWorkletNode(ctx, 'sample-player-processor', {
      outputChannelCount: [1],
      processorOptions: {
        ringBuffer: sab,
        capacity: RING_BUFFER_CAPACITY,
        targetFill,
        maxFill: Math.round((baseSampleRate * MAX_FILL_MS) / 1000),
      },
    })

    if (sab) {
      ringView = new Float32Array(sab)
      ringView[0] = 0
      ringView[1] = 0
    }

    workletNode.port.onmessage = (event) => {
      if (event.data?.type === 'fill') {
        reportedFill = event.data.fill
        pushedSinceReport = 0
      }
    }

    // Know what the speaker should be doing before it is connected, so a muted
    // preference never leaks a quantum of audio on startup.
    await hydrateMutePreference()
    gainNode = new GainNode(ctx, { gain: globalMuted.value ? 0 : 1 })
    workletNode.connect(gainNode).connect(ctx.destination)

    // Keep the context even if it never starts: Safari caps how many an origin
    // may create, and initAudio() resumes this one rather than building
    // another. Everything downstream is wired up now so that a later resume
    // has nothing left to do but start pulling.
    audioCtx = ctx

    const sound = emulator.getSound()
    if (sound) sound.sampleRate = baseSampleRate

    emulator.setPlayCallback(pushSamples)
    emulator.setAudioFlushCallback(flushAudio)
    startDriftControl(emulator)

    // The context's own account of itself, which outlives every wait above.
    //
    // iOS suspends the context when the tab goes to the background and hands it
    // back in Safari's own 'interrupted' state; nothing resumes it on its own,
    // so the button has to go back to offering that and the gesture listeners
    // have to go back on. It is also how a resume that was granted after the
    // caller gave up waiting still reaches the button.
    ctx.addEventListener('statechange', () => {
      if (ctx !== audioCtx) return
      settleReady(ctx)
      if (ctx.state !== 'running') armAudioOnFirstGesture()
    })

    // Hold the caller — and therefore the machine, which App.vue and ControlBar
    // start only after this resolves — until the graph is actually draining.
    await waitForRunningGraph(ctx, GRAPH_START_TIMEOUT_MS)
    settleReady(ctx)
  }

  /**
   * Report what is true rather than what was attempted.
   *
   * `audioReady` drives both the speaker icon and whether a tap on it is read
   * as "enable sound" or "mute" — so latching it on an attempt that produced
   * a suspended context puts the app back to showing a speaker over silence,
   * with no control left that offers to fix it. The gesture listeners come off
   * only once sound is genuinely coming out.
   */
  function settleReady(ctx: AudioContext): void {
    const running = ctx.state === 'running'
    globalAudioReady.value = running
    if (running) disarmGesture?.()
    else console.warn(`[useAudio] audio graph is not running (state: ${ctx.state})`)
  }

  /**
   * Start audio on the first user gesture that a browser will accept.
   *
   * A browser will only let an AudioContext start from a gesture, and until
   * this existed the only thing that called initAudio() was the Run/Stop
   * button. But the machine auto-starts, so that button reads "Stop" — nobody
   * wanting sound has any reason to press it. Clicking Reset, or simply typing,
   * left the emulator running with nowhere to send its samples, which looked
   * exactly like the sound hardware being broken.
   *
   * It is the *first accepted* gesture, not the first gesture: these stay
   * armed until the graph is running. WebKit does not grant activation on
   * every one of these events — 'touchend' and 'click' are the reliable ones
   * on iOS, and a bare 'pointerdown' on an iPad may well be refused — so
   * treating the first one to arrive as the only attempt left an iPad silent
   * for the rest of the session.
   */
  function armAudioOnFirstGesture(): void {
    if (audioCtx?.state === 'running' || audioUnsupported || disarmGesture) return

    // 'click' as well as the pointer events: a synthetic or assistive-technology
    // activation may raise only the former. 'touchend' because that, not
    // 'touchstart', is where WebKit grants a touch its activation.
    const events = ['pointerdown', 'touchstart', 'touchend', 'click', 'keydown'] as const
    const onGesture = (): void => {
      // Listeners are passive and never preventDefault, so the click or
      // keystroke still reaches the machine as normal.
      void initAudio().catch((e) => console.warn('[useAudio] init failed:', e))
    }

    disarmGesture = () => {
      for (const name of events) window.removeEventListener(name, onGesture, true)
      disarmGesture = null
    }

    for (const name of events) {
      window.addEventListener(name, onGesture, { capture: true, passive: true })
    }
  }

  return {
    audioReady: globalAudioReady,
    muted: globalMuted,
    initAudio,
    armAudioOnFirstGesture,
    setMuted,
    toggleMute,
  }
}
