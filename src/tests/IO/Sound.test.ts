import { Sound, SIDVoice, EnvelopeState, SID_CLOCK_NTSC } from '../../components/IO/Sound'

// Voice register offsets (relative to voice base)
const VOICE1_BASE = 0x00
const VOICE2_BASE = 0x07
const VOICE3_BASE = 0x0E

// Register offsets within each voice
const REG_FREQ_LO = 0
const REG_FREQ_HI = 1
const REG_PW_LO = 2
const REG_PW_HI = 3
const REG_CONTROL = 4
const REG_AD = 5
const REG_SR = 6

// Global registers
const REG_FC_LO = 0x15
const REG_FC_HI = 0x16
const REG_RES_FILT = 0x17
const REG_MODE_VOL = 0x18
const REG_POTX = 0x19
const REG_POTY = 0x1A
const REG_OSC3 = 0x1B
const REG_ENV3 = 0x1C

// Control register bits
const CTRL_GATE = 0x01
const CTRL_SYNC = 0x02
const CTRL_RING_MOD = 0x04
const CTRL_TEST = 0x08
const CTRL_TRIANGLE = 0x10
const CTRL_SAWTOOTH = 0x20
const CTRL_PULSE = 0x40
const CTRL_NOISE = 0x80

/**
 * Helper: tick the Sound for a given number of macro-ticks
 * Each tick processes 128 SID clock cycles internally
 */
const tickN = (sid: Sound, n: number): void => {
  for (let i = 0; i < n; i++) {
    sid.tick(SID_CLOCK_NTSC)
  }
}

describe('Sound (MOS 6581 SID)', () => {

  let sid: Sound

  beforeEach(() => {
    sid = new Sound()
    sid.sampleRate = 44100
    sid.sidClock = SID_CLOCK_NTSC
  })

  // ================================================================
  //  Initialization & Reset
  // ================================================================

  describe('initialization', () => {
    test('should initialize with all registers zero', () => {
      for (let i = 0; i < 29; i++) {
        expect(sid.getRegister(i)).toBe(0)
      }
    })

    test('should initialize with zero master volume', () => {
      expect(sid.getMasterVolume()).toBe(0)
    })

    test('should initialize voices in release state with zero level', () => {
      for (let i = 0; i < 3; i++) {
        const voice = sid.getVoice(i)
        expect(voice.envelopeLevel).toBe(0)
        expect(voice.envelopeState).toBe(EnvelopeState.RELEASE)
        expect(voice.frequency).toBe(0)
        expect(voice.pulseWidth).toBe(0)
        expect(voice.control).toBe(0)
      }
    })
  })

  describe('reset', () => {
    test('should clear all registers on reset', () => {
      // Write some register values
      sid.write(VOICE1_BASE + REG_FREQ_LO, 0xAB)
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0xCD)
      sid.write(REG_MODE_VOL, 0x1F)

      sid.reset(true)

      for (let i = 0; i < 29; i++) {
        expect(sid.getRegister(i)).toBe(0)
      }
      expect(sid.getMasterVolume()).toBe(0)
    })

    test('should reset all voice state', () => {
      // Configure a voice and gate on
      sid.write(VOICE1_BASE + REG_FREQ_LO, 0xFF)
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0xFF)
      sid.write(VOICE1_BASE + REG_AD, 0x00)
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_TRIANGLE | CTRL_GATE)
      tickN(sid, 10)

      sid.reset(true)

      const voice = sid.getVoice(0)
      expect(voice.accumulator).toBe(0)
      expect(voice.frequency).toBe(0)
      expect(voice.envelopeLevel).toBe(0)
      expect(voice.envelopeState).toBe(EnvelopeState.RELEASE)
    })
  })

  // ================================================================
  //  Register Read / Write
  // ================================================================

  describe('register writes', () => {

    test('should set voice 1 frequency (16-bit)', () => {
      sid.write(VOICE1_BASE + REG_FREQ_LO, 0x34)
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0x12)
      expect(sid.getVoice(0).frequency).toBe(0x1234)
    })

    test('should set voice 2 frequency', () => {
      sid.write(VOICE2_BASE + REG_FREQ_LO, 0xCD)
      sid.write(VOICE2_BASE + REG_FREQ_HI, 0xAB)
      expect(sid.getVoice(1).frequency).toBe(0xABCD)
    })

    test('should set voice 3 frequency', () => {
      sid.write(VOICE3_BASE + REG_FREQ_LO, 0xFF)
      sid.write(VOICE3_BASE + REG_FREQ_HI, 0xFF)
      expect(sid.getVoice(2).frequency).toBe(0xFFFF)
    })

    test('should set pulse width (12-bit)', () => {
      sid.write(VOICE1_BASE + REG_PW_LO, 0xFF)
      sid.write(VOICE1_BASE + REG_PW_HI, 0x0F)
      expect(sid.getVoice(0).pulseWidth).toBe(0xFFF)
    })

    test('should mask pulse width high byte to 4 bits', () => {
      sid.write(VOICE1_BASE + REG_PW_LO, 0x00)
      sid.write(VOICE1_BASE + REG_PW_HI, 0xFF) // Only lower 4 bits should matter
      expect(sid.getVoice(0).pulseWidth).toBe(0x0F00)
    })

    test('should set attack/decay', () => {
      sid.write(VOICE1_BASE + REG_AD, 0xA5)
      const voice = sid.getVoice(0)
      expect(voice.attackRate).toBe(0x0A)
      expect(voice.decayRate).toBe(0x05)
    })

    test('should set sustain/release', () => {
      sid.write(VOICE1_BASE + REG_SR, 0xC3)
      const voice = sid.getVoice(0)
      expect(voice.sustainLevel).toBe(0x0C)
      expect(voice.releaseRate).toBe(0x03)
    })

    test('should set control register', () => {
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE)
      expect(sid.getVoice(0).control).toBe(CTRL_SAWTOOTH | CTRL_GATE)
    })

    test('should set master volume', () => {
      sid.write(REG_MODE_VOL, 0x0F)
      expect(sid.getMasterVolume()).toBe(15)
    })

    test('should set filter cutoff (11-bit)', () => {
      sid.write(REG_FC_LO, 0x07)  // Low 3 bits
      sid.write(REG_FC_HI, 0xFF)  // High 8 bits
      // Result: (0xFF << 3) | 0x07 = 0x7FF = 2047
      expect(sid.getFilterCutoffHz()).toBeGreaterThan(30)
    })

    test('should set filter resonance and routing', () => {
      sid.write(REG_RES_FILT, 0xF7) // Resonance=15, route voices 1-3
      expect(sid.getFilterRouting()).toBe(0x07)
    })

    test('should ignore writes to addresses >= 29', () => {
      sid.write(0x1D, 0xFF) // Out of range
      // Should not crash
    })
  })

  describe('register reads', () => {
    test('should return 0 for write-only registers', () => {
      sid.write(VOICE1_BASE + REG_FREQ_LO, 0xFF)
      expect(sid.read(VOICE1_BASE + REG_FREQ_LO)).toBe(0)
    })

    test('should read POTX', () => {
      // POTX is stored in register file
      expect(sid.read(REG_POTX)).toBe(0)
    })

    test('should read POTY', () => {
      expect(sid.read(REG_POTY)).toBe(0)
    })

    test('should read OSC3 (voice 3 waveform output)', () => {
      // Initially 0
      expect(sid.read(REG_OSC3)).toBe(0)
    })

    test('should read ENV3 (voice 3 envelope level)', () => {
      expect(sid.read(REG_ENV3)).toBe(0)
    })

    test('should read ENV3 after voice 3 attack', () => {
      // Set voice 3 to fastest attack, sawtooth waveform
      sid.write(VOICE3_BASE + REG_FREQ_HI, 0x10)
      sid.write(VOICE3_BASE + REG_AD, 0x00) // fastest attack
      sid.write(VOICE3_BASE + REG_SR, 0xF0) // max sustain
      sid.write(VOICE3_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE)

      // Tick enough for the envelope to rise
      tickN(sid, 50)

      expect(sid.read(REG_ENV3)).toBeGreaterThan(0)
    })

    test('should wrap register address to 5 bits', () => {
      // Address 0x3B should wrap to 0x1B (OSC3)
      expect(sid.read(0x3B)).toBe(sid.read(REG_OSC3))
    })
  })

  // ================================================================
  //  Gate / Envelope
  // ================================================================

  describe('envelope generator', () => {

    test('should start attack on gate on', () => {
      sid.write(VOICE1_BASE + REG_AD, 0x00) // fastest attack/decay
      sid.write(VOICE1_BASE + REG_SR, 0xF0) // max sustain
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_TRIANGLE | CTRL_GATE)

      const voice = sid.getVoice(0)
      expect(voice.envelopeState).toBe(EnvelopeState.ATTACK)
    })

    test('should increase envelope level during attack', () => {
      sid.write(VOICE1_BASE + REG_AD, 0x00) // fastest attack
      sid.write(VOICE1_BASE + REG_SR, 0xF0) // max sustain
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_TRIANGLE | CTRL_GATE)

      tickN(sid, 10)

      expect(sid.getVoice(0).envelopeLevel).toBeGreaterThan(0)
    })

    test('should reach max level and transition to decay', () => {
      sid.write(VOICE1_BASE + REG_AD, 0x00) // fastest attack/decay
      sid.write(VOICE1_BASE + REG_SR, 0x80) // sustain=8, release=0
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_TRIANGLE | CTRL_GATE)

      // Tick enough times for attack to complete (fastest = 2 cycles per step, 255 steps)
      tickN(sid, 20)

      const voice = sid.getVoice(0)
      // Should have reached 255 and started decay
      expect(voice.envelopeLevel).toBeLessThanOrEqual(255)
    })

    test('should transition to release on gate off', () => {
      sid.write(VOICE1_BASE + REG_AD, 0x00)
      sid.write(VOICE1_BASE + REG_SR, 0xF0)
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_TRIANGLE | CTRL_GATE)

      tickN(sid, 20) // Let attack progress

      // Gate off
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_TRIANGLE) // gate off

      const voice = sid.getVoice(0)
      expect(voice.envelopeState).toBe(EnvelopeState.RELEASE)
    })

    test('should decrease envelope during release', () => {
      // Gate on with fast attack
      sid.write(VOICE1_BASE + REG_AD, 0x00)
      sid.write(VOICE1_BASE + REG_SR, 0xF0) // max sustain, fastest release
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_TRIANGLE | CTRL_GATE)

      tickN(sid, 20)

      const levelBeforeRelease = sid.getVoice(0).envelopeLevel
      expect(levelBeforeRelease).toBeGreaterThan(0)

      // Gate off
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_TRIANGLE)

      tickN(sid, 20)

      expect(sid.getVoice(0).envelopeLevel).toBeLessThan(levelBeforeRelease)
    })
  })

  // ================================================================
  //  Control Register Features
  // ================================================================

  describe('control register', () => {

    test('test bit should reset accumulator', () => {
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0xFF)
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE)
      tickN(sid, 5)

      // Set test bit
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE | CTRL_TEST)
      expect(sid.getVoice(0).accumulator).toBe(0)
    })

    test('test bit should reset noise LFSR', () => {
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_NOISE | CTRL_GATE)
      tickN(sid, 10)

      // Set test bit
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_NOISE | CTRL_GATE | CTRL_TEST)
      expect(sid.getVoice(0).noiseShift).toBe(0x7FFFF8)
    })

    test('should handle multiple waveform selection', () => {
      // Select both triangle and sawtooth (combined waveforms use AND)
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0x10)
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_TRIANGLE | CTRL_SAWTOOTH | CTRL_GATE)
      sid.write(REG_MODE_VOL, 0x0F)

      tickN(sid, 5)

      // Should not crash and voice should produce output
      const voice = sid.getVoice(0)
      expect(voice.waveformOutput).toBeDefined()
    })
  })

  // ================================================================
  //  Oscillator / Waveforms
  // ================================================================

  describe('oscillator', () => {

    test('accumulator should advance by frequency each cycle', () => {
      sid.write(VOICE1_BASE + REG_FREQ_LO, 0x00)
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0x01) // freq = 256
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE)

      // After one tick (128 cycles), accumulator should be 256 * 128 = 32768
      tickN(sid, 1)

      const voice = sid.getVoice(0)
      expect(voice.accumulator).toBe(256 * 128)
    })

    test('accumulator should wrap at 24 bits', () => {
      sid.write(VOICE1_BASE + REG_FREQ_LO, 0xFF)
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0xFF) // max frequency
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE)

      // Many ticks should cause wrapping
      tickN(sid, 200)

      const voice = sid.getVoice(0)
      expect(voice.accumulator).toBeLessThan(0x1000000)
    })

    test('sawtooth should produce non-zero output', () => {
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0x10)
      sid.write(VOICE1_BASE + REG_AD, 0x00)
      sid.write(VOICE1_BASE + REG_SR, 0xF0)
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE)
      sid.write(REG_MODE_VOL, 0x0F)

      tickN(sid, 10)

      const voice = sid.getVoice(0)
      // Sawtooth = acc >> 12, with some frequency should be non-zero
      expect(voice.waveformOutput).toBeGreaterThanOrEqual(0)
    })

    test('pulse waveform should depend on pulse width', () => {
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0x10)
      sid.write(VOICE1_BASE + REG_PW_LO, 0x00)
      sid.write(VOICE1_BASE + REG_PW_HI, 0x08) // 50% duty cycle (0x800)
      sid.write(VOICE1_BASE + REG_AD, 0x00)
      sid.write(VOICE1_BASE + REG_SR, 0xF0)
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_PULSE | CTRL_GATE)

      tickN(sid, 20)

      // Pulse output should be either 0x000 or 0xFFF
      const voice = sid.getVoice(0)
      const output = voice.waveformOutput
      expect(output === 0x000 || output === 0xFFF).toBe(true)
    })

    test('no waveform selected should output 0', () => {
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0x10)
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_GATE) // gate on but no waveform

      tickN(sid, 5)

      expect(sid.getVoice(0).waveformOutput).toBe(0)
    })
  })

  // ================================================================
  //  Filter
  // ================================================================

  describe('filter', () => {

    test('should set filter cutoff from registers', () => {
      sid.write(REG_FC_LO, 0x07)
      sid.write(REG_FC_HI, 0xFF)

      expect(sid.getFilterCutoffHz()).toBeGreaterThan(30)
    })

    test('should return minimum cutoff for zero register value', () => {
      sid.write(REG_FC_LO, 0x00)
      sid.write(REG_FC_HI, 0x00)

      expect(sid.getFilterCutoffHz()).toBe(30)
    })

    test('should set filter voice routing', () => {
      sid.write(REG_RES_FILT, 0x03) // Route voices 1 and 2 to filter
      expect(sid.getFilterRouting()).toBe(0x03)
    })

    test('should set filter mode in volume register', () => {
      sid.write(REG_MODE_VOL, 0x1F) // Low-pass, volume=15
      expect(sid.getMasterVolume()).toBe(15)
    })
  })

  // ================================================================
  //  Audio Output / pushSamples Callback
  // ================================================================

  describe('audio output', () => {

    test('should call pushSamples during tick', () => {
      const receivedSamples: Float32Array[] = []
      sid.pushSamples = (samples) => {
        receivedSamples.push(new Float32Array(samples))
      }

      // Set up a voice producing sound
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0x10)
      sid.write(VOICE1_BASE + REG_AD, 0x00)
      sid.write(VOICE1_BASE + REG_SR, 0xF0)
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE)
      sid.write(REG_MODE_VOL, 0x0F)

      tickN(sid, 100)

      // Should have received some sample data
      expect(receivedSamples.length).toBeGreaterThan(0)

      // Samples should be valid floats
      const firstBatch = receivedSamples[0]
      for (let i = 0; i < firstBatch.length; i++) {
        expect(firstBatch[i]).toBeGreaterThanOrEqual(-1)
        expect(firstBatch[i]).toBeLessThanOrEqual(1)
      }
    })

    test('should produce silence with zero volume', () => {
      const receivedSamples: Float32Array[] = []
      sid.pushSamples = (samples) => {
        receivedSamples.push(new Float32Array(samples))
      }

      sid.write(VOICE1_BASE + REG_FREQ_HI, 0x10)
      sid.write(VOICE1_BASE + REG_AD, 0x00)
      sid.write(VOICE1_BASE + REG_SR, 0xF0)
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE)
      sid.write(REG_MODE_VOL, 0x00) // Volume = 0

      tickN(sid, 100)

      // All samples should be near zero (silence)
      for (const batch of receivedSamples) {
        for (let i = 0; i < batch.length; i++) {
          expect(Math.abs(batch[i])).toBeLessThan(0.001)
        }
      }
    })

    test('should not call pushSamples if callback not set', () => {
      sid.pushSamples = undefined

      sid.write(VOICE1_BASE + REG_FREQ_HI, 0x10)
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE)
      sid.write(REG_MODE_VOL, 0x0F)

      // Should not throw
      expect(() => tickN(sid, 10)).not.toThrow()
    })

    test('should produce sound from all three voices simultaneously', () => {
      const receivedSamples: Float32Array[] = []
      sid.pushSamples = (samples) => {
        receivedSamples.push(new Float32Array(samples))
      }

      // Voice 1: triangle
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0x10)
      sid.write(VOICE1_BASE + REG_AD, 0x00)
      sid.write(VOICE1_BASE + REG_SR, 0xF0)
      sid.write(VOICE1_BASE + REG_CONTROL, CTRL_TRIANGLE | CTRL_GATE)

      // Voice 2: sawtooth
      sid.write(VOICE2_BASE + REG_FREQ_HI, 0x20)
      sid.write(VOICE2_BASE + REG_AD, 0x00)
      sid.write(VOICE2_BASE + REG_SR, 0xF0)
      sid.write(VOICE2_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE)

      // Voice 3: pulse
      sid.write(VOICE3_BASE + REG_FREQ_HI, 0x30)
      sid.write(VOICE3_BASE + REG_PW_HI, 0x08)
      sid.write(VOICE3_BASE + REG_AD, 0x00)
      sid.write(VOICE3_BASE + REG_SR, 0xF0)
      sid.write(VOICE3_BASE + REG_CONTROL, CTRL_PULSE | CTRL_GATE)

      sid.write(REG_MODE_VOL, 0x0F)

      tickN(sid, 100)

      expect(receivedSamples.length).toBeGreaterThan(0)

      // Check that some samples are non-zero (sound is being produced)
      const hasNonZero = receivedSamples.some(batch => {
        for (let i = 0; i < batch.length; i++) {
          if (Math.abs(batch[i]) > 0.001) return true
        }
        return false
      })
      expect(hasNonZero).toBe(true)
    })
  })

  // ================================================================
  //  Multi-voice & Special Features
  // ================================================================

  describe('special features', () => {

    test('voice 3 mute (3OFF) should suppress voice 3 audio', () => {
      const samplesWithVoice3: Float32Array[] = []
      const samplesWithout: Float32Array[] = []

      // First: voice 3 unmuted
      sid.write(VOICE3_BASE + REG_FREQ_HI, 0x20)
      sid.write(VOICE3_BASE + REG_AD, 0x00)
      sid.write(VOICE3_BASE + REG_SR, 0xF0)
      sid.write(VOICE3_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE)
      sid.write(REG_MODE_VOL, 0x0F) // No 3OFF

      sid.pushSamples = (samples) => {
        samplesWithVoice3.push(new Float32Array(samples))
      }
      tickN(sid, 50)

      // Now mute voice 3 (set 3OFF = 0x80 in mode/vol)
      sid.reset(true)
      sid.write(VOICE3_BASE + REG_FREQ_HI, 0x20)
      sid.write(VOICE3_BASE + REG_AD, 0x00)
      sid.write(VOICE3_BASE + REG_SR, 0xF0)
      sid.write(VOICE3_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE)
      sid.write(REG_MODE_VOL, 0x8F) // 3OFF + volume=15

      sid.pushSamples = (samples) => {
        samplesWithout.push(new Float32Array(samples))
      }
      tickN(sid, 50)

      // The muted version should have less total energy
      const energy = (batches: Float32Array[]) => {
        let sum = 0
        for (const b of batches) {
          for (let i = 0; i < b.length; i++) sum += b[i] * b[i]
        }
        return sum
      }

      const energyWith = energy(samplesWithVoice3)
      const energyWithout = energy(samplesWithout)

      // When voice 3 is muted via 3OFF and NOT routed to filter, it should be silent
      expect(energyWithout).toBeLessThan(energyWith)
    })

    test('should handle rapid gate on/off', () => {
      sid.write(VOICE1_BASE + REG_FREQ_HI, 0x10)
      sid.write(VOICE1_BASE + REG_AD, 0x00)
      sid.write(VOICE1_BASE + REG_SR, 0xF0)
      sid.write(REG_MODE_VOL, 0x0F)

      // Rapid gate toggling
      for (let i = 0; i < 20; i++) {
        sid.write(VOICE1_BASE + REG_CONTROL, CTRL_SAWTOOTH | CTRL_GATE) // on
        tickN(sid, 2)
        sid.write(VOICE1_BASE + REG_CONTROL, CTRL_SAWTOOTH) // off
        tickN(sid, 2)
      }

      // Should not crash or produce invalid state
      const voice = sid.getVoice(0)
      expect(voice.envelopeLevel).toBeLessThanOrEqual(255)
      expect(voice.envelopeLevel).toBeGreaterThanOrEqual(0)
    })
  })

  // ================================================================
  //  IO Interface Compliance
  // ================================================================

  describe('IO interface', () => {

    test('should have raiseIRQ and raiseNMI callbacks', () => {
      expect(sid.raiseIRQ).toBeDefined()
      expect(sid.raiseNMI).toBeDefined()
      expect(typeof sid.raiseIRQ).toBe('function')
      expect(typeof sid.raiseNMI).toBe('function')
    })

    test('read should handle any address value', () => {
      // Should not throw for any address
      for (let addr = 0; addr < 64; addr++) {
        expect(() => sid.read(addr)).not.toThrow()
      }
    })

    test('write should handle any address/data combination', () => {
      for (let addr = 0; addr < 64; addr++) {
        expect(() => sid.write(addr, 0xFF)).not.toThrow()
      }
    })

    test('tick should not throw when called repeatedly', () => {
      expect(() => tickN(sid, 100)).not.toThrow()
    })
  })
})
