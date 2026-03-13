import { RAMBank } from '../../components/IO/RAMBank'

describe('RAMBank', () => {
  let ramCard: RAMBank

  beforeEach(() => {
    ramCard = new RAMBank()
  })

  describe('Static Properties', () => {
    it('should have correct total size', () => {
      expect(RAMBank.TOTAL_SIZE).toBe(256 * 1024)
    })

    it('should have correct bank size', () => {
      expect(RAMBank.BANK_SIZE).toBe(1024)
    })

    it('should have correct number of banks', () => {
      expect(RAMBank.NUM_BANKS).toBe(256)
    })

    it('should have correct bank control register address', () => {
      expect(RAMBank.BANK_CONTROL_REGISTER).toBe(0x3FF)
    })
  })

  describe('Initialization', () => {
    it('should initialize with all data as 0x00', () => {
      for (let i = 0; i < RAMBank.TOTAL_SIZE; i++) {
        expect(ramCard.data[i]).toBe(0x00)
      }
    })

    it('should start on bank 0', () => {
      expect(ramCard.currentBank).toBe(0)
    })

    it('should have IRQ and NMI callbacks', () => {
      expect(typeof ramCard.raiseIRQ).toBe('function')
      expect(typeof ramCard.raiseNMI).toBe('function')
    })
  })

  describe('Reading', () => {
    it('should read data from current bank', () => {
      ramCard.data[100] = 0x42
      expect(ramCard.read(100)).toBe(0x42)
    })

    it('should read from address 0', () => {
      ramCard.data[0] = 0xAB
      expect(ramCard.read(0)).toBe(0xAB)
    })

    it('should read from address 0x3FE (last data address)', () => {
      ramCard.write(0x3FE, 0xCD)
      expect(ramCard.read(0x3FE)).toBe(0xCD)
    })

    it('should read bank control register and return current bank', () => {
      ramCard.currentBank = 0
      expect(ramCard.read(RAMBank.BANK_CONTROL_REGISTER)).toBe(0)

      ramCard.currentBank = 42
      expect(ramCard.read(RAMBank.BANK_CONTROL_REGISTER)).toBe(42)

      ramCard.currentBank = 255
      expect(ramCard.read(RAMBank.BANK_CONTROL_REGISTER)).toBe(255)
    })
  })

  describe('Writing', () => {
    it('should write data to current bank', () => {
      ramCard.write(100, 0x42)
      expect(ramCard.data[100]).toBe(0x42)
    })

    it('should write to address 0', () => {
      ramCard.write(0, 0xAB)
      expect(ramCard.data[0]).toBe(0xAB)
    })

    it('should write to address 0x3FE', () => {
      ramCard.write(0x3FE, 0xCD)
      expect(ramCard.read(0x3FE)).toBe(0xCD)
    })

    it('should mask data to 0xFF', () => {
      ramCard.write(100, 0x1FF)
      expect(ramCard.data[100]).toBe(0xFF)

      ramCard.write(101, 0x100)
      expect(ramCard.data[101]).toBe(0x00)

      ramCard.write(102, 0x142)
      expect(ramCard.data[102]).toBe(0x42)
    })

    it('should switch banks via bank control register', () => {
      ramCard.write(RAMBank.BANK_CONTROL_REGISTER, 5)
      expect(ramCard.currentBank).toBe(5)
    })

    it('should mask bank number to 0xFF', () => {
      ramCard.write(RAMBank.BANK_CONTROL_REGISTER, 0x1FF)
      expect(ramCard.currentBank).toBe(0xFF)

      ramCard.write(RAMBank.BANK_CONTROL_REGISTER, 0x100)
      expect(ramCard.currentBank).toBe(0x00)
    })
  })

  describe('Bank Switching', () => {
    it('should isolate data between banks', () => {
      // Write to address 50 in bank 0
      ramCard.write(50, 0x11)
      expect(ramCard.read(50)).toBe(0x11)

      // Switch to bank 1
      ramCard.write(RAMBank.BANK_CONTROL_REGISTER, 1)
      expect(ramCard.read(50)).toBe(0x00)

      // Write different value to address 50 in bank 1
      ramCard.write(50, 0x22)
      expect(ramCard.read(50)).toBe(0x22)

      // Switch back to bank 0
      ramCard.write(RAMBank.BANK_CONTROL_REGISTER, 0)
      expect(ramCard.read(50)).toBe(0x11)
    })

    it('should persist data in each bank', () => {
      // Bank 0
      ramCard.write(100, 0xAA)
      ramCard.write(200, 0xBB)

      // Switch to bank 1
      ramCard.write(RAMBank.BANK_CONTROL_REGISTER, 1)
      ramCard.write(100, 0xCC)
      ramCard.write(200, 0xDD)

      // Switch to bank 2
      ramCard.write(RAMBank.BANK_CONTROL_REGISTER, 2)
      ramCard.write(100, 0xEE)

      // Verify data in bank 2
      expect(ramCard.read(100)).toBe(0xEE)

      // Switch to bank 1
      ramCard.write(RAMBank.BANK_CONTROL_REGISTER, 1)
      expect(ramCard.read(100)).toBe(0xCC)
      expect(ramCard.read(200)).toBe(0xDD)

      // Switch to bank 0
      ramCard.write(RAMBank.BANK_CONTROL_REGISTER, 0)
      expect(ramCard.read(100)).toBe(0xAA)
      expect(ramCard.read(200)).toBe(0xBB)
    })

    it('should switch between all 256 banks', () => {
      // Write unique val to each bank at address 0
      for (let bank = 0; bank < RAMBank.NUM_BANKS; bank++) {
        ramCard.write(RAMBank.BANK_CONTROL_REGISTER, bank)
        ramCard.write(0, bank & 0xFF)
      }

      // Verify each bank has correct value
      for (let bank = 0; bank < RAMBank.NUM_BANKS; bank++) {
        ramCard.write(RAMBank.BANK_CONTROL_REGISTER, bank)
        expect(ramCard.read(0)).toBe(bank & 0xFF)
      }
    })
  })

  describe('Reset', () => {
    it('should not reset on warm start', () => {
      ramCard.write(100, 0x42)
      ramCard.write(RAMBank.BANK_CONTROL_REGISTER, 42)

      ramCard.reset(false)

      expect(ramCard.data[100]).toBe(0x42)
      expect(ramCard.currentBank).toBe(42)
    })

    it('should reset all data on cold start', () => {
      ramCard.write(100, 0x42)
      ramCard.write(500, 0xAB)
      ramCard.write(RAMBank.TOTAL_SIZE - 1, 0xFF)

      ramCard.reset(true)

      expect(ramCard.data[100]).toBe(0x00)
      expect(ramCard.data[500]).toBe(0x00)
      expect(ramCard.data[RAMBank.TOTAL_SIZE - 1]).toBe(0x00)
    })

    it('should reset to bank 0 on cold start', () => {
      ramCard.write(RAMBank.BANK_CONTROL_REGISTER, 100)
      expect(ramCard.currentBank).toBe(100)

      ramCard.reset(true)

      expect(ramCard.currentBank).toBe(0)
    })

    it('should clear all RAM on cold start', () => {
      // Fill multiple banks with data
      for (let bank = 0; bank < 10; bank++) {
        ramCard.write(RAMBank.BANK_CONTROL_REGISTER, bank)
        for (let addr = 0; addr < RAMBank.BANK_SIZE; addr++) {
          ramCard.write(addr, bank)
        }
      }

      ramCard.reset(true)

      // Verify all data is cleared
      for (let i = 0; i < RAMBank.TOTAL_SIZE; i++) {
        expect(ramCard.data[i]).toBe(0x00)
      }
    })
  })

  describe('Tick', () => {
    it('should have tick method that does nothing', () => {
      expect(() => {
        ramCard.tick(1000000)
      }).not.toThrow()
    })
  })

  describe('IO Interface Implementation', () => {
    it('should implement IO interface methods', () => {
      expect(typeof ramCard.read).toBe('function')
      expect(typeof ramCard.write).toBe('function')
      expect(typeof ramCard.tick).toBe('function')
      expect(typeof ramCard.reset).toBe('function')
    })

    it('should have raiseIRQ and raiseNMI callbacks', () => {
      expect(ramCard.raiseIRQ()).toBeUndefined()
      expect(ramCard.raiseNMI()).toBeUndefined()
    })
  })

  describe('Integration', () => {
    it('should allow multiple write/read cycles', () => {
      const testValues = [0x00, 0x42, 0xFF, 0x80, 0x01]

      for (const value of testValues) {
        ramCard.write(250, value)
        expect(ramCard.read(250)).toBe(value)
      }
    })

    it('should handle rapid bank switches', () => {
      for (let i = 0; i < 100; i++) {
        ramCard.write(RAMBank.BANK_CONTROL_REGISTER, i % 256)
        ramCard.write(0, i & 0xFF)
      }

      // Check final state (last iteration i=99)
      expect(ramCard.currentBank).toBe(99 % 256)
      expect(ramCard.read(0)).toBe(99 & 0xFF)
    })

    it('should handle boundary addresses correctly', () => {
      // Test address 0
      ramCard.write(0, 0x11)
      expect(ramCard.read(0)).toBe(0x11)

      // Test address 0x3FE
      ramCard.write(0x3FE, 0x22)
      expect(ramCard.read(0x3FE)).toBe(0x22)

      // Test bank control register
      ramCard.write(0x3FF, 5)
      expect(ramCard.currentBank).toBe(5)
      expect(ramCard.read(0x3FF)).toBe(5)
    })
  })
})