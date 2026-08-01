import { VIA } from '../../core/IO/VIA'
import { JoystickAttachment } from '../../core/IO/Attachments/JoystickAttachment'
import { KeyboardEncoderAttachment } from '../../core/IO/Attachments/KeyboardEncoderAttachment'

/**
 * The joystick-read contract at the VIA seam: with both encoders disabled and
 * settled, the raw port reflects the stick, and it is the only joystick path
 * (§3.2). Drives the same disable → settle → read sequence the Kernal's
 * ReadJoystick routines use, one register write at a time.
 */
describe('Joystick raw-port read', () => {
  // VIA register offsets (address & 0x0F).
  const ORB = 0x00
  const ORA = 0x01
  const DDRB = 0x02
  const DDRA = 0x03
  const PCR = 0x0c

  // PCR nibbles: CA2 control is bits 1-3, CB2 control is bits 5-7. 6 = manual
  // LOW (encoder enabled), 7 = manual HIGH (encoder told to release).
  const PCR_ENABLE_BOTH = (6 << 5) | (6 << 1) // 0xCC — CA2 low, CB2 low
  const PCR_DISABLE_BOTH = (7 << 5) | (7 << 1) // 0xEE — CA2 high, CB2 high

  const FREQ = 1_000_000

  let via: VIA
  let encoder: KeyboardEncoderAttachment
  let joyA: JoystickAttachment
  let joyB: JoystickAttachment

  beforeEach(() => {
    via = new VIA()
    encoder = new KeyboardEncoderAttachment(20)
    encoder.activePort = 'both'
    joyA = new JoystickAttachment(true, 100)
    joyB = new JoystickAttachment(false, 100)

    via.attachToPortA(encoder)
    via.attachToPortB(encoder)
    via.attachToPortA(joyA)
    via.attachToPortB(joyB)

    // Both ports are inputs, as the Kernal leaves them for a joystick read.
    via.write(DDRA, 0x00)
    via.write(DDRB, 0x00)
  })

  /** Advance the VIA (and its attachments) by n emulated cycles. */
  const tick = (n: number): void => {
    for (let i = 0; i < n; i++) via.tick(FREQ)
  }

  /** Bracket a raw port read the way ReadJoystick does: disable, settle, read. */
  const readStick = (reg: number): number => {
    via.write(PCR, PCR_DISABLE_BOTH)
    tick(encoder.releaseDelayMicros + 5) // settle past the release delay
    const value = via.read(reg)
    via.write(PCR, PCR_ENABLE_BOTH)
    return value
  }

  it('returns 0xFF on an idle machine (§5.7)', () => {
    expect(readStick(ORA)).toBe(0xff)
    expect(readStick(ORB)).toBe(0xff)
  })

  it('returns 0xFF when no attachments are present (no-GPIO machine, §5.7)', () => {
    const bare = new VIA()
    bare.write(DDRA, 0x00)
    bare.write(DDRB, 0x00)
    expect(bare.read(ORA)).toBe(0xff)
    expect(bare.read(ORB)).toBe(0xff)
  })

  it('returns the stick once the encoder is disabled and settled (§5.3)', () => {
    joyA.updateJoystick(JoystickAttachment.BUTTON_UP) // active-low: 0xEF
    joyB.updateJoystick(JoystickAttachment.BUTTON_A) // active-low: 0xFE
    expect(readStick(ORA)).toBe(0xff & ~JoystickAttachment.BUTTON_UP)
    expect(readStick(ORB)).toBe(0xff & ~JoystickAttachment.BUTTON_A)
  })

  it('does not show the stick until the release delay has elapsed (§5.1)', () => {
    joyB.updateJoystick(JoystickAttachment.BUTTON_A)
    via.write(PCR, PCR_DISABLE_BOTH)
    // Read one microsecond into the release window: the encoder still owns the
    // port, so the stick is not visible yet.
    tick(1)
    expect(via.read(ORB)).not.toBe(0xff & ~JoystickAttachment.BUTTON_A)
  })

  it('reads both sticks in a single disabled window (§5.4)', () => {
    // The case the abandoned control-byte protocol could not do: both sticks
    // held at once, each read off its own port in the same disable/settle window.
    joyA.updateJoystick(JoystickAttachment.BUTTON_DOWN | JoystickAttachment.BUTTON_X)
    joyB.updateJoystick(JoystickAttachment.BUTTON_LEFT | JoystickAttachment.BUTTON_A)

    via.write(PCR, PCR_DISABLE_BOTH)
    tick(encoder.releaseDelayMicros + 5)
    const a = via.read(ORA)
    const b = via.read(ORB)
    via.write(PCR, PCR_ENABLE_BOTH)

    expect(a).toBe(0xff & ~(JoystickAttachment.BUTTON_DOWN | JoystickAttachment.BUTTON_X))
    expect(b).toBe(0xff & ~(JoystickAttachment.BUTTON_LEFT | JoystickAttachment.BUTTON_A))
  })
})
