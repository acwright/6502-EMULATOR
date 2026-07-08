/**
 * AudioWorklet processor that pulls samples from a SharedArrayBuffer ring buffer.
 * The main thread pushes samples into the ring buffer; this processor reads them out
 * each audio render quantum (128 frames).
 *
 * Ring buffer layout (Float32Array over SharedArrayBuffer):
 *   [0]          = writeHead (float-encoded integer)
 *   [1]          = readHead  (float-encoded integer)
 *   [2..capacity+1] = sample data
 */
class SamplePlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const { ringBuffer, capacity } = options.processorOptions
    this.capacity = capacity
    this.ringBuffer = new Float32Array(ringBuffer)
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true

    const channel = output[0]
    const rb = this.ringBuffer
    const cap = this.capacity
    let readHead = rb[1] | 0

    for (let i = 0; i < channel.length; i++) {
      const writeHead = rb[0] | 0
      if (readHead !== writeHead) {
        channel[i] = rb[2 + readHead]
        readHead = (readHead + 1) % cap
      } else {
        channel[i] = 0
      }
    }

    rb[1] = readHead
    return true
  }
}

registerProcessor('sample-player-processor', SamplePlayerProcessor)
