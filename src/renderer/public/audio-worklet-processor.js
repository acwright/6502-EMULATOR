/**
 * AudioWorklet processor for the emulator's SID output.
 *
 * Owns a ring buffer of samples and drains one render quantum per call. The
 * emulator loop on the main thread is the producer. Two transports are
 * supported, both landing in the same ring:
 *
 *   SharedArrayBuffer — the ring lives in shared memory and the producer writes
 *     into it directly. Zero-copy, no messaging. Used in Electron (the main
 *     process enables the SharedArrayBuffer feature) and on any cross-origin
 *     isolated origin.
 *   postMessage — the producer transfers Float32Array chunks which are appended
 *     here. Used by the web build, which is served from GitHub Pages and so
 *     can't set the COOP/COEP headers SharedArrayBuffer requires.
 *
 * Ring layout (Float32Array, identical for both transports):
 *   [0]             writeHead  — producer only
 *   [1]             readHead   — this processor only
 *   [2..capacity+1] sample data
 *
 * This processor is the only party allowed to move readHead, which makes it the
 * right place to enforce the latency bound. If the queue drifts above maxFill
 * it skips forward to targetFill. Without that, any transient producer lead —
 * notably the time it takes the audio graph to start pulling after connect() —
 * becomes permanent output latency, because nothing else ever shortens the
 * queue.
 */

const HEADER = 2

class SamplePlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const { ringBuffer, capacity, targetFill, maxFill } = options.processorOptions

    this.capacity = capacity
    this.targetFill = targetFill
    this.maxFill = maxFill
    this.shared = !!ringBuffer
    this.ringBuffer = new Float32Array(
      ringBuffer || new ArrayBuffer((capacity + HEADER) * Float32Array.BYTES_PER_ELEMENT)
    )

    // Last sample emitted, used to fade out rather than click on underrun.
    this.lastSample = 0
    this.quantaUntilReport = 0

    // Emit silence until the producer has banked targetFill samples. This is a
    // condition, not a countdown: the machine may not start producing until
    // well after the graph starts pulling, and draining a ring that never had
    // a cushion turns the first fraction of a second — exactly when the BIOS
    // beeps — into a string of dropouts.
    this.priming = true

    this.port.onmessage = (event) => {
      const message = event.data
      if (message.type === 'samples') {
        this.enqueue(new Float32Array(message.buffer))
      } else if (message.type === 'flush') {
        this.ringBuffer[1] = this.ringBuffer[0]
        this.lastSample = 0
        this.priming = true
      }
    }
  }

  fill() {
    const writeHead = this.ringBuffer[0] | 0
    const readHead = this.ringBuffer[1] | 0
    return (writeHead - readHead + this.capacity) % this.capacity
  }

  /** postMessage transport: append a transferred chunk to the ring. */
  enqueue(samples) {
    const rb = this.ringBuffer
    const cap = this.capacity
    const readHead = rb[1] | 0
    let writeHead = rb[0] | 0

    for (let i = 0; i < samples.length; i++) {
      const nextWrite = (writeHead + 1) % cap
      if (nextWrite === readHead) break // full — the trim in process() keeps this rare
      rb[HEADER + writeHead] = samples[i]
      writeHead = nextWrite
    }
    rb[0] = writeHead
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true

    const channel = output[0]
    const rb = this.ringBuffer
    const cap = this.capacity

    // Still building the initial cushion — emit silence and let the ring fill.
    if (this.priming) {
      if (this.fill() < this.targetFill) {
        for (let i = 0; i < channel.length; i++) channel[i] = 0
        return true
      }
      this.priming = false
    }

    // Latency bound. Dropping the oldest audio costs one glitch; keeping it
    // costs lag on every sound from here on.
    const depth = this.fill()
    if (depth > this.maxFill) {
      rb[1] = ((rb[1] | 0) + (depth - this.targetFill)) % cap
    }

    let readHead = rb[1] | 0
    let i = 0
    for (; i < channel.length; i++) {
      if (readHead === (rb[0] | 0)) break
      this.lastSample = rb[HEADER + readHead]
      channel[i] = this.lastSample
      readHead = (readHead + 1) % cap
    }
    rb[1] = readHead

    // Underrun — decay the last value toward zero instead of stepping to
    // silence, so a starved buffer sounds like a dip rather than a click.
    if (i < channel.length) {
      let held = this.lastSample
      for (; i < channel.length; i++) {
        held *= 0.98
        channel[i] = held
      }
      this.lastSample = held
    }

    // With a shared ring the producer reads the fill level itself; over
    // postMessage it has to be told so it can steer its sample rate.
    if (!this.shared && --this.quantaUntilReport <= 0) {
      this.quantaUntilReport = 8
      this.port.postMessage({ type: 'fill', fill: this.fill() })
    }

    return true
  }
}

registerProcessor('sample-player-processor', SamplePlayerProcessor)
