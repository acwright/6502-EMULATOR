import { Attachment, AttachmentBase } from '../../../components/IO/Attachments/Attachment'

/**
 * Concrete implementation of AttachmentBase for testing
 */
class TestAttachment extends AttachmentBase {
  public portAValue: number = 0xFF
  public portBValue: number = 0xFF
  public tickCount: number = 0
  public writeAValue: number = 0
  public writeBValue: number = 0

  constructor(
    priority: number = 0,
    ca1Interrupt: boolean = false,
    ca2Interrupt: boolean = false,
    cb1Interrupt: boolean = false,
    cb2Interrupt: boolean = false
  ) {
    super(priority, ca1Interrupt, ca2Interrupt, cb1Interrupt, cb2Interrupt)
  }

  readPortA(ddr: number, or: number): number {
    return this.portAValue
  }

  readPortB(ddr: number, or: number): number {
    return this.portBValue
  }

  writePortA(value: number, ddr: number): void {
    this.writeAValue = value
  }

  writePortB(value: number, ddr: number): void {
    this.writeBValue = value
  }

  tick(cpuFrequency: number): void {
    this.tickCount++
  }

  // Expose protected members for testing
  public setCA1Interrupt(value: boolean): void {
    this.ca1Interrupt = value
  }

  public setCA2Interrupt(value: boolean): void {
    this.ca2Interrupt = value
  }

  public setCB1Interrupt(value: boolean): void {
    this.cb1Interrupt = value
  }

  public setCB2Interrupt(value: boolean): void {
    this.cb2Interrupt = value
  }

  public setEnabled(value: boolean): void {
    this.enabled = value
  }
}

describe('AttachmentBase', () => {
  let attachment: TestAttachment

  beforeEach(() => {
    attachment = new TestAttachment()
  })

  describe('Initialization', () => {
    it('should initialize with default priority 0', () => {
      expect(attachment.getPriority()).toBe(0)
    })

    it('should initialize with custom priority', () => {
      const customAttachment = new TestAttachment(5)
      expect(customAttachment.getPriority()).toBe(5)
    })

    it('should initialize as enabled', () => {
      expect(attachment.isEnabled()).toBe(true)
    })

    it('should initialize with no interrupts pending', () => {
      expect(attachment.hasCA1Interrupt()).toBe(false)
      expect(attachment.hasCA2Interrupt()).toBe(false)
      expect(attachment.hasCB1Interrupt()).toBe(false)
      expect(attachment.hasCB2Interrupt()).toBe(false)
    })

    it('should initialize with specified interrupt states', () => {
      const interruptAttachment = new TestAttachment(0, true, true, true, true)
      expect(interruptAttachment.hasCA1Interrupt()).toBe(true)
      expect(interruptAttachment.hasCA2Interrupt()).toBe(true)
      expect(interruptAttachment.hasCB1Interrupt()).toBe(true)
      expect(interruptAttachment.hasCB2Interrupt()).toBe(true)
    })
  })

  describe('Reset', () => {
    it('should reset to enabled state', () => {
      attachment.setEnabled(false)
      attachment.reset()
      expect(attachment.isEnabled()).toBe(true)
    })

    it('should clear all interrupt flags', () => {
      attachment.setCA1Interrupt(true)
      attachment.setCA2Interrupt(true)
      attachment.setCB1Interrupt(true)
      attachment.setCB2Interrupt(true)

      attachment.reset()

      expect(attachment.hasCA1Interrupt()).toBe(false)
      expect(attachment.hasCA2Interrupt()).toBe(false)
      expect(attachment.hasCB1Interrupt()).toBe(false)
      expect(attachment.hasCB2Interrupt()).toBe(false)
    })

    it('should maintain priority after reset', () => {
      const priorityAttachment = new TestAttachment(10)
      priorityAttachment.reset()
      expect(priorityAttachment.getPriority()).toBe(10)
    })
  })

  describe('Priority', () => {
    it('should return correct priority value', () => {
      const lowPriority = new TestAttachment(0)
      const highPriority = new TestAttachment(10)

      expect(lowPriority.getPriority()).toBe(0)
      expect(highPriority.getPriority()).toBe(10)
    })

    it('should support negative priority values', () => {
      const negativePriority = new TestAttachment(-5)
      expect(negativePriority.getPriority()).toBe(-5)
    })
  })

  describe('Enable/Disable', () => {
    it('should start enabled', () => {
      expect(attachment.isEnabled()).toBe(true)
    })

    it('should be disableable', () => {
      attachment.setEnabled(false)
      expect(attachment.isEnabled()).toBe(false)
    })

    it('should be re-enableable', () => {
      attachment.setEnabled(false)
      attachment.setEnabled(true)
      expect(attachment.isEnabled()).toBe(true)
    })
  })

  describe('Tick', () => {
    it('should call tick method', () => {
      attachment.tick(1000000)
      expect(attachment.tickCount).toBe(1)
    })

    it('should call tick multiple times', () => {
      attachment.tick(1000000)
      attachment.tick(1000000)
      attachment.tick(1000000)
      expect(attachment.tickCount).toBe(3)
    })

    it('should accept different CPU frequencies', () => {
      attachment.tick(1000000)
      attachment.tick(2000000)
      attachment.tick(4000000)
      expect(attachment.tickCount).toBe(3)
    })
  })

  describe('Port Reading', () => {
    it('should read from Port A', () => {
      attachment.portAValue = 0xAA
      expect(attachment.readPortA(0xFF, 0x00)).toBe(0xAA)
    })

    it('should read from Port B', () => {
      attachment.portBValue = 0x55
      expect(attachment.readPortB(0xFF, 0x00)).toBe(0x55)
    })

    it('should handle DDR parameter in Port A read', () => {
      attachment.portAValue = 0xFF
      expect(attachment.readPortA(0x00, 0x00)).toBe(0xFF)
      expect(attachment.readPortA(0xFF, 0x00)).toBe(0xFF)
    })

    it('should handle OR parameter in Port A read', () => {
      attachment.portAValue = 0xFF
      expect(attachment.readPortA(0xFF, 0x00)).toBe(0xFF)
      expect(attachment.readPortA(0xFF, 0xFF)).toBe(0xFF)
    })
  })

  describe('Port Writing', () => {
    it('should write to Port A', () => {
      attachment.writePortA(0xAA, 0xFF)
      expect(attachment.writeAValue).toBe(0xAA)
    })

    it('should write to Port B', () => {
      attachment.writePortB(0x55, 0xFF)
      expect(attachment.writeBValue).toBe(0x55)
    })

    it('should handle DDR parameter in Port A write', () => {
      attachment.writePortA(0xAA, 0x0F)
      expect(attachment.writeAValue).toBe(0xAA)
    })

    it('should handle DDR parameter in Port B write', () => {
      attachment.writePortB(0x55, 0xF0)
      expect(attachment.writeBValue).toBe(0x55)
    })

    it('should handle multiple writes to same port', () => {
      attachment.writePortA(0xAA, 0xFF)
      attachment.writePortA(0x55, 0xFF)
      expect(attachment.writeAValue).toBe(0x55)
    })
  })

  describe('Interrupt Management - CA1', () => {
    it('should check CA1 interrupt flag', () => {
      expect(attachment.hasCA1Interrupt()).toBe(false)
      attachment.setCA1Interrupt(true)
      expect(attachment.hasCA1Interrupt()).toBe(true)
    })

    it('should clear CA1 interrupt', () => {
      attachment.setCA1Interrupt(true)
      attachment.clearInterrupts(true, false, false, false)
      expect(attachment.hasCA1Interrupt()).toBe(false)
    })

    it('should not clear CA1 when clearing other interrupts', () => {
      attachment.setCA1Interrupt(true)
      attachment.clearInterrupts(false, true, true, true)
      expect(attachment.hasCA1Interrupt()).toBe(true)
    })
  })

  describe('Interrupt Management - CA2', () => {
    it('should check CA2 interrupt flag', () => {
      expect(attachment.hasCA2Interrupt()).toBe(false)
      attachment.setCA2Interrupt(true)
      expect(attachment.hasCA2Interrupt()).toBe(true)
    })

    it('should clear CA2 interrupt', () => {
      attachment.setCA2Interrupt(true)
      attachment.clearInterrupts(false, true, false, false)
      expect(attachment.hasCA2Interrupt()).toBe(false)
    })

    it('should not clear CA2 when clearing other interrupts', () => {
      attachment.setCA2Interrupt(true)
      attachment.clearInterrupts(true, false, true, true)
      expect(attachment.hasCA2Interrupt()).toBe(true)
    })
  })

  describe('Interrupt Management - CB1', () => {
    it('should check CB1 interrupt flag', () => {
      expect(attachment.hasCB1Interrupt()).toBe(false)
      attachment.setCB1Interrupt(true)
      expect(attachment.hasCB1Interrupt()).toBe(true)
    })

    it('should clear CB1 interrupt', () => {
      attachment.setCB1Interrupt(true)
      attachment.clearInterrupts(false, false, true, false)
      expect(attachment.hasCB1Interrupt()).toBe(false)
    })

    it('should not clear CB1 when clearing other interrupts', () => {
      attachment.setCB1Interrupt(true)
      attachment.clearInterrupts(true, true, false, true)
      expect(attachment.hasCB1Interrupt()).toBe(true)
    })
  })

  describe('Interrupt Management - CB2', () => {
    it('should check CB2 interrupt flag', () => {
      expect(attachment.hasCB2Interrupt()).toBe(false)
      attachment.setCB2Interrupt(true)
      expect(attachment.hasCB2Interrupt()).toBe(true)
    })

    it('should clear CB2 interrupt', () => {
      attachment.setCB2Interrupt(true)
      attachment.clearInterrupts(false, false, false, true)
      expect(attachment.hasCB2Interrupt()).toBe(false)
    })

    it('should not clear CB2 when clearing other interrupts', () => {
      attachment.setCB2Interrupt(true)
      attachment.clearInterrupts(true, true, true, false)
      expect(attachment.hasCB2Interrupt()).toBe(true)
    })
  })

  describe('Interrupt Management - Multiple', () => {
    it('should clear multiple interrupts at once', () => {
      attachment.setCA1Interrupt(true)
      attachment.setCA2Interrupt(true)
      attachment.setCB1Interrupt(true)
      attachment.setCB2Interrupt(true)

      attachment.clearInterrupts(true, true, false, false)

      expect(attachment.hasCA1Interrupt()).toBe(false)
      expect(attachment.hasCA2Interrupt()).toBe(false)
      expect(attachment.hasCB1Interrupt()).toBe(true)
      expect(attachment.hasCB2Interrupt()).toBe(true)
    })

    it('should clear all interrupts', () => {
      attachment.setCA1Interrupt(true)
      attachment.setCA2Interrupt(true)
      attachment.setCB1Interrupt(true)
      attachment.setCB2Interrupt(true)

      attachment.clearInterrupts(true, true, true, true)

      expect(attachment.hasCA1Interrupt()).toBe(false)
      expect(attachment.hasCA2Interrupt()).toBe(false)
      expect(attachment.hasCB1Interrupt()).toBe(false)
      expect(attachment.hasCB2Interrupt()).toBe(false)
    })

    it('should handle clearing when no interrupts are set', () => {
      attachment.clearInterrupts(true, true, true, true)

      expect(attachment.hasCA1Interrupt()).toBe(false)
      expect(attachment.hasCA2Interrupt()).toBe(false)
      expect(attachment.hasCB1Interrupt()).toBe(false)
      expect(attachment.hasCB2Interrupt()).toBe(false)
    })
  })

  describe('Control Lines', () => {
    it('should call updateControlLines', () => {
      // Default implementation does nothing, just verify it doesn't crash
      expect(() => {
        attachment.updateControlLines(true, false, true, false)
      }).not.toThrow()
    })

    it('should accept all control line combinations', () => {
      expect(() => {
        attachment.updateControlLines(false, false, false, false)
        attachment.updateControlLines(true, true, true, true)
        attachment.updateControlLines(true, false, true, false)
        attachment.updateControlLines(false, true, false, true)
      }).not.toThrow()
    })
  })

  describe('Edge Cases', () => {
    it('should handle rapid enable/disable cycles', () => {
      for (let i = 0; i < 100; i++) {
        attachment.setEnabled(i % 2 === 0)
      }
      // Last iteration (i=99) sets enabled to false (99 % 2 !== 0)
      expect(attachment.isEnabled()).toBe(false)
    })

    it('should handle rapid interrupt set/clear cycles', () => {
      for (let i = 0; i < 100; i++) {
        attachment.setCA1Interrupt(true)
        attachment.clearInterrupts(true, false, false, false)
      }
      expect(attachment.hasCA1Interrupt()).toBe(false)
    })

    it('should handle reset during active interrupts', () => {
      attachment.setCA1Interrupt(true)
      attachment.setCA2Interrupt(true)
      attachment.setCB1Interrupt(true)
      attachment.setCB2Interrupt(true)

      attachment.reset()

      expect(attachment.hasCA1Interrupt()).toBe(false)
      expect(attachment.hasCA2Interrupt()).toBe(false)
      expect(attachment.hasCB1Interrupt()).toBe(false)
      expect(attachment.hasCB2Interrupt()).toBe(false)
    })

    it('should maintain state across multiple operations', () => {
      attachment.setCA1Interrupt(true)
      attachment.tick(1000000)
      attachment.writePortA(0xAA, 0xFF)
      
      expect(attachment.hasCA1Interrupt()).toBe(true)
      expect(attachment.tickCount).toBe(1)
      expect(attachment.writeAValue).toBe(0xAA)
    })
  })
})
