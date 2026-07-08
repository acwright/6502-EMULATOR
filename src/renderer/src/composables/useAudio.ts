import { ref } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'

const SAMPLE_RATE = 44_100
const RING_BUFFER_CAPACITY = 8192

// ── Module-level shared audio state ──────────────────────────────────────────
//
// All useAudio() calls across any component share the same AudioContext so
// that: (a) initAudio() is idempotent — the second caller just returns early;
// (b) App.vue can call initAudio() on Electron startup (no user-gesture
//     restriction) while ControlBar can still call it on first user click.

let audioCtx: AudioContext | null = null
let ringView: Float32Array | null = null
let workletNode: AudioWorkletNode | null = null
let scriptNode: ScriptProcessorNode | null = null
let fallbackQueue: Float32Array[] = []
let fallbackReadOffset = 0
const globalAudioReady = ref(false)

function pushSamples(samples: Float32Array) {
  if (ringView) {
    const cap = RING_BUFFER_CAPACITY
    let writeHead = ringView[0]! | 0
    for (let i = 0; i < samples.length; i++) {
      const nextWrite = (writeHead + 1) % cap
      const readHead = ringView[1]! | 0
      if (nextWrite === readHead) break
      ringView[2 + writeHead] = samples[i]!
      writeHead = nextWrite
    }
    ringView[0] = writeHead
  } else {
    fallbackQueue.push(new Float32Array(samples))
  }
}

async function initWorklet(ctx: AudioContext): Promise<boolean> {
  try {
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}audio-worklet-processor.js`)
    const sab = new SharedArrayBuffer((RING_BUFFER_CAPACITY + 2) * Float32Array.BYTES_PER_ELEMENT)
    ringView = new Float32Array(sab)
    ringView[0] = 0
    ringView[1] = 0
    workletNode = new AudioWorkletNode(ctx, 'sample-player-processor', {
      processorOptions: { ringBuffer: sab, capacity: RING_BUFFER_CAPACITY },
    })
    workletNode.connect(ctx.destination)
    return true
  } catch {
    return false
  }
}

function initScriptProcessor(ctx: AudioContext) {
  scriptNode = ctx.createScriptProcessor(2048, 0, 1)
  scriptNode.onaudioprocess = (e) => {
    const output = e.outputBuffer.getChannelData(0)
    let written = 0
    while (written < output.length && fallbackQueue.length > 0) {
      const chunk = fallbackQueue[0]!
      const remaining = chunk.length - fallbackReadOffset
      const toCopy = Math.min(remaining, output.length - written)
      output.set(chunk.subarray(fallbackReadOffset, fallbackReadOffset + toCopy), written)
      written += toCopy
      fallbackReadOffset += toCopy
      if (fallbackReadOffset >= chunk.length) {
        fallbackQueue.shift()
        fallbackReadOffset = 0
      }
    }
    for (let i = written; i < output.length; i++) output[i] = 0
  }
  scriptNode.connect(ctx.destination)
}

export function useAudio() {
  const emulator = useEmulatorStore()

  /** Must be called from a user gesture on web; may be called freely in Electron. */
  async function initAudio() {
    if (audioCtx) return  // already initialised — shared globally

    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
    if (audioCtx.state === 'suspended') await audioCtx.resume()

    const workletOk = await initWorklet(audioCtx)
    if (!workletOk) initScriptProcessor(audioCtx)

    emulator.setPlayCallback(pushSamples)
    globalAudioReady.value = true
  }

  return { audioReady: globalAudioReady, initAudio }
}
