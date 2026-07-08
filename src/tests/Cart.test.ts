import { Cart } from '../core/Cart'

describe('Cart', () => {
  let cart: Cart

  beforeEach(() => {
    cart = new Cart()
  })

  describe('Static Properties', () => {
    test('should have correct START address', () => {
      expect(Cart.START).toBe(0x8000)
    })

    test('should have correct END address', () => {
      expect(Cart.END).toBe(0xFFFF)
    })

    test('should have correct CODE address', () => {
      expect(Cart.CODE).toBe(0xC000)
    })

    test('should have correct SIZE', () => {
      expect(Cart.SIZE).toBe(0x8000)
      expect(Cart.SIZE).toBe(Cart.END - Cart.START + 1)
    })
  })

  describe('Initialization', () => {
    test('should create a new Cart instance', () => {
      expect(cart).not.toBeNull()
      expect(cart).toBeInstanceOf(Cart)
    })

    test('should initialize data array with correct size', () => {
      expect(cart.data).toHaveLength(Cart.SIZE)
    })

    test('should initialize all data to 0x00', () => {
      for (let i = 0; i < cart.data.length; i++) {
        expect(cart.data[i]).toBe(0x00)
      }
    })
  })

  describe('read()', () => {
    test('should read data from address', () => {
      cart.data[0x0000] = 0x42
      expect(cart.read(0x0000)).toBe(0x42)
    })

    test('should read 0x00 from uninitialized address', () => {
      expect(cart.read(0x1000)).toBe(0x00)
    })

    test('should read from first address', () => {
      cart.data[0] = 0xAA
      expect(cart.read(0)).toBe(0xAA)
    })

    test('should read from last address', () => {
      cart.data[Cart.SIZE - 1] = 0xBB
      expect(cart.read(Cart.SIZE - 1)).toBe(0xBB)
    })

    test('should read multiple different values', () => {
      cart.data[0x1000] = 0x12
      cart.data[0x2000] = 0x34
      cart.data[0x3000] = 0x56
      
      expect(cart.read(0x1000)).toBe(0x12)
      expect(cart.read(0x2000)).toBe(0x34)
      expect(cart.read(0x3000)).toBe(0x56)
    })
  })

  describe('load()', () => {
    test('should load data array with correct size', () => {
      const testData = new Array(Cart.SIZE).fill(0xFF)
      cart.load(testData)
      
      expect(cart.data).toBe(testData)
      expect(cart.data[0]).toBe(0xFF)
      expect(cart.data[Cart.SIZE - 1]).toBe(0xFF)
    })

    test('should not load data array with incorrect size (too small)', () => {
      const originalData = [...cart.data]
      const testData = new Array(Cart.SIZE - 1).fill(0xFF)
      
      cart.load(testData)
      
      expect(cart.data).toEqual(originalData)
      expect(cart.data).not.toBe(testData)
    })

    test('should not load data array with incorrect size (too large)', () => {
      const originalData = [...cart.data]
      const testData = new Array(Cart.SIZE + 1).fill(0xFF)
      
      cart.load(testData)
      
      expect(cart.data).toEqual(originalData)
      expect(cart.data).not.toBe(testData)
    })

    test('should not load empty array', () => {
      const originalData = [...cart.data]
      cart.load([])
      
      expect(cart.data).toEqual(originalData)
    })

    test('should load data with specific pattern', () => {
      const testData = new Array(Cart.SIZE).fill(0x00).map((_, i) => i & 0xFF)
      cart.load(testData)
      
      for (let i = 0; i < 256; i++) {
        expect(cart.read(i)).toBe(i)
      }
    })

    test('should replace existing data when loading', () => {
      // Set some initial data directly
      cart.data[0x0000] = 0xAA
      cart.data[0x1000] = 0xBB
      cart.data[0x2000] = 0xCC
      
      // Load new data
      const testData = new Array(Cart.SIZE).fill(0x55)
      cart.load(testData)
      
      expect(cart.read(0x0000)).toBe(0x55)
      expect(cart.read(0x1000)).toBe(0x55)
      expect(cart.read(0x2000)).toBe(0x55)
    })

    test('should allow reading loaded data', () => {
      const testData = new Array(Cart.SIZE).fill(0x00)
      testData[0x1234] = 0xAB
      testData[0x5678] = 0xCD
      
      cart.load(testData)
      
      expect(cart.read(0x1234)).toBe(0xAB)
      expect(cart.read(0x5678)).toBe(0xCD)
    })
  })
})