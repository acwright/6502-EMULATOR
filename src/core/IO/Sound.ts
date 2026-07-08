import { IO } from '../IO'

/**
 * MOS 6581 SID (Sound Interface Device) Emulation
 *
 * Register Map ($00-$1C):
 *   Voice 1: $00-$06
 *   Voice 2: $07-$0D
 *   Voice 3: $0E-$14
 *   Filter:  $15-$17
 *   Volume:  $18
 *   Paddle:  $19-$1A (read-only)
 *   OSC 3:   $1B (read-only)
 *   ENV 3:   $1C (read-only)
 *
 * Each voice has:
 *   Frequency  (16-bit, lo/hi)
 *   Pulse Width (12-bit, lo/hi)
 *   Control Register (waveform select, gate, sync, ring mod, test)
 *   Attack/Decay (4-bit each)
 *   Sustain/Release (4-bit each)
 *
 * Waveforms: Triangle, Sawtooth, Pulse, Noise
 * Filter: 12-bit cutoff, resonance, low/band/high-pass, voice routing
 *
 * Clock rate: ~1 MHz (NTSC: 1,022,727 Hz, PAL: 985,248 Hz)
 * Output: mono audio samples passed via callback to the host emulator
 *
 * Reference: MOS 6581 SID datasheet, reSID by Dag Lem
 */

// ================================================================
//  Constants
// ================================================================

/** Default SID clock rate (NTSC) */
export const SID_CLOCK_NTSC = 1022727
export const SID_CLOCK_PAL = 985248

/** Number of SID registers */
const NUM_REGISTERS = 29

// Register offsets within each voice (relative to voice base)
const REG_FREQ_LO = 0
const REG_FREQ_HI = 1
const REG_PW_LO = 2
const REG_PW_HI = 3
const REG_CONTROL = 4
const REG_AD = 5
const REG_SR = 6

// Control register bits
const CTRL_GATE = 0x01
const CTRL_SYNC = 0x02
const CTRL_RING_MOD = 0x04
const CTRL_TEST = 0x08
const CTRL_TRIANGLE = 0x10
const CTRL_SAWTOOTH = 0x20
const CTRL_PULSE = 0x40
const CTRL_NOISE = 0x80

// Global register addresses
const REG_FC_LO = 0x15
const REG_FC_HI = 0x16
const REG_RES_FILT = 0x17
const REG_MODE_VOL = 0x18
const REG_POTX = 0x19
const REG_POTY = 0x1A
const REG_OSC3 = 0x1B
const REG_ENV3 = 0x1C

// ADSR timing tables: cycles per increment/decrement
// Based on the real SID chip's exponential envelope counter rates
// Index = 4-bit register value (0-15)
const ATTACK_RATES: ReadonlyArray<number> = [
  2, 8, 16, 24, 38, 56, 68, 80,
  100, 250, 500, 800, 1000, 3000, 5000, 8000,
]

const DECAY_RELEASE_RATES: ReadonlyArray<number> = [
  6, 24, 48, 72, 114, 168, 204, 240,
  300, 750, 1500, 2400, 3000, 9000, 15000, 24000,
]

// Sustain level table: maps 4-bit value to 8-bit level
const SUSTAIN_LEVELS: ReadonlyArray<number> = [
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
  0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF,
]

// Envelope states
export const enum EnvelopeState {
  ATTACK = 0,
  DECAY = 1,
  SUSTAIN = 2,
  RELEASE = 3,
}

// Filter constants
const FILTER_LOWPASS = 0x10
const FILTER_BANDPASS = 0x20
const FILTER_HIGHPASS = 0x40
const FILTER_3OFF = 0x80

// ================================================================
//  Voice
// ================================================================

export class SIDVoice {
  // Oscillator
  accumulator: number = 0        // 24-bit phase accumulator
  frequency: number = 0          // 16-bit frequency
  pulseWidth: number = 0         // 12-bit pulse width
  control: number = 0            // Control register
  prevGate: boolean = false      // Previous gate state for edge detection

  // Noise LFSR (23-bit, initial value)
  noiseShift: number = 0x7FFFF8  // 23-bit noise shift register

  // Waveform output (12-bit, 0-4095)
  waveformOutput: number = 0

  // Envelope
  envelopeState: EnvelopeState = EnvelopeState.RELEASE
  envelopeLevel: number = 0     // 0-255
  envelopeCounter: number = 0   // Cycle counter for rate timing
  attackRate: number = 0         // 4-bit attack value
  decayRate: number = 0          // 4-bit decay value
  sustainLevel: number = 0       // 4-bit sustain value
  releaseRate: number = 0        // 4-bit release value

  // Exponential counter for decay/release (models SID's exponential behavior)
  exponentialCounter: number = 0
  exponentialCounterPeriod: number = 1

  reset(): void {
    this.accumulator = 0
    this.frequency = 0
    this.pulseWidth = 0
    this.control = 0
    this.prevGate = false
    this.noiseShift = 0x7FFFF8
    this.waveformOutput = 0
    this.envelopeState = EnvelopeState.RELEASE
    this.envelopeLevel = 0
    this.envelopeCounter = 0
    this.attackRate = 0
    this.decayRate = 0
    this.sustainLevel = 0
    this.releaseRate = 0
    this.exponentialCounter = 0
    this.exponentialCounterPeriod = 1
  }
}

// ================================================================
//  Sound (SID)
// ================================================================

export class Sound implements IO {

  /** Callback to push audio samples to the host emulator */
  pushSamples?: (samples: Float32Array) => void

  // ---- SID Internal State ----

  /** Raw register file (write-only from CPU perspective, except reads at $19-$1C) */
  private registers = new Uint8Array(NUM_REGISTERS)

  /** Three oscillator voices */
  private voices: [SIDVoice, SIDVoice, SIDVoice] = [
    new SIDVoice(),
    new SIDVoice(),
    new SIDVoice(),
  ]

  /** Filter state */
  private filterCutoff: number = 0     // 11-bit filter cutoff (register value)
  private filterResonance: number = 0  // 4-bit resonance
  private filterRouting: number = 0    // Which voices feed the filter (bits 0-2)
  private filterMode: number = 0       // LP/BP/HP/3OFF flags
  private masterVolume: number = 0     // 4-bit master volume

  /** Filter integrator state (continuous) */
  private filterLP: number = 0
  private filterBP: number = 0
  private filterHP: number = 0

  /** Cycle accumulator for sample rate conversion */
  private cycleAccumulator: number = 0

  /** Target audio sample rate */
  sampleRate: number = 44100

  /** SID clock rate */
  sidClock: number = SID_CLOCK_NTSC

  /** Internal sample buffer for pushing to host */
  private sampleBuffer: Float32Array = new Float32Array(128)
  private sampleBufferIndex: number = 0

  // ================================================================
  //  IO Interface
  // ================================================================

  read(address: number): number {
    const reg = address & 0x1F

    switch (reg) {
      case REG_POTX:
        return this.registers[REG_POTX]
      case REG_POTY:
        return this.registers[REG_POTY]
      case REG_OSC3:
        // Return upper 8 bits of voice 3 waveform
        return (this.voices[2].waveformOutput >> 4) & 0xFF
      case REG_ENV3:
        // Return voice 3 envelope level
        return this.voices[2].envelopeLevel
      default:
        // All other SID registers are write-only
        return 0
    }
  }

  write(address: number, data: number): void {
    const reg = address & 0x1F
    if (reg >= NUM_REGISTERS) return

    this.registers[reg] = data

    // Update internal state from register writes
    if (reg <= 0x14) {
      // Voice registers
      const voiceIndex = Math.floor(reg / 7) as 0 | 1 | 2
      const voiceReg = reg % 7
      this.updateVoiceRegister(voiceIndex, voiceReg, data)
    } else {
      // Global registers
      this.updateGlobalRegister(reg, data)
    }
  }

  tick(frequency: number): number {
    // SID clock runs at the CPU clock rate
    this.sidClock = frequency

    // Each tick represents 1 SID clock cycle
    this.clockOneCycle()

    // Sample rate conversion: accumulate and downsample
    this.cycleAccumulator += this.sampleRate
    if (this.cycleAccumulator >= this.sidClock) {
      this.cycleAccumulator -= this.sidClock

      const sample = this.generateSample()
      this.sampleBuffer[this.sampleBufferIndex++] = sample

      // Buffer full - push to host
      if (this.sampleBufferIndex >= this.sampleBuffer.length) {
        this.flushSampleBuffer()
      }
    }

    return 0
  }

  reset(coldStart: boolean): void {
    this.registers.fill(0)
    this.voices[0].reset()
    this.voices[1].reset()
    this.voices[2].reset()
    this.filterCutoff = 0
    this.filterResonance = 0
    this.filterRouting = 0
    this.filterMode = 0
    this.masterVolume = 0
    this.filterLP = 0
    this.filterBP = 0
    this.filterHP = 0
    this.cycleAccumulator = 0
    this.sampleBufferIndex = 0
  }

  // ================================================================
  //  Register Update Helpers
  // ================================================================

  private updateVoiceRegister(voiceIndex: number, reg: number, data: number): void {
    const voice = this.voices[voiceIndex]

    switch (reg) {
      case REG_FREQ_LO:
        voice.frequency = (voice.frequency & 0xFF00) | data
        break
      case REG_FREQ_HI:
        voice.frequency = (voice.frequency & 0x00FF) | (data << 8)
        break
      case REG_PW_LO:
        voice.pulseWidth = (voice.pulseWidth & 0x0F00) | data
        break
      case REG_PW_HI:
        voice.pulseWidth = (voice.pulseWidth & 0x00FF) | ((data & 0x0F) << 8)
        break
      case REG_CONTROL: {
        const gate = !!(data & CTRL_GATE)
        const prevGate = voice.prevGate
        voice.control = data

        // Test bit resets accumulator and noise LFSR
        if (data & CTRL_TEST) {
          voice.accumulator = 0
          voice.noiseShift = 0x7FFFF8
        }

        // Gate edge detection
        if (gate && !prevGate) {
          // Gate on: start attack
          voice.envelopeState = EnvelopeState.ATTACK
          voice.envelopeCounter = 0
          voice.exponentialCounter = 0
          voice.exponentialCounterPeriod = 1
        } else if (!gate && prevGate) {
          // Gate off: start release
          voice.envelopeState = EnvelopeState.RELEASE
          voice.envelopeCounter = 0
        }
        voice.prevGate = gate
        break
      }
      case REG_AD:
        voice.attackRate = (data >> 4) & 0x0F
        voice.decayRate = data & 0x0F
        break
      case REG_SR:
        voice.sustainLevel = (data >> 4) & 0x0F
        voice.releaseRate = data & 0x0F
        break
    }
  }

  private updateGlobalRegister(reg: number, data: number): void {
    switch (reg) {
      case REG_FC_LO:
        // Filter cutoff low 3 bits
        this.filterCutoff = (this.filterCutoff & 0x7F8) | (data & 0x07)
        break
      case REG_FC_HI:
        // Filter cutoff high 8 bits
        this.filterCutoff = (this.filterCutoff & 0x07) | (data << 3)
        break
      case REG_RES_FILT:
        this.filterResonance = (data >> 4) & 0x0F
        this.filterRouting = data & 0x0F  // bits 0-2: voice routing, bit 3: external input
        break
      case REG_MODE_VOL:
        this.filterMode = data & 0xF0
        this.masterVolume = data & 0x0F
        break
    }
  }

  // ================================================================
  //  Clock / Oscillator
  // ================================================================

  private clockOneCycle(): void {
    for (let i = 0; i < 3; i++) {
      this.clockOscillator(i)
      this.clockEnvelope(i)
    }
  }

  private clockOscillator(voiceIndex: number): void {
    const voice = this.voices[voiceIndex]

    // Don't clock if test bit is set
    if (voice.control & CTRL_TEST) return

    const prevAccBit19 = (voice.accumulator >> 19) & 1

    // Advance phase accumulator (24-bit)
    voice.accumulator = (voice.accumulator + voice.frequency) & 0xFFFFFF

    const currAccBit19 = (voice.accumulator >> 19) & 1

    // Clock noise LFSR on bit 19 transition (0->1)
    if (!prevAccBit19 && currAccBit19) {
      // LFSR feedback: bit 17 XOR bit 22
      const bit0 = ((voice.noiseShift >> 17) ^ (voice.noiseShift >> 22)) & 1
      voice.noiseShift = ((voice.noiseShift << 1) | bit0) & 0x7FFFFF
    }

    // Hard sync: if this voice syncs to the previous voice,
    // reset accumulator when sync source MSB transitions 0->1
    if (voice.control & CTRL_SYNC) {
      const syncSource = this.voices[(voiceIndex + 2) % 3]
      const prevMSB = ((syncSource.accumulator - syncSource.frequency) >> 23) & 1
      const currMSB = (syncSource.accumulator >> 23) & 1
      if (!prevMSB && currMSB) {
        voice.accumulator = 0
      }
    }

    // Generate waveform output (12-bit, 0-4095)
    voice.waveformOutput = this.generateWaveform(voiceIndex)
  }

  private generateWaveform(voiceIndex: number): number {
    const voice = this.voices[voiceIndex]
    const acc = voice.accumulator
    const control = voice.control

    // No waveform selected: output 0
    if (!(control & 0xF0)) return 0

    let output = 0
    let waveformCount = 0

    // Triangle waveform (12-bit)
    if (control & CTRL_TRIANGLE) {
      let tri: number

      // Ring modulation: XOR with MSB of modulating voice
      if (control & CTRL_RING_MOD) {
        const modVoice = this.voices[(voiceIndex + 2) % 3]
        const msb = ((acc >> 23) ^ (modVoice.accumulator >> 23)) & 1
        tri = msb
          ? (~(acc >> 11) & 0xFFF)
          : ((acc >> 11) & 0xFFF)
      } else {
        const msb = (acc >> 23) & 1
        tri = msb
          ? (~(acc >> 11) & 0xFFF)
          : ((acc >> 11) & 0xFFF)
      }

      output |= tri
      waveformCount++
    }

    // Sawtooth waveform (12-bit)
    if (control & CTRL_SAWTOOTH) {
      const saw = (acc >> 12) & 0xFFF
      if (waveformCount > 0) {
        output &= saw  // Combined waveforms use AND (SID behavior)
      } else {
        output = saw
      }
      waveformCount++
    }

    // Pulse waveform (12-bit)
    if (control & CTRL_PULSE) {
      const testBit = !!(control & CTRL_TEST)
      const pulse = testBit
        ? 0xFFF  // Test bit forces pulse high
        : ((acc >> 12) >= voice.pulseWidth ? 0xFFF : 0x000)
      if (waveformCount > 0) {
        output &= pulse
      } else {
        output = pulse
      }
      waveformCount++
    }

    // Noise waveform (12-bit, selected bits from LFSR)
    if (control & CTRL_NOISE) {
      // Extract bits from noise shift register
      const noise =
        ((voice.noiseShift >> 12) & 0x800) |
        ((voice.noiseShift >> 10) & 0x400) |
        ((voice.noiseShift >> 7) & 0x200) |
        ((voice.noiseShift >> 5) & 0x100) |
        ((voice.noiseShift >> 4) & 0x080) |
        ((voice.noiseShift >> 1) & 0x040) |
        ((voice.noiseShift << 1) & 0x020) |
        ((voice.noiseShift << 2) & 0x010)

      if (waveformCount > 0) {
        output &= noise
      } else {
        output = noise
      }
      waveformCount++
    }

    return output & 0xFFF
  }

  // ================================================================
  //  Envelope Generator (ADSR)
  // ================================================================

  private clockEnvelope(voiceIndex: number): void {
    const voice = this.voices[voiceIndex]

    voice.envelopeCounter++

    switch (voice.envelopeState) {
      case EnvelopeState.ATTACK: {
        const rate = ATTACK_RATES[voice.attackRate]
        if (voice.envelopeCounter >= rate) {
          voice.envelopeCounter = 0
          voice.envelopeLevel++
          if (voice.envelopeLevel >= 0xFF) {
            voice.envelopeLevel = 0xFF
            voice.envelopeState = EnvelopeState.DECAY
            voice.envelopeCounter = 0
            voice.exponentialCounter = 0
            this.updateExponentialPeriod(voice)
          }
        }
        break
      }

      case EnvelopeState.DECAY: {
        const rate = DECAY_RELEASE_RATES[voice.decayRate]
        if (voice.envelopeCounter >= rate) {
          voice.envelopeCounter = 0
          voice.exponentialCounter++

          if (voice.exponentialCounter >= voice.exponentialCounterPeriod) {
            voice.exponentialCounter = 0

            if (voice.envelopeLevel > SUSTAIN_LEVELS[voice.sustainLevel]) {
              voice.envelopeLevel--
              this.updateExponentialPeriod(voice)
            }

            if (voice.envelopeLevel <= SUSTAIN_LEVELS[voice.sustainLevel]) {
              voice.envelopeLevel = SUSTAIN_LEVELS[voice.sustainLevel]
              voice.envelopeState = EnvelopeState.SUSTAIN
            }
          }
        }
        break
      }

      case EnvelopeState.SUSTAIN:
        // Sustain stays at level until gate off
        // Level tracks changes to sustain register
        voice.envelopeLevel = SUSTAIN_LEVELS[voice.sustainLevel]
        break

      case EnvelopeState.RELEASE: {
        const rate = DECAY_RELEASE_RATES[voice.releaseRate]
        if (voice.envelopeCounter >= rate) {
          voice.envelopeCounter = 0
          voice.exponentialCounter++

          if (voice.exponentialCounter >= voice.exponentialCounterPeriod) {
            voice.exponentialCounter = 0

            if (voice.envelopeLevel > 0) {
              voice.envelopeLevel--
              this.updateExponentialPeriod(voice)
            }
          }
        }
        break
      }
    }
  }

  /**
   * Update the exponential counter period based on current envelope level.
   * The real SID uses an exponential curve for decay/release by varying
   * the counter period at specific envelope level thresholds.
   */
  private updateExponentialPeriod(voice: SIDVoice): void {
    if (voice.envelopeLevel >= 0x5D) {
      voice.exponentialCounterPeriod = 1
    } else if (voice.envelopeLevel >= 0x36) {
      voice.exponentialCounterPeriod = 2
    } else if (voice.envelopeLevel >= 0x1A) {
      voice.exponentialCounterPeriod = 4
    } else if (voice.envelopeLevel >= 0x0E) {
      voice.exponentialCounterPeriod = 8
    } else if (voice.envelopeLevel >= 0x06) {
      voice.exponentialCounterPeriod = 16
    } else if (voice.envelopeLevel >= 0x00) {
      voice.exponentialCounterPeriod = 30
    }
  }

  // ================================================================
  //  Sample Generation & Filter
  // ================================================================

  private generateSample(): number {
    let filtered = 0
    let direct = 0

    for (let i = 0; i < 3; i++) {
      const voice = this.voices[i]

      // Voice output: waveform (12-bit) * envelope (8-bit)
      // Center around zero: subtract 0x800 from waveform to make it bipolar
      const waveform = voice.waveformOutput - 0x800
      const output = (waveform * voice.envelopeLevel) / 256

      // Voice 3 mute (3OFF bit) - mutes voice 3 from audio but envelope still runs
      if (i === 2 && (this.filterMode & FILTER_3OFF) && !(this.filterRouting & (1 << 2))) {
        continue
      }

      // Route to filter or direct output
      if (this.filterRouting & (1 << i)) {
        filtered += output
      } else {
        direct += output
      }
    }

    // Apply state-variable filter (SVF)
    const cutoffFreq = this.computeFilterCutoff()
    const w0 = (2 * Math.PI * cutoffFreq) / this.sampleRate
    const f = Math.min(w0, 0.9)  // Clamp to avoid instability

    // Resonance: Q ranges from ~0.7 to ~20 as register goes 0-15
    const q = 1.0 / (1.0 - (this.filterResonance / 17.0))

    // State variable filter update
    this.filterHP = filtered - this.filterLP - (this.filterBP / q)
    this.filterBP += f * this.filterHP
    this.filterLP += f * this.filterBP

    // Sum selected filter outputs
    let filterOutput = 0
    if (this.filterMode & FILTER_LOWPASS) filterOutput += this.filterLP
    if (this.filterMode & FILTER_BANDPASS) filterOutput += this.filterBP
    if (this.filterMode & FILTER_HIGHPASS) filterOutput += this.filterHP

    // Mix filtered and direct, apply master volume
    const mixed = (filterOutput + direct) * (this.masterVolume / 15)

    // Normalize to -1..1 range
    const normalized = mixed / 4096

    // Clamp
    return Math.max(-1, Math.min(1, normalized))
  }

  /**
   * Convert the 11-bit filter cutoff register value to a frequency in Hz.
   * The SID's cutoff mapping is complex and varies between chips.
   * This approximation covers the usable range (~30 Hz to ~12 kHz).
   */
  private computeFilterCutoff(): number {
    const fc = this.filterCutoff
    if (fc === 0) return 30

    // Piecewise approximation matching 6581 filter characteristics
    const base = 30
    const maxFreq = 12000
    const normalized = fc / 2047
    return base + (maxFreq - base) * normalized * normalized
  }

  // ================================================================
  //  Sample Buffer Management
  // ================================================================

  private flushSampleBuffer(): void {
    if (this.pushSamples && this.sampleBufferIndex > 0) {
      const samples = this.sampleBuffer.subarray(0, this.sampleBufferIndex)
      this.pushSamples(new Float32Array(samples))
    }
    this.sampleBufferIndex = 0
  }

  // ================================================================
  //  Getters for testing / debug
  // ================================================================

  /** Get a voice for inspection */
  getVoice(index: number): SIDVoice {
    return this.voices[index]
  }

  /** Get current register value */
  getRegister(reg: number): number {
    return this.registers[reg & 0x1F]
  }

  /** Get current filter cutoff frequency in Hz */
  getFilterCutoffHz(): number {
    return this.computeFilterCutoff()
  }

  /** Get master volume (0-15) */
  getMasterVolume(): number {
    return this.masterVolume
  }

  /** Get filter routing bitmask */
  getFilterRouting(): number {
    return this.filterRouting
  }
}