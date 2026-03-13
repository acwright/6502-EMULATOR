import { JoystickAttachment } from '../../../components/IO/Attachments/JoystickAttachment'

describe('JoystickAttachment', () => {
  let joystick: JoystickAttachment

  beforeEach(() => {
    joystick = new JoystickAttachment(true, 0)
  })

  describe('constructor and reset', () => {
    it('should initialize with no buttons pressed', () => {
      expect(joystick.getButtonState()).toBe(0x00)
    })

    it('should reset button state', () => {
      joystick.updateJoystick(0xFF)
      joystick.reset()
      expect(joystick.getButtonState()).toBe(0x00)
    })
  })

  describe('button state management', () => {
    it('should update joystick state', () => {
      joystick.updateJoystick(0x55)
      expect(joystick.getButtonState()).toBe(0x55)
    })

    it('should check if button is pressed', () => {
      joystick.pressButton(JoystickAttachment.BUTTON_A)
      expect(joystick.isButtonPressed(JoystickAttachment.BUTTON_A)).toBe(true)
      expect(joystick.isButtonPressed(JoystickAttachment.BUTTON_B)).toBe(false)
    })

    it('should press a button', () => {
      joystick.pressButton(JoystickAttachment.BUTTON_START)
      expect(joystick.getButtonState()).toBe(JoystickAttachment.BUTTON_START)
    })

    it('should release a button', () => {
      joystick.updateJoystick(0xFF)
      joystick.releaseButton(JoystickAttachment.BUTTON_A)
      expect(joystick.getButtonState()).toBe(0xFF & ~JoystickAttachment.BUTTON_A)
    })

    it('should release all buttons', () => {
      joystick.updateJoystick(0xFF)
      joystick.releaseAllButtons()
      expect(joystick.getButtonState()).toBe(0x00)
    })
  })

  describe('port reading - Port A', () => {
    beforeEach(() => {
      joystick = new JoystickAttachment(true, 0) // Attach to Port A
    })

    it('should return inverted button state on Port A when attached', () => {
      joystick.updateJoystick(0x00) // No buttons pressed
      expect(joystick.readPortA(0x00, 0x00)).toBe(0xFF) // All bits high (active-low)
    })

    it('should return active-low values when buttons pressed', () => {
      joystick.updateJoystick(0xFF) // All buttons pressed
      expect(joystick.readPortA(0x00, 0x00)).toBe(0x00) // All bits low
    })

    it('should return FF on Port B when attached to Port A', () => {
      joystick.updateJoystick(0xFF)
      expect(joystick.readPortB(0x00, 0x00)).toBe(0xFF)
    })

    it('should handle individual button presses correctly', () => {
      joystick.updateJoystick(JoystickAttachment.BUTTON_UP)
      const result = joystick.readPortA(0x00, 0x00)
      expect(result & 0x01).toBe(0x00) // UP button bit should be low (pressed)
      expect(result & 0xFE).toBe(0xFE) // Other bits should be high (not pressed)
    })
  })

  describe('port reading - Port B', () => {
    beforeEach(() => {
      joystick = new JoystickAttachment(false, 0) // Attach to Port B
    })

    it('should return inverted button state on Port B when attached', () => {
      joystick.updateJoystick(0x00)
      expect(joystick.readPortB(0x00, 0x00)).toBe(0xFF)
    })

    it('should return active-low values when buttons pressed on Port B', () => {
      joystick.updateJoystick(0xFF)
      expect(joystick.readPortB(0x00, 0x00)).toBe(0x00)
    })

    it('should return FF on Port A when attached to Port B', () => {
      joystick.updateJoystick(0xFF)
      expect(joystick.readPortA(0x00, 0x00)).toBe(0xFF)
    })
  })

  describe('button constants', () => {
    it('should have correct button bit values', () => {
      expect(JoystickAttachment.BUTTON_UP).toBe(0x01)
      expect(JoystickAttachment.BUTTON_DOWN).toBe(0x02)
      expect(JoystickAttachment.BUTTON_LEFT).toBe(0x04)
      expect(JoystickAttachment.BUTTON_RIGHT).toBe(0x08)
      expect(JoystickAttachment.BUTTON_A).toBe(0x10)
      expect(JoystickAttachment.BUTTON_B).toBe(0x20)
      expect(JoystickAttachment.BUTTON_SELECT).toBe(0x40)
      expect(JoystickAttachment.BUTTON_START).toBe(0x80)
    })
  })

  describe('priority and enabled', () => {
    it('should return correct priority', () => {
      const j = new JoystickAttachment(true, 5)
      expect(j.getPriority()).toBe(5)
    })

    it('should be enabled by default', () => {
      expect(joystick.isEnabled()).toBe(true)
    })
  })

  describe('interrupts', () => {
    it('should not have any interrupts by default', () => {
      expect(joystick.hasCA1Interrupt()).toBe(false)
      expect(joystick.hasCA2Interrupt()).toBe(false)
      expect(joystick.hasCB1Interrupt()).toBe(false)
      expect(joystick.hasCB2Interrupt()).toBe(false)
    })

    it('should clear interrupts (no-op for joystick)', () => {
      expect(() => {
        joystick.clearInterrupts(true, true, true, true)
      }).not.toThrow()
    })
  })

  describe('tick', () => {
    it('should not throw on tick', () => {
      expect(() => {
        joystick.tick(1000000)
      }).not.toThrow()
    })
  })
})
