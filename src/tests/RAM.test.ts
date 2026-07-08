import { RAM } from '../core/RAM'

describe('RAM', () => {
	let ram: RAM

	beforeEach(() => {
		ram = new RAM()
	})

	describe('Initialization', () => {
		test('can initialize', () => {
			expect(ram).not.toBeNull()
			expect(ram).toBeInstanceOf(RAM)
		})

		test('initializes with correct size', () => {
			expect(ram.data.length).toBe(RAM.SIZE)
			expect(ram.data.length).toBe(0x8000) // 32KB
		})

		test('initializes all memory to zero', () => {
			for (let i = 0; i < RAM.SIZE; i++) {
				expect(ram.data[i]).toBe(0x00)
			}
		})
	})

	describe('Static Properties', () => {
		test('START is 0x0000', () => {
			expect(RAM.START).toBe(0x0000)
		})

		test('END is 0x7FFF', () => {
			expect(RAM.END).toBe(0x7FFF)
		})

		test('SIZE is calculated correctly', () => {
			expect(RAM.SIZE).toBe(0x8000)
			expect(RAM.SIZE).toBe(RAM.END - RAM.START + 1)
		})
	})

	describe('read()', () => {
		test('reads zero from uninitialized address', () => {
			expect(ram.read(0x0000)).toBe(0x00)
			expect(ram.read(0x1234)).toBe(0x00)
			expect(ram.read(0x7FFF)).toBe(0x00)
		})

		test('reads data from address', () => {
			ram.data[0x1234] = 0x42
			expect(ram.read(0x1234)).toBe(0x42)
		})

		test('reads from start address', () => {
			ram.data[0x0000] = 0xFF
			expect(ram.read(0x0000)).toBe(0xFF)
		})

		test('reads from end address', () => {
			ram.data[0x7FFF] = 0xAB
			expect(ram.read(0x7FFF)).toBe(0xAB)
		})

		test('reads different values from different addresses', () => {
			ram.data[0x0100] = 0x11
			ram.data[0x0200] = 0x22
			ram.data[0x0300] = 0x33
			
			expect(ram.read(0x0100)).toBe(0x11)
			expect(ram.read(0x0200)).toBe(0x22)
			expect(ram.read(0x0300)).toBe(0x33)
		})
	})

	describe('write()', () => {
		test('writes data to address', () => {
			ram.write(0x1234, 0x42)
			expect(ram.data[0x1234]).toBe(0x42)
		})

		test('writes to start address', () => {
			ram.write(0x0000, 0xFF)
			expect(ram.data[0x0000]).toBe(0xFF)
		})

		test('writes to end address', () => {
			ram.write(0x7FFF, 0xAB)
			expect(ram.data[0x7FFF]).toBe(0xAB)
		})

		test('writes different values to different addresses', () => {
			ram.write(0x0100, 0x11)
			ram.write(0x0200, 0x22)
			ram.write(0x0300, 0x33)
			
			expect(ram.data[0x0100]).toBe(0x11)
			expect(ram.data[0x0200]).toBe(0x22)
			expect(ram.data[0x0300]).toBe(0x33)
		})

		test('overwrites existing data', () => {
			ram.write(0x1000, 0x11)
			expect(ram.data[0x1000]).toBe(0x11)
			
			ram.write(0x1000, 0x22)
			expect(ram.data[0x1000]).toBe(0x22)
		})

		test('does not affect other addresses', () => {
			ram.write(0x1000, 0xFF)
			
			expect(ram.data[0x0FFF]).toBe(0x00)
			expect(ram.data[0x1001]).toBe(0x00)
		})
	})

	describe('read/write integration', () => {
		test('read returns written value', () => {
			ram.write(0x1234, 0x42)
			expect(ram.read(0x1234)).toBe(0x42)
		})

		test('multiple read/write operations', () => {
			ram.write(0x0100, 0x11)
			ram.write(0x0200, 0x22)
			ram.write(0x0300, 0x33)
			
			expect(ram.read(0x0100)).toBe(0x11)
			expect(ram.read(0x0200)).toBe(0x22)
			expect(ram.read(0x0300)).toBe(0x33)
			
			ram.write(0x0100, 0x44)
			expect(ram.read(0x0100)).toBe(0x44)
			expect(ram.read(0x0200)).toBe(0x22) // unchanged
		})
	})

	describe('reset()', () => {
		beforeEach(() => {
			// Write some data to memory
			ram.write(0x0000, 0x11)
			ram.write(0x1234, 0x42)
			ram.write(0x7FFF, 0xFF)
		})

		test('resets all memory to zero when coldStart is true', () => {
			ram.reset(true)
			
			expect(ram.read(0x0000)).toBe(0x00)
			expect(ram.read(0x1234)).toBe(0x00)
			expect(ram.read(0x7FFF)).toBe(0x00)
		})

		test('does not reset memory when coldStart is false', () => {
			ram.reset(false)
			
			expect(ram.read(0x0000)).toBe(0x11)
			expect(ram.read(0x1234)).toBe(0x42)
			expect(ram.read(0x7FFF)).toBe(0xFF)
		})

		test('all memory is zeroed after cold start', () => {
			ram.reset(true)
			
			for (let i = 0; i < RAM.SIZE; i++) {
				expect(ram.data[i]).toBe(0x00)
			}
		})

		test('memory can be written after reset', () => {
			ram.reset(true)
			ram.write(0x5000, 0xAB)
			
			expect(ram.read(0x5000)).toBe(0xAB)
		})
	})

	describe('Edge Cases', () => {
		test('handles byte overflow (values > 0xFF)', () => {
			ram.write(0x1000, 0x1FF)
			expect(ram.data[0x1000]).toBe(0x1FF) // JavaScript allows this
		})

		test('handles zero value', () => {
			ram.write(0x1000, 0xFF)
			ram.write(0x1000, 0x00)
			expect(ram.read(0x1000)).toBe(0x00)
		})

		test('handles maximum byte value (0xFF)', () => {
			ram.write(0x1000, 0xFF)
			expect(ram.read(0x1000)).toBe(0xFF)
		})
	})
})