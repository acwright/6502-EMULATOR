import { AttachmentBase } from './Attachment'

/**
 * JoystickAttachment - Emulates a joystick/gamepad connected to GPIO port
 * 
 * Buttons are active-low (0 = pressed, 1 = released)
 * Can be attached to either Port A or Port B
 */
export class JoystickAttachment extends AttachmentBase {
  // Joystick button bit masks
  static readonly BUTTON_UP = 0x01
  static readonly BUTTON_DOWN = 0x02
  static readonly BUTTON_LEFT = 0x04
  static readonly BUTTON_RIGHT = 0x08
  static readonly BUTTON_A = 0x10
  static readonly BUTTON_B = 0x20
  static readonly BUTTON_SELECT = 0x40
  static readonly BUTTON_START = 0x80

  private buttonState: number
  private attachedToPortA: boolean

  constructor(attachToPortA: boolean = true, priority: number = 0) {
    // Call parent constructor with priority and no control line interrupts
    super(priority, false, false, false, false)
    this.attachedToPortA = attachToPortA
    this.buttonState = 0x00
    this.reset()
  }

  reset(): void {
    super.reset()
    this.buttonState = 0x00
  }

  readPortA(ddr: number, or: number): number {
    if (this.attachedToPortA) {
      // Return inverted button state (active-low)
      return (~this.buttonState) & 0xFF
    }
    return 0xFF
  }

  readPortB(ddr: number, or: number): number {
    if (!this.attachedToPortA) {
      // Return inverted button state (active-low)
      return (~this.buttonState) & 0xFF
    }
    return 0xFF
  }

  /**
   * Update the joystick button state
   * @param buttons - Button state byte (1 = pressed, 0 = released)
   */
  updateJoystick(buttons: number): void {
    this.buttonState = buttons & 0xFF
  }

  /**
   * Get the current button state
   * @returns The button state byte
   */
  getButtonState(): number {
    return this.buttonState
  }

  /**
   * Check if a specific button is pressed
   * @param button - Button bit mask to check
   * @returns true if button is pressed
   */
  isButtonPressed(button: number): boolean {
    return (this.buttonState & button) !== 0
  }

  /**
   * Press a button (set its bit)
   * @param button - Button bit mask to press
   */
  pressButton(button: number): void {
    this.buttonState |= button
  }

  /**
   * Release a button (clear its bit)
   * @param button - Button bit mask to release
   */
  releaseButton(button: number): void {
    this.buttonState &= ~button
  }

  /**
   * Clear all button presses
   */
  releaseAllButtons(): void {
    this.buttonState = 0x00
  }
}
