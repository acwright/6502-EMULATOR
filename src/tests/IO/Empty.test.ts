import { Empty } from '../../components/IO/Empty'

describe('Empty', () => {
  let empty: Empty

  beforeEach(() => {
    empty = new Empty()
  })

  describe('Initialization', () => {
    it('should have IRQ callback', () => {
      expect(typeof empty.raiseIRQ).toBe('function')
    })

    it('should have NMI callback', () => {
      expect(typeof empty.raiseNMI).toBe('function')
    })

    it('should not throw when calling raiseIRQ', () => {
      expect(() => empty.raiseIRQ()).not.toThrow()
    })

    it('should not throw when calling raiseNMI', () => {
      expect(() => empty.raiseNMI()).not.toThrow()
    })
  })

  describe('Reading', () => {
    it('should return 0 for any address', () => {
      expect(empty.read(0x00)).toBe(0)
      expect(empty.read(0x42)).toBe(0)
      expect(empty.read(0xFF)).toBe(0)
      expect(empty.read(0x1000)).toBe(0)
    })

    it('should consistently return 0 for the same address', () => {
      const address = 0x80
      expect(empty.read(address)).toBe(0)
      expect(empty.read(address)).toBe(0)
      expect(empty.read(address)).toBe(0)
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
      expect(empty.read(0x10)).toBe(0)

      empty.write(0x20, 0xAA)
      expect(empty.read(0x20)).toBe(0)
    })

    it('should handle multiple writes to the same address', () => {
      const address = 0x30
      expect(() => {
        empty.write(address, 0x11)
        empty.write(address, 0x22)
        empty.write(address, 0x33)
      }).not.toThrow()

      expect(empty.read(address)).toBe(0)
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
      expect(empty.read(0x50)).toBe(0)
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
      expect(empty.read(0x60)).toBe(0)

      empty.reset(false)
      expect(empty.read(0x60)).toBe(0)
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
        expect(value).toBe(0)
        empty.tick(1000000)
        empty.raiseIRQ()
        empty.raiseNMI()
        empty.reset(false)
      }).not.toThrow()
    })

    it('should remain functional after extensive use', () => {
      for (let i = 0; i < 100; i++) {
        empty.write(i, i & 0xFF)
        empty.tick(1000)
      }

      for (let i = 0; i < 100; i++) {
        expect(empty.read(i)).toBe(0)
      }

      empty.reset(true)
      expect(empty.read(0x00)).toBe(0)
    })
  })
})
