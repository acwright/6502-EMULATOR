import { VIA } from '../../core/IO/VIA'
import { JoystickAttachment } from '../../core/IO/Attachments/JoystickAttachment'
import { KeyboardEncoderAttachment } from '../../core/IO/Attachments/KeyboardEncoderAttachment'
import { KeyboardMatrixAttachment } from '../../core/IO/Attachments/KeyboardMatrixAttachment'

/**
 * The keyboard, the encoder and the sticks on one VIA, wired as the machine
 * wires them, driven one register access at a time the way a program does.
 */
describe('Keyboard and joystick wiring at the VIA', () => {
  const ORB = 0x00
  const ORA = 0x01
  const DDRB = 0x02
  const DDRA = 0x03
  const IFR = 0x0d
  const PCR = 0x0c
  const PCR_ENABLE_BOTH = (6 << 5) | (6 << 1) // CA2 low, CB2 low
  const PCR_DISABLE_BOTH = (7 << 5) | (7 << 1) // CA2 high, CB2 high
  const IFR_CB1 = 0x10

  const FREQ = 1_000_000
  const HID_SPACE = 0x2c
  const HID_H = 0x0b

  let via: VIA
  let encoder: KeyboardEncoderAttachment
  let matrix: KeyboardMatrixAttachment
  let joyA: JoystickAttachment
  let joyB: JoystickAttachment

  const tick = (n: number): void => {
    for (let i = 0; i < n; i++) via.tick(FREQ)
  }
  const type = (hid: number): void => {
    matrix.updateKey(hid, true)
    encoder.updateKey(hid, true)
  }

  beforeEach(() => {
    via = new VIA()
    matrix = new KeyboardMatrixAttachment(10)
    encoder = new KeyboardEncoderAttachment(20)
    joyA = new JoystickAttachment(true, 100)
    joyB = new JoystickAttachment(false, 100)

    const stickLines = (port: 'A' | 'B'): number =>
      port === 'A' ? joyA.readPortA(0x00, 0xff) : joyB.readPortB(0x00, 0xff)
    encoder.portLines = stickLines
    matrix.stickLows = (port) => ~stickLines(port) & 0xff

    via.attachToPortA(matrix)
    via.attachToPortB(matrix)
    via.attachToPortA(encoder)
    via.attachToPortB(encoder)
    via.attachToPortA(joyA)
    via.attachToPortB(joyB)

    via.write(DDRA, 0x00)
    via.write(DDRB, 0x00)
    via.write(PCR, PCR_ENABLE_BOTH)
  })

  it('ticks an attachment on both ports once a cycle, so 100 µs is 100 µs', () => {
    encoder.releaseDelayMicros = 100
    type(HID_H)
    tick(1)
    expect(via.read(ORB)).toBe(0x48)

    via.write(PCR, PCR_DISABLE_BOTH)
    tick(99)
    expect(via.read(ORB)).toBe(0x48) // still the encoder's
    tick(2)
    expect(via.read(ORB)).toBe(0xff) // released: the untouched stick
  })

  it('reads a held key the way the DOCS scan does: row low on PA, columns on PB', () => {
    matrix.updateKey(HID_SPACE, true) // PA7, PB3
    via.write(PCR, PCR_DISABLE_BOTH)
    tick(200)

    via.write(ORA, 0x00) // the level first
    via.write(DDRA, 0x80) // then the driver: PA7 an output
    tick(10)
    const columns = via.read(ORB)
    via.write(DDRA, 0x00)

    expect(columns).toBe(0xff & ~(1 << 3))
    expect(via.read(ORB)).toBe(0xff) // row let go: nothing pulled
  })

  it('makes a polling program read the code within 20 ms, and the idle port after', () => {
    type(HID_H)
    matrix.updateKey(HID_H, false)
    tick(1)
    expect(via.read(IFR) & IFR_CB1).toBe(IFR_CB1)

    tick(KeyboardEncoderAttachment.HOLD_MICROS) // a poll a frame and more later
    expect(via.read(IFR) & IFR_CB1).toBe(IFR_CB1) // the VIA kept its flag
    expect(via.read(ORB)).toBe(0xff) // but the code has gone
  })

  it('holds back a key whose 1 bit joystick 1 holds low, and sends it right after', () => {
    joyB.updateJoystick(JoystickAttachment.BUTTON_LEFT) // bit 6, every letter's
    type(HID_H)
    matrix.updateKey(HID_H, false)
    tick(5000)
    expect(via.read(IFR) & IFR_CB1).toBe(0)

    joyB.updateJoystick(0)
    tick(1)
    expect(via.read(IFR) & IFR_CB1).toBe(IFR_CB1)
    expect(via.read(ORB)).toBe(0x48) // H, not $08
  })

  it('shows a stick through a held key in the other port', () => {
    // Joystick 2 holds RIGHT (PA7) while Space (PA7, PB3) is held: a raw read of
    // Port B for joystick 1 sees PB3 low, as on the board
    joyA.updateJoystick(JoystickAttachment.BUTTON_RIGHT)
    matrix.updateKey(HID_SPACE, true)
    via.write(PCR, PCR_DISABLE_BOTH)
    tick(200)
    expect(via.read(ORB)).toBe(0xff & ~(1 << 3))
  })
})
