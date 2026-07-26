import { ref } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'

const SAMPLE_RATE = 44_100

/** Ring size. This is headroom for jitter, not the latency we aim to run at. */
const RING_BUFFER_CAPACITY = 16_384

/**
 * Queue depth we steer towards, and the depth at which the worklet gives up and
 * skips forward. The real SID has no buffer at all — a register write is
 * audible within a microsecond — so the goal here is the smallest queue that
 * still absorbs main-thread hitches.
 *
 * The ceiling has to sit close to the target. After a long stall the emulator
 * loop catches up in one burst (up to Machine's 250 ms clamp) and dumps that
 * much audio at once; the drift correction below would take ten seconds to walk
 * that back, so the worklet skips it in one quantum instead.
 */
const TARGET_FILL_MS = 50
const MAX_FILL_MS = 90

/**
 * How far the emulator's sample rate may be pulled to hold the queue at target.
 * 0.5 % is about 8 cents of pitch — inaudible, and enough to absorb the drift
 * between the system clock driving the emulator and the sound card's clock.
 */
const MAX_DRIFT = 0.005
const DRIFT_INTERVAL_MS = 250

// ── Module-level shared audio state ──────────────────────────────────────────
//
// All useAudio() calls across any component share the same AudioContext so
// that: (a) initAudio() is idempotent — the second caller just returns early;
// (b) App.vue can call initAudio() on Electron startup (no user-gesture
//     restriction) while ControlBar can still call it on first user click.

let audioCtx: AudioContext | null = null
let workletNode: AudioWorkletNode | null = null

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

export function useAudio() {
  const emulator = useEmulatorStore()

  /** Must be called from a user gesture on web; may be called freely in Electron. */
  async function initAudio() {
    if (audioCtx) return // already initialised — shared globally

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    if (ctx.state === 'suspended') await ctx.resume()

    if (!ctx.audioWorklet) {
      console.warn('[useAudio] AudioWorklet unavailable — running without sound')
      await ctx.close()
      return
    }

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
    } else {
      workletNode.port.onmessage = (event) => {
        if (event.data?.type === 'fill') {
          reportedFill = event.data.fill
          pushedSinceReport = 0
        }
      }
    }

    workletNode.connect(ctx.destination)
    audioCtx = ctx

    const sound = emulator.getSound()
    if (sound) sound.sampleRate = baseSampleRate

    emulator.setPlayCallback(pushSamples)
    emulator.setAudioFlushCallback(flushAudio)
    startDriftControl(emulator)
    globalAudioReady.value = true
  }

  return { audioReady: globalAudioReady, initAudio }
}
