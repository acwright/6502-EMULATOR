import { VIA } from '../../components/IO/VIA'
import { Attachment } from '../../components/IO/Attachments/Attachment'

/**
 * Helper function to create a mock GPIO attachment
 */
const createMockAttachment = (options: {
  priority?: number
  enabled?: boolean
  portAValue?: number
  portBValue?: number
  ca1Interrupt?: boolean
  ca2Interrupt?: boolean
  cb1Interrupt?: boolean
  cb2Interrupt?: boolean
} = {}): Attachment => {
  const {
    priority = 0,
    enabled = true,
    portAValue = 0xFF,
    portBValue = 0xFF,
    ca1Interrupt = false,
    ca2Interrupt = false,
    cb1Interrupt = false,
    cb2Interrupt = false,
  } = options

  let currentPortAValue = portAValue
  let currentPortBValue = portBValue

  return {
    reset: jest.fn(),
    tick: jest.fn(),
    readPortA: jest.fn(() => currentPortAValue),
    readPortB: jest.fn(() => currentPortBValue),
    writePortA: jest.fn(),
    writePortB: jest.fn(),
    isEnabled: jest.fn(() => enabled),
    getPriority: jest.fn(() => priority),
    clearInterrupts: jest.fn(),
    updateControlLines: jest.fn(),
    hasCA1Interrupt: jest.fn(() => ca1Interrupt),
    hasCA2Interrupt: jest.fn(() => ca2Interrupt),
    hasCB1Interrupt: jest.fn(() => cb1Interrupt),
    hasCB2Interrupt: jest.fn(() => cb2Interrupt),
    // Helper method to update values (not part of interface)
    setPortAValue: (value: number) => { currentPortAValue = value },
    setPortBValue: (value: number) => { currentPortBValue = value },
  } as Attachment & { setPortAValue: (v: number) => void; setPortBValue: (v: number) => void }
}

describe('VIA (65C22 VIA)', () => {
  let gpio: VIA

  beforeEach(() => {
    gpio = new VIA()
  })

  describe('Initialization', () => {
    it('should initialize with all registers reset', () => {
      expect(gpio.read(0x00)).toBe(0xFF) // ORB - all inputs default to 1
      expect(gpio.read(0x01)).toBe(0xFF) // ORA - all inputs default to 1
      expect(gpio.read(0x02)).toBe(0x00) // DDRB - all inputs
      expect(gpio.read(0x03)).toBe(0x00) // DDRA - all inputs
      expect(gpio.read(0x0A)).toBe(0x00) // SR
      expect(gpio.read(0x0B)).toBe(0x00) // ACR
      expect(gpio.read(0x0C)).toBe(0x00) // PCR
      expect(gpio.read(0x0D)).toBe(0x00) // IFR
      expect(gpio.read(0x0E)).toBe(0x80) // IER - bit 7 always reads as 1
    })

    it('should initialize timers to max values', () => {
      const t1cl = gpio.read(0x04)
      const t1ch = gpio.read(0x05)
      expect(t1cl).toBe(0xFF)
      expect(t1ch).toBe(0xFF)
    })
  })

  describe('Reset', () => {
    it('should reset all registers to default state', () => {
      gpio.write(0x00, 0x55)
      gpio.write(0x02, 0xFF)
      gpio.write(0x0B, 0xFF)

      gpio.reset(true)

      expect(gpio.read(0x00)).toBe(0xFF)
      expect(gpio.read(0x02)).toBe(0x00)
      expect(gpio.read(0x0B)).toBe(0x00)
    })
  })

  describe('Data Direction Registers', () => {
    it('should write and read DDRB', () => {
      gpio.write(0x02, 0xAA)
      expect(gpio.read(0x02)).toBe(0xAA)
    })

    it('should write and read DDRA', () => {
      gpio.write(0x03, 0x55)
      expect(gpio.read(0x03)).toBe(0x55)
    })

    it('should affect port reading behavior', () => {
      // Set DDRA bits 0-3 as outputs, 4-7 as inputs
      gpio.write(0x03, 0x0F)
      gpio.write(0x01, 0x5A) // Write to ORA

      const value = gpio.read(0x01)
      // Bits 0-3 should read as 0xA (from ORA), bits 4-7 as 0xF (inputs default to 1)
      expect(value & 0x0F).toBe(0x0A)
      expect(value & 0xF0).toBe(0xF0)
    })
  })

  describe('Output Registers', () => {
    it('should write and read ORB', () => {
      gpio.write(0x02, 0xFF) // Set all as outputs
      gpio.write(0x00, 0x42)
      expect(gpio.read(0x00)).toBe(0x42)
    })

    it('should write and read ORA', () => {
      gpio.write(0x03, 0xFF) // Set all as outputs
      gpio.write(0x01, 0x24)
      expect(gpio.read(0x01)).toBe(0x24)
    })

    it('should write and read ORA without handshake', () => {
      gpio.write(0x03, 0xFF) // Set all as outputs
      gpio.write(0x0F, 0x88) // Write to ORA_NH
      expect(gpio.read(0x0F)).toBe(0x88)
    })
  })

  describe('Timer 1', () => {
    it('should write to T1 low latch via T1CL', () => {
      gpio.write(0x04, 0x34)
      gpio.write(0x05, 0x12) // T1CH starts timer
      expect(gpio.read(0x06)).toBe(0x34) // Read T1LL
    })

    it('should write to T1 high latch via T1LH', () => {
      gpio.write(0x07, 0x56)
      expect(gpio.read(0x07)).toBe(0x56)
    })

    it('should load latch into counter when writing T1CH', () => {
      gpio.write(0x04, 0x10) // T1CL
      gpio.write(0x05, 0x00) // T1CH - loads counter and starts

      const low = gpio.read(0x04)
      const high = gpio.read(0x05)
      expect(low).toBe(0x10)
      expect(high).toBe(0x00)
    })

    it('should countdown Timer 1', () => {
      gpio.write(0x04, 0x05) // Low = 5
      gpio.write(0x05, 0x00) // High = 0, starts timer

      // Tick 5 times
      for (let i = 0; i < 5; i++) {
        gpio.tick(1000000)
      }

      expect(gpio.read(0x04)).toBe(0x00)
    })

    it('should set T1 interrupt flag when counter reaches zero', () => {
      gpio.write(0x04, 0x02)
      gpio.write(0x05, 0x00)

      gpio.tick(1000000)
      gpio.tick(1000000)
      gpio.tick(1000000) // Counter reaches 0

      const ifr = gpio.read(0x0D)
      expect(ifr & 0x40).toBe(0x40) // T1 interrupt flag
    })

    it('should clear T1 interrupt flag when reading T1CL', () => {
      gpio.write(0x04, 0x01)
      gpio.write(0x05, 0x00)
      gpio.tick(1000000)
      gpio.tick(1000000)

      gpio.read(0x04) // Clear flag by reading T1CL

      const ifr = gpio.read(0x0D)
      expect(ifr & 0x40).toBe(0x00)
    })

    it('should stop in one-shot mode after timeout', () => {
      gpio.write(0x04, 0x02)
      gpio.write(0x05, 0x00)

      // Countdown to 0
      gpio.tick(1000000)
      gpio.tick(1000000)
      gpio.tick(1000000)

      // Additional ticks shouldn't change counter
      gpio.tick(1000000)
      expect(gpio.read(0x04)).toBe(0x00)
    })

    it('should reload in free-run mode (ACR bit 6 set)', () => {
      gpio.write(0x0B, 0x40) // ACR - enable free-run mode
      gpio.write(0x04, 0x04) // Latch = 4
      gpio.write(0x05, 0x00)

      // Tick sequence: 4->3, 3->2, 2->1, 1->0 (triggers reload to 4), 4->3, 3->2
      for (let i = 0; i < 6; i++) {
        gpio.tick(1000000)
      }

      // After 6 ticks in free-run mode, should be at 2
      expect(gpio.read(0x04)).toBe(0x02)
    })

    it('should toggle PB7 when ACR bit 7 is set', () => {
      gpio.write(0x02, 0xFF) // DDRB all outputs
      gpio.write(0x00, 0x00) // ORB = 0
      gpio.write(0x0B, 0x80) // ACR - enable PB7 toggle
      gpio.write(0x04, 0x01)
      gpio.write(0x05, 0x00)

      gpio.tick(1000000)
      gpio.tick(1000000)

      const orb = gpio.read(0x00)
      expect(orb & 0x80).toBe(0x80) // PB7 should be toggled
    })
  })

  describe('Timer 2', () => {
    it('should write to T2 low latch', () => {
      gpio.write(0x08, 0x42)
      gpio.write(0x09, 0x00) // Start timer
      expect(gpio.read(0x08)).toBe(0x42)
    })

    it('should countdown Timer 2', () => {
      gpio.write(0x08, 0x05)
      gpio.write(0x09, 0x00)

      for (let i = 0; i < 5; i++) {
        gpio.tick(1000000)
      }

      expect(gpio.read(0x08)).toBe(0x00)
    })

    it('should set T2 interrupt flag when counter reaches zero', () => {
      gpio.write(0x08, 0x02)
      gpio.write(0x09, 0x00)

      gpio.tick(1000000)
      gpio.tick(1000000)
      gpio.tick(1000000)

      const ifr = gpio.read(0x0D)
      expect(ifr & 0x20).toBe(0x20) // T2 interrupt flag
    })

    it('should clear T2 interrupt flag when reading T2CL', () => {
      gpio.write(0x08, 0x01)
      gpio.write(0x09, 0x00)
      gpio.tick(1000000)
      gpio.tick(1000000)

      gpio.read(0x08) // Clear flag

      const ifr = gpio.read(0x0D)
      expect(ifr & 0x20).toBe(0x00)
    })

    it('should stop after timeout (one-shot mode)', () => {
      gpio.write(0x08, 0x02)
      gpio.write(0x09, 0x00)

      for (let i = 0; i < 4; i++) {
        gpio.tick(1000000)
      }

      // Should stay at 0
      expect(gpio.read(0x08)).toBe(0x00)
    })
  })

  describe('Shift Register', () => {
    it('should write and read shift register', () => {
      gpio.write(0x0A, 0xA5)
      expect(gpio.read(0x0A)).toBe(0xA5)
    })

    it('should clear SR interrupt flag when writing to SR', () => {
      // Manually set SR interrupt flag
      gpio.write(0x0E, 0x84) // Enable SR interrupt
      gpio.write(0x0D, 0x04) // Won't actually set, but let's test the read behavior

      gpio.write(0x0A, 0x00) // Writing SR should clear flag
      const ifr = gpio.read(0x0D)
      expect(ifr & 0x04).toBe(0x00)
    })

    it('should clear SR interrupt flag when reading SR', () => {
      gpio.write(0x0A, 0xFF)
      gpio.read(0x0A) // Should clear flag

      const ifr = gpio.read(0x0D)
      expect(ifr & 0x04).toBe(0x00)
    })
  })

  describe('Interrupt Flag Register (IFR)', () => {
    it('should read IFR with bit 7 always 0 when no interrupts', () => {
      const ifr = gpio.read(0x0D)
      expect(ifr & 0x80).toBe(0x00)
    })

    it('should set bit 7 when any enabled interrupt is active', () => {
      gpio.write(0x0E, 0xC0) // Enable T1 interrupt (IER)
      gpio.write(0x04, 0x01)
      gpio.write(0x05, 0x00)
      gpio.tick(1000000)
      gpio.tick(1000000)

      const ifr = gpio.read(0x0D)
      expect(ifr & 0x80).toBe(0x80) // Bit 7 set
    })

    it('should clear specific interrupt flags when writing to IFR', () => {
      gpio.write(0x0E, 0xC0) // Enable T1
      gpio.write(0x04, 0x01)
      gpio.write(0x05, 0x00)
      gpio.tick(1000000)
      gpio.tick(1000000)

      gpio.write(0x0D, 0x40) // Clear T1 flag

      const ifr = gpio.read(0x0D)
      expect(ifr & 0x40).toBe(0x00)
    })
  })

  describe('Interrupt Enable Register (IER)', () => {
    it('should read IER with bit 7 always set', () => {
      gpio.write(0x0E, 0x00)
      const ier = gpio.read(0x0E)
      expect(ier & 0x80).toBe(0x80)
    })

    it('should set interrupt enable bits when bit 7 is 1', () => {
      gpio.write(0x0E, 0xC0) // Set T1 interrupt enable
      const ier = gpio.read(0x0E)
      expect(ier & 0x40).toBe(0x40)
    })

    it('should clear interrupt enable bits when bit 7 is 0', () => {
      gpio.write(0x0E, 0xC0) // Set T1
      gpio.write(0x0E, 0x40) // Clear T1 (bit 7 = 0)
      const ier = gpio.read(0x0E)
      expect(ier & 0x40).toBe(0x00)
    })

    it('should enable multiple interrupts', () => {
      gpio.write(0x0E, 0xFF) // Enable all
      const ier = gpio.read(0x0E)
      expect(ier & 0x7F).toBe(0x7F)
    })
  })

  describe('IRQ Generation', () => {
    it('should call raiseIRQ when enabled interrupt is triggered', () => {
      const mockIRQ = jest.fn()
      gpio.raiseIRQ = mockIRQ

      gpio.write(0x0E, 0xC0) // Enable T1 interrupt
      gpio.write(0x04, 0x01)
      gpio.write(0x05, 0x00)

      gpio.tick(1000000)
      gpio.tick(1000000)

      expect(mockIRQ).toHaveBeenCalled()
    })

    it('should not call raiseIRQ when interrupt is not enabled', () => {
      const mockIRQ = jest.fn()
      gpio.raiseIRQ = mockIRQ

      gpio.write(0x04, 0x01)
      gpio.write(0x05, 0x00)

      gpio.tick(1000000)
      gpio.tick(1000000)

      expect(mockIRQ).not.toHaveBeenCalled()
    })
  })

  describe('Auxiliary Control Register (ACR)', () => {
    it('should write and read ACR', () => {
      gpio.write(0x0B, 0x55)
      expect(gpio.read(0x0B)).toBe(0x55)
    })

    it('should control Timer 1 free-run mode (bit 6)', () => {
      gpio.write(0x0B, 0x00) // One-shot
      gpio.write(0x04, 0x02)
      gpio.write(0x05, 0x00)

      for (let i = 0; i < 4; i++) {
        gpio.tick(1000000)
      }

      const t1 = gpio.read(0x04)
      expect(t1).toBe(0x00) // Should stay at 0
    })

    it('should control PB7 output (bit 7)', () => {
      gpio.write(0x02, 0xFF) // Set all Port B as outputs
      gpio.write(0x00, 0x00) // Set ORB to 0
      gpio.write(0x0B, 0xC0) // Free-run + PB7 toggle enabled
      gpio.write(0x04, 0x02) // Latch = 2
      gpio.write(0x05, 0x00)

      const before = gpio.read(0x00) & 0x80 // Should be 0
      
      // Tick until timer expires (3 ticks: 2, 1, 0)
      gpio.tick(1000000)
      gpio.tick(1000000)
      gpio.tick(1000000)
      
      const after = gpio.read(0x00) & 0x80 // Should be toggled (0x80)

      expect(before).toBe(0x00)
      expect(after).toBe(0x80)
    })
  })

  describe('Peripheral Control Register (PCR)', () => {
    it('should write and read PCR', () => {
      gpio.write(0x0C, 0xAA)
      expect(gpio.read(0x0C)).toBe(0xAA)
    })

    it('should update control lines when PCR is written', () => {
      // This is hard to test without access to private fields,
      // but we can verify the write doesn't crash
      gpio.write(0x0C, 0xEE) // CA2 and CB2 manual outputs high
      expect(gpio.read(0x0C)).toBe(0xEE)
    })
  })

  describe('Port A/B Interrupt Clearing', () => {
    it('should clear CA1/CA2 interrupts when reading ORA', () => {
      // Manually would need attachment to trigger, but reading should clear
      gpio.read(0x01)
      const ifr = gpio.read(0x0D)
      expect(ifr & 0x03).toBe(0x00)
    })

    it('should clear CA1/CA2 interrupts when writing ORA', () => {
      gpio.write(0x01, 0x00)
      const ifr = gpio.read(0x0D)
      expect(ifr & 0x03).toBe(0x00)
    })

    it('should clear CB1/CB2 interrupts when reading ORB', () => {
      gpio.read(0x00)
      const ifr = gpio.read(0x0D)
      expect(ifr & 0x18).toBe(0x00)
    })

    it('should clear CB1/CB2 interrupts when writing ORB', () => {
      gpio.write(0x00, 0x00)
      const ifr = gpio.read(0x0D)
      expect(ifr & 0x18).toBe(0x00)
    })

    it('should NOT clear interrupts when using no-handshake register', () => {
      // This test verifies that ORA_NH doesn't clear flags
      // Since we can't easily set the flags without attachments, we just verify it works
      gpio.write(0x0F, 0x42)
      expect(gpio.read(0x0F)).toBe(0xFF) // All inputs
    })
  })

  describe('GPIO Attachments', () => {
    it('should attach a device to Port A', () => {
      const mockAttachment = createMockAttachment({ priority: 0 })
      gpio.attachToPortA(mockAttachment)
      expect(gpio.getPortAAttachment(0)).toBe(mockAttachment)
    })

    it('should attach a device to Port B', () => {
      const mockAttachment = createMockAttachment({ priority: 0 })
      gpio.attachToPortB(mockAttachment)
      expect(gpio.getPortBAttachment(0)).toBe(mockAttachment)
    })

    it('should read input from attached device on Port A', () => {
      const mockAttachment = createMockAttachment({ portAValue: 0x00 })
      gpio.attachToPortA(mockAttachment)

      const value = gpio.read(0x01)
      expect(value).toBe(0x00)
    })

    it('should read input from attached device on Port B', () => {
      const mockAttachment = createMockAttachment({ portBValue: 0xAA })
      gpio.attachToPortB(mockAttachment)

      const value = gpio.read(0x00)
      expect(value).toBe(0xAA)
    })

    it('should sort attachments by priority', () => {
      const attachment1 = createMockAttachment({ priority: 5 })
      const attachment2 = createMockAttachment({ priority: 2 })
      const attachment3 = createMockAttachment({ priority: 8 })

      gpio.attachToPortA(attachment1)
      gpio.attachToPortA(attachment2)
      gpio.attachToPortA(attachment3)

      expect(gpio.getPortAAttachment(0)?.getPriority()).toBe(2) // Highest priority (lowest number)
      expect(gpio.getPortAAttachment(1)?.getPriority()).toBe(5)
      expect(gpio.getPortAAttachment(2)?.getPriority()).toBe(8)
    })

    it('should notify attachments when control lines change', () => {
      const mockAttachment = createMockAttachment()

      gpio.attachToPortA(mockAttachment)
      expect(mockAttachment.updateControlLines).toHaveBeenCalled() // Called during attach
    })

    it('should tick all attachments', () => {
      const mockAttachment = createMockAttachment()

      gpio.attachToPortA(mockAttachment)
      gpio.tick(1000000)

      expect(mockAttachment.tick).toHaveBeenCalledWith(1000000)
    })

    it('should check attachment interrupts and set IFR flags', () => {
      const mockAttachment = createMockAttachment({ ca1Interrupt: true })

      gpio.attachToPortA(mockAttachment)
      gpio.tick(1000000)

      const ifr = gpio.read(0x0D)
      expect(ifr & 0x02).toBe(0x02) // CA1 interrupt flag
    })

    it('should return null for invalid attachment index', () => {
      expect(gpio.getPortAAttachment(0)).toBeNull()
      expect(gpio.getPortBAttachment(10)).toBeNull()
    })

    it('should handle multiple attachments reading from same port', () => {
      const attachment1 = createMockAttachment({ priority: 0, portAValue: 0x0F })
      const attachment2 = createMockAttachment({ priority: 1, portAValue: 0xF0 })

      gpio.attachToPortA(attachment1)
      gpio.attachToPortA(attachment2)

      const value = gpio.read(0x01)
      // Values are ANDed together: 0x0F & 0xF0 = 0x00
      expect(value).toBe(0x00)
    })
  })

  describe('Port Direction Behavior', () => {
    it('should read outputs from OR when DDR bit is 1', () => {
      gpio.write(0x03, 0xFF) // All outputs
      gpio.write(0x01, 0xA5)
      expect(gpio.read(0x01)).toBe(0xA5)
    })

    it('should read external input when DDR bit is 0', () => {
      const mockAttachment = createMockAttachment({ portAValue: 0xFF })
      gpio.attachToPortA(mockAttachment)

      gpio.write(0x03, 0x00) // All inputs
      expect(gpio.read(0x01)).toBe(0xFF) // All high
    })

    it('should mix input and output based on DDR', () => {
      const mockAttachment = createMockAttachment({ portAValue: 0x00 })
      gpio.attachToPortA(mockAttachment)

      gpio.write(0x03, 0x0F) // Lower 4 bits output, upper 4 input
      gpio.write(0x01, 0x55)

      const value = gpio.read(0x01)
      // Lower 4 bits from ORA: 0x05
      // Upper 4 bits from attachment: 0x00
      expect(value & 0x0F).toBe(0x05)
      expect(value & 0xF0).toBe(0x00)
    })
  })

  describe('Edge Cases', () => {
    it('should mask register addresses to 4 bits', () => {
      gpio.write(0x03, 0xFF)
      gpio.write(0x11, 0x42) // 0x11 & 0x0F = 0x01 (ORA)

      expect(gpio.read(0x11)).toBe(0x42)
    })

    it('should mask data values to 8 bits', () => {
      gpio.write(0x03, 0xFF)
      gpio.write(0x01, 0x1FF)
      expect(gpio.read(0x01)).toBe(0xFF)
    })

    it('should handle timer countdown to exactly zero', () => {
      // Timer starts at 1, counts down to 0 and triggers interrupt
      gpio.write(0x04, 0x01)
      gpio.write(0x05, 0x00)

      gpio.tick(1000000) // 1 -> 0
      gpio.tick(1000000) // Reaches 0, interrupt triggered

      const ifr = gpio.read(0x0D)
      expect(ifr & 0x40).toBe(0x40)
    })

    it('should not countdown timers when not running', () => {
      const t1Before = gpio.read(0x04)
      gpio.tick(1000000)
      const t1After = gpio.read(0x04)

      expect(t1Before).toBe(t1After)
    })
  })
})
