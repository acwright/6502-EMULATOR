import { Empty } from '../../core/IO/Empty'
import { OPEN_BUS } from '../../core/IO'

describe('Empty', () => {
  let empty: Empty

  beforeEach(() => {
    empty = new Empty()
  })

  describe('Initialization', () => {
    // raiseIRQ/raiseNMI callbacks removed; interrupts are now
    // communicated via tick() return value
  })

  describe('Reading', () => {
    it('answers OPEN_BUS for any address: nothing in the slot drives the bus', () => {
      expect(empty.read(0x00)).toBe(OPEN_BUS)
      expect(empty.read(0x42)).toBe(OPEN_BUS)
      expect(empty.read(0xFF)).toBe(OPEN_BUS)
      expect(empty.read(0x1000)).toBe(OPEN_BUS)
    })

    it('answers OPEN_BUS every time for the same address', () => {
      const address = 0x80
      expect(empty.read(address)).toBe(OPEN_BUS)
      expect(empty.read(address)).toBe(OPEN_BUS)
      expect(empty.read(address)).toBe(OPEN_BUS)
    })
  })

  describe('Writing', () => {
    it('should accept writes without throwing errors', () => {
      expect(() => empty.write(0x00, 0x00)).not.toThrow()
      expect(() => empty.write(0x42, 0xAA)).not.toThrow()
      expect(() => empty.write(0xFF, 0xFF)).not.toThrow()
    })

    it('should not affect read values after writing', () => {
      empty.write(0x10, 0x55)
      expect(empty.read(0x10)).toBe(OPEN_BUS)

      empty.write(0x20, 0xAA)
      expect(empty.read(0x20)).toBe(OPEN_BUS)
    })

    it('should handle multiple writes to the same address', () => {
      const address = 0x30
      expect(() => {
        empty.write(address, 0x11)
        empty.write(address, 0x22)
        empty.write(address, 0x33)
      }).not.toThrow()

      expect(empty.read(address)).toBe(OPEN_BUS)
    })
  })

  describe('Tick', () => {
    it('should not throw when ticked', () => {
      expect(() => empty.tick(1000000)).not.toThrow()
    })

    it('should handle various frequencies', () => {
      expect(() => empty.tick(0)).not.toThrow()
      expect(() => empty.tick(1)).not.toThrow()
      expect(() => empty.tick(1000000)).not.toThrow()
      expect(() => empty.tick(10000000)).not.toThrow()
    })

    it('should not affect read values', () => {
      empty.tick(1000000)
      expect(empty.read(0x50)).toBe(OPEN_BUS)
    })
  })

  describe('Reset', () => {
    it('should not throw when reset with cold start', () => {
      expect(() => empty.reset(true)).not.toThrow()
    })

    it('should not throw when reset without cold start', () => {
      expect(() => empty.reset(false)).not.toThrow()
    })

    it('should not affect read values after reset', () => {
      empty.reset(true)
      expect(empty.read(0x60)).toBe(OPEN_BUS)

      empty.reset(false)
      expect(empty.read(0x60)).toBe(OPEN_BUS)
    })

    it('should handle multiple resets', () => {
      expect(() => {
        empty.reset(true)
        empty.reset(false)
        empty.reset(true)
      }).not.toThrow()
    })
  })

  describe('Integration', () => {
    it('should handle a sequence of operations', () => {
      expect(() => {
        empty.reset(true)
        empty.write(0x00, 0xFF)
        const value = empty.read(0x00)
        expect(value).toBe(OPEN_BUS)
        empty.tick(1000000)
        empty.reset(false)
      }).not.toThrow()
    })

    it('should remain functional after extensive use', () => {
      for (let i = 0; i < 100; i++) {
        empty.write(i, i & 0xFF)
        empty.tick(1000)
      }

      for (let i = 0; i < 100; i++) {
        expect(empty.read(i)).toBe(OPEN_BUS)
      }

      empty.reset(true)
      expect(empty.read(0x00)).toBe(OPEN_BUS)
    })
  })
})
