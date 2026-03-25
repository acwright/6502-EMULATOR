import { RTC } from '../../components/IO/RTC'

const bcdToDecimal = (bcd: number): number => (((bcd >> 4) & 0x0f) * 10) + (bcd & 0x0f)

const setTime = (rtc: RTC, values: {
	seconds: number
	minutes: number
	hours: number
	dayOfWeek: number
	date: number
	month: number
	year: number
	century: number
}): void => {
	rtc.write(0x0f, 0x80) // Set TE to inhibit transfers
	rtc.write(0x00, values.seconds)
	rtc.write(0x01, values.minutes)
	rtc.write(0x02, values.hours)
	rtc.write(0x03, values.dayOfWeek)
	rtc.write(0x04, values.date)
	rtc.write(0x05, values.month) // EOSC=0: oscillator enabled (DS1511Y default)
	rtc.write(0x06, values.year)
	rtc.write(0x07, values.century)
	rtc.write(0x0f, 0x00) // Clear TE: falling edge commits user to internal
}

describe('RTC', () => {
	let rtc: RTC

	beforeEach(() => {
		rtc = new RTC()
	})

	describe('Initialization', () => {
		it('should initialize with valid BCD time and EOSC enabled', () => {
			const seconds = rtc.read(0x00)
			const minutes = rtc.read(0x01)
			const hours = rtc.read(0x02)
			const dayOfWeek = rtc.read(0x03)
			const date = rtc.read(0x04)
			const month = rtc.read(0x05)
			const year = rtc.read(0x06)
			const century = rtc.read(0x07)

			expect(dayOfWeek).toBeGreaterThanOrEqual(1)
			expect(dayOfWeek).toBeLessThanOrEqual(7)

			expect(bcdToDecimal(seconds)).toBeGreaterThanOrEqual(0)
			expect(bcdToDecimal(seconds)).toBeLessThan(60)
			expect(bcdToDecimal(minutes)).toBeGreaterThanOrEqual(0)
			expect(bcdToDecimal(minutes)).toBeLessThan(60)
			expect(bcdToDecimal(hours)).toBeGreaterThanOrEqual(0)
			expect(bcdToDecimal(hours)).toBeLessThan(24)
			expect(bcdToDecimal(date)).toBeGreaterThanOrEqual(1)
			expect(bcdToDecimal(date)).toBeLessThanOrEqual(31)
			expect(bcdToDecimal(month & 0x1f)).toBeGreaterThanOrEqual(1)
			expect(bcdToDecimal(month & 0x1f)).toBeLessThanOrEqual(12)
			expect(bcdToDecimal(year)).toBeGreaterThanOrEqual(0)
			expect(bcdToDecimal(year)).toBeLessThanOrEqual(99)
			expect(bcdToDecimal(century)).toBeGreaterThanOrEqual(0)
			expect(bcdToDecimal(century)).toBeLessThanOrEqual(39)

			expect(month & 0x80).toBe(0x00)
		})
	})

	describe('Registers', () => {
		it('should mask day of week reads to 3 bits', () => {
			rtc.write(0x03, 0xff)
			expect(rtc.read(0x03)).toBe(0x07)
		})

		it('should clear control flags on Control A read', () => {
			rtc.reset(true)
			const first = rtc.read(0x0e)
			const second = rtc.read(0x0e)

			expect(first & 0x04).toBe(0x04)
			expect(second & 0x0f).toBe(0)
		})

		it('should raise IRQ when KSF is set and KIE enabled', () => {
			const mockIRQ = jest.fn()
			rtc.raiseIRQ = mockIRQ

			rtc.reset(true)
			rtc.write(0x0f, 0x04)

			expect(mockIRQ).toHaveBeenCalledTimes(1)
			const controlA = rtc.read(0x0e)
			expect(controlA & 0x01).toBe(0x01)
		})
	})

	describe('Extended RAM', () => {
		it('should write and read RAM at the address pointer', () => {
			rtc.write(0x10, 0x10)
			rtc.write(0x13, 0x5a)
			rtc.write(0x10, 0x10)

			expect(rtc.read(0x13)).toBe(0x5a)
		})

		it('should auto-increment RAM address when enabled', () => {
			rtc.write(0x0f, 0x20)
			rtc.write(0x10, 0x10)
			rtc.write(0x13, 0x11)
			rtc.write(0x13, 0x22)

			expect(rtc.read(0x10)).toBe(0x12)

			rtc.write(0x10, 0x10)
			expect(rtc.read(0x13)).toBe(0x11)
			expect(rtc.read(0x13)).toBe(0x22)
			expect(rtc.read(0x10)).toBe(0x12)
		})
	})

	describe('Timekeeping', () => {
		it('should advance time when TE is enabled', () => {
			setTime(rtc, {
				seconds: 0x00,
				minutes: 0x00,
				hours: 0x00,
				dayOfWeek: 0x01,
				date: 0x01,
				month: 0x01,
				year: 0x00,
				century: 0x20
			})

			rtc.tick(1)

			expect(rtc.read(0x00)).toBe(0x01)
		})

		it('should stop time when oscillator is disabled', () => {
			setTime(rtc, {
				seconds: 0x10,
				minutes: 0x00,
				hours: 0x00,
				dayOfWeek: 0x01,
				date: 0x01,
				month: 0x01,
				year: 0x00,
				century: 0x20
			})

			rtc.write(0x05, 0x81) // EOSC=1: oscillator disabled
			rtc.tick(1)

			expect(rtc.read(0x00)).toBe(0x10)
		})
	})

	describe('Alarm', () => {
		it('should set TDF and raise IRQ when alarm matches', () => {
			const mockIRQ = jest.fn()
			rtc.raiseIRQ = mockIRQ

			setTime(rtc, {
				seconds: 0x00,
				minutes: 0x00,
				hours: 0x00,
				dayOfWeek: 0x01,
				date: 0x01,
				month: 0x01,
				year: 0x00,
				century: 0x20
			})

			rtc.write(0x08, 0x01)
			rtc.write(0x09, 0x00)
			rtc.write(0x0a, 0x00)
			rtc.write(0x0b, 0x01)
			rtc.write(0x0f, 0x88)

			rtc.tick(1)

			expect(mockIRQ).toHaveBeenCalledTimes(1)
			const controlA = rtc.read(0x0e)
			expect(controlA & 0x08).toBe(0x08)
			expect(controlA & 0x01).toBe(0x01)
		})
	})

	describe('Watchdog', () => {
		it('should raise IRQ when watchdog expires with WDS=0', () => {
			const mockIRQ = jest.fn()
			rtc.raiseIRQ = mockIRQ

			rtc.write(0x0f, 0x02)
			rtc.write(0x0c, 0x01)
			rtc.write(0x0d, 0x00)

			rtc.tick(1)

			expect(mockIRQ).toHaveBeenCalledTimes(1)
			const controlA = rtc.read(0x0e)
			expect(controlA & 0x02).toBe(0x02)
			expect(controlA & 0x01).toBe(0x01)
		})

		it('should raise NMI and clear WDE when WDS=1', () => {
			const mockNMI = jest.fn()
			rtc.raiseNMI = mockNMI

			rtc.write(0x0f, 0x03)
			rtc.write(0x0c, 0x01)
			rtc.write(0x0d, 0x00)

			rtc.tick(1)

			expect(mockNMI).toHaveBeenCalledTimes(1)
			expect(rtc.read(0x0f) & 0x02).toBe(0)
		})
	})
})