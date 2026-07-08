import { ROM } from '../core/ROM'

describe('ROM', () => {
	let rom: ROM

	beforeEach(() => {
		rom = new ROM()
	})

	describe('Initialization', () => {
		test('can initialize', () => {
			expect(rom).not.toBeNull()
			expect(rom).toBeInstanceOf(ROM)
		})

		test('initializes with correct size', () => {
			expect(rom.data.length).toBe(ROM.SIZE)
			expect(rom.data.length).toBe(0x8000) // 32KB
		})

		test('initializes all memory to zero', () => {
			for (let i = 0; i < ROM.SIZE; i++) {
				expect(rom.data[i]).toBe(0x00)
			}
		})
	})

	describe('Static Properties', () => {
		test('START is 0x8000', () => {
			expect(ROM.START).toBe(0x8000)
		})

		test('END is 0xFFFF', () => {
			expect(ROM.END).toBe(0xFFFF)
		})

		test('CODE is 0xA000', () => {
			expect(ROM.CODE).toBe(0xA000)
		})

		test('SIZE is calculated correctly', () => {
			expect(ROM.SIZE).toBe(0x8000)
			expect(ROM.SIZE).toBe(ROM.END - ROM.START + 1)
		})
	})

	describe('read()', () => {
		test('reads zero from uninitialized address', () => {
			expect(rom.read(0x0000)).toBe(0x00)
			expect(rom.read(0x4000)).toBe(0x00)
			expect(rom.read(0x7FFF)).toBe(0x00)
		})

		test('reads data from address', () => {
			rom.data[0x1234] = 0x42
			expect(rom.read(0x1234)).toBe(0x42)
		})

		test('reads from start address', () => {
			rom.data[0x0000] = 0xFF
			expect(rom.read(0x0000)).toBe(0xFF)
		})

		test('reads from end address', () => {
			rom.data[0x7FFF] = 0xAB
			expect(rom.read(0x7FFF)).toBe(0xAB)
		})

		test('reads different values from different addresses', () => {
			rom.data[0x0100] = 0x11
			rom.data[0x0200] = 0x22
			rom.data[0x0300] = 0x33
			
			expect(rom.read(0x0100)).toBe(0x11)
			expect(rom.read(0x0200)).toBe(0x22)
			expect(rom.read(0x0300)).toBe(0x33)
		})
	})

	describe('load()', () => {
		test('loads data of correct size', () => {
			const testData = new Array(ROM.SIZE).fill(0x00)
			testData[0x0000] = 0xAA
			testData[0x1234] = 0xBB
			testData[0x7FFF] = 0xCC
			
			rom.load(testData)
			
			expect(rom.data[0x0000]).toBe(0xAA)
			expect(rom.data[0x1234]).toBe(0xBB)
			expect(rom.data[0x7FFF]).toBe(0xCC)
		})

		test('does not load data of incorrect size (too small)', () => {
			const originalData = [...rom.data]
			const testData = new Array(ROM.SIZE - 1).fill(0xFF)
			
			rom.load(testData)
			
			expect(rom.data).toEqual(originalData)
		})

		test('does not load data of incorrect size (too large)', () => {
			const originalData = [...rom.data]
			const testData = new Array(ROM.SIZE + 1).fill(0xFF)
			
			rom.load(testData)
			
			expect(rom.data).toEqual(originalData)
		})

		test('loaded data can be read back', () => {
			const testData = new Array(ROM.SIZE).fill(0x00)
			testData[0x1000] = 0x42
			testData[0x2000] = 0x84
			testData[0x3000] = 0xC6
			
			rom.load(testData)
			
			expect(rom.read(0x1000)).toBe(0x42)
			expect(rom.read(0x2000)).toBe(0x84)
			expect(rom.read(0x3000)).toBe(0xC6)
		})

		test('load replaces existing data', () => {
			// Set some initial data
			rom.data[0x0100] = 0xAA
			rom.data[0x0200] = 0xBB
			
			// Load new data
			const testData = new Array(ROM.SIZE).fill(0x00)
			testData[0x0100] = 0x11
			testData[0x0300] = 0x22
			
			rom.load(testData)
			
			expect(rom.read(0x0100)).toBe(0x11)
			expect(rom.read(0x0200)).toBe(0x00) // Old data replaced
			expect(rom.read(0x0300)).toBe(0x22)
		})

		test('load with all different values', () => {
			const testData = new Array(ROM.SIZE).fill(0).map((_, i) => i % 256)
			
			rom.load(testData)
			
			expect(rom.read(0x0000)).toBe(0)
			expect(rom.read(0x0001)).toBe(1)
			expect(rom.read(0x00FF)).toBe(255)
			expect(rom.read(0x0100)).toBe(0)
			expect(rom.read(0x0101)).toBe(1)
		})
	})
})
