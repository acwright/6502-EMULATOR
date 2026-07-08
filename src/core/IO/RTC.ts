import { IO } from '../IO'

/**
 * DS1511Y+ Real-Time Clock IC Emulation
 * 
 * Register Map (0x00-0x1F):
 * 0x00: Seconds (BCD, 00-59)
 * 0x01: Minutes (BCD, 00-59)
 * 0x02: Hours (BCD, 00-23)
 * 0x03: Day of Week (1-7, 1=Sunday)
 * 0x04: Date (BCD, 01-31)
 * 0x05: Month (BCD, 01-12) + Control bits (EOSC, E32K)
 * 0x06: Year (BCD, 00-99)
 * 0x07: Century (BCD, 00-39)
 * 0x08: Alarm Seconds (BCD, 00-59) + AM1 bit
 * 0x09: Alarm Minutes (BCD, 00-59) + AM2 bit
 * 0x0A: Alarm Hours (BCD, 00-23) + AM3 bit
 * 0x0B: Alarm Day/Date + AM4, DY/DT bits
 * 0x0C: Watchdog (0.1 Second and 0.01 Second)
 * 0x0D: Watchdog (0.1 Second and Second)
 * 0x0E: Control A (BLF1, BLF2, PBS, PAB, TDF, KSF, WDF, IRQF)
 * 0x0F: Control B (TE, CS, BME, TPE, TIE, KIE, WDE, WDS)
 * 0x10: RAM Address (Extended RAM Address pointer)
 * 0x11: Reserved
 * 0x12: Reserved
 * 0x13: RAM Data (Extended RAM Data at address pointed to by 0x10)
 */
export class RTC implements IO {

  // RTC Registers (user-visible)
  private userSeconds: number = 0        // 0x00
  private userMinutes: number = 0        // 0x01
  private userHours: number = 0          // 0x02
  private userDayOfWeek: number = 1      // 0x03 (1=Sunday)
  private userDate: number = 1           // 0x04
  private userMonth: number = 1          // 0x05 (bits 0-4)
  private monthControl: number = 0       // 0x05 (bits 5-7: EOSC, E32K)
  private userYear: number = 0           // 0x06 (00-99)
  private userCentury: number = 20       // 0x07 (00-39)

  // Internal timekeeping registers
  private internalSeconds: number = 0
  private internalMinutes: number = 0
  private internalHours: number = 0
  private internalDayOfWeek: number = 1
  private internalDate: number = 1
  private internalMonth: number = 1
  private internalYear: number = 0
  private internalCentury: number = 20
  
  // Alarm registers
  private alarmSeconds: number = 0   // 0x08 (bits 0-6, bit 7 = AM1)
  private alarmMinutes: number = 0   // 0x09 (bits 0-6, bit 7 = AM2)
  private alarmHours: number = 0     // 0x0A (bits 0-6, bit 7 = AM3)
  private alarmDayDate: number = 0   // 0x0B (bits 0-5, bit 6 = DY/DT, bit 7 = AM4)

  // Watchdog
  private watchdog1: number = 0      // 0x0C (0.1 Second and 0.01 Second)
  private watchdog2: number = 0      // 0x0D (0.1 Second and Second)
  private watchdogCounterCentis: number = 0
  private watchdogCycleCounter: number = 0
  private nmiPending: boolean = false

  // Control registers
  private controlA: number = 0       // 0x0E
  private controlB: number = 0       // 0x0F

  // Extended RAM
  private ramAddress: number = 0     // 0x10
  private ramData: Uint8Array = new Uint8Array(256) // 256 bytes of extended RAM

  // Time tracking for incrementing
  private cycleAccumulator: number = 0    // Accumulated CPU cycles toward next second
  private cpuFrequency: number = 1000000 // Stored for watchdog calculations
  private pendingUserToInternal: boolean = false
  private userSyncNeeded: boolean = false

  constructor() {
    this.initializeWithCurrentTime()
  }

  /**
   * Initialize RTC with current system time
   */
  private initializeWithCurrentTime(): void {
    const now = new Date()
    this.internalSeconds = this.decimalToBCD(now.getSeconds())
    this.internalMinutes = this.decimalToBCD(now.getMinutes())
    this.internalHours = this.decimalToBCD(now.getHours())
    this.internalDayOfWeek = now.getDay() === 0 ? 1 : now.getDay() // 1=Sunday
    this.internalDate = this.decimalToBCD(now.getDate())
    this.internalMonth = this.decimalToBCD(now.getMonth() + 1)
    this.internalYear = this.decimalToBCD(now.getFullYear() % 100)
    this.internalCentury = this.decimalToBCD(Math.floor(now.getFullYear() / 100))
    this.monthControl = 0x00 // EOSC=0: oscillator enabled (DS1511Y+ default)
    this.copyInternalToUser()
    this.pendingUserToInternal = false
    this.userSyncNeeded = false
    this.cycleAccumulator = 0
  }

  /**
   * Convert decimal to BCD (Binary Coded Decimal)
   */
  private decimalToBCD(decimal: number): number {
    return ((Math.floor(decimal / 10) << 4) | (decimal % 10)) & 0xFF
  }

  /**
   * Convert BCD to decimal
   */
  private bcdToDecimal(bcd: number): number {
    return (((bcd >> 4) & 0x0F) * 10) + (bcd & 0x0F)
  }

  /**
   * Get the number of days in a month
   */
  private getDaysInMonth(month: number, year: number, century: number): number {
    const fullYear = (century * 100) + year
    
    if ([1, 3, 5, 7, 8, 10, 12].includes(month)) return 31
    if ([4, 6, 9, 11].includes(month)) return 30
    
    // February
    if ((fullYear % 4 === 0 && fullYear % 100 !== 0) || fullYear % 400 === 0) {
      return 29
    }
    return 28
  }

  /**
   * Get next day of week
   */
  private getNextDayOfWeek(currentDay: number): number {
    return currentDay === 7 ? 1 : currentDay + 1
  }

  private copyInternalToUser(): void {
    this.userSeconds = this.internalSeconds
    this.userMinutes = this.internalMinutes
    this.userHours = this.internalHours
    this.userDayOfWeek = this.internalDayOfWeek
    this.userDate = this.internalDate
    this.userMonth = this.internalMonth
    this.userYear = this.internalYear
    this.userCentury = this.internalCentury
  }

  private copyUserToInternal(): void {
    this.internalSeconds = this.userSeconds
    this.internalMinutes = this.userMinutes
    this.internalHours = this.userHours
    this.internalDayOfWeek = this.userDayOfWeek
    this.internalDate = this.userDate
    this.internalMonth = this.userMonth
    this.internalYear = this.userYear
    this.internalCentury = this.userCentury
  }

  private getTransferCyclesRequired(): number {
    return Math.max(1, Math.ceil(this.cpuFrequency * 366 / 1000000))
  }

  private markUserTimeWrite(): void {
    // Actual copy into internal registers happens on the TE falling edge (1→0)
    this.pendingUserToInternal = true
  }

  /**
   * Increment time by one second
   */
  private incrementTime(): void {
    let sec = this.bcdToDecimal(this.internalSeconds)
    let min = this.bcdToDecimal(this.internalMinutes)
    let hour = this.bcdToDecimal(this.internalHours)
    let date = this.bcdToDecimal(this.internalDate)
    let month = this.bcdToDecimal(this.internalMonth)
    let year = this.bcdToDecimal(this.internalYear)
    const century = this.bcdToDecimal(this.internalCentury)

    sec++
    if (sec >= 60) {
      sec = 0
      min++
      if (min >= 60) {
        min = 0
        hour++
        if (hour >= 24) {
          hour = 0
          this.internalDayOfWeek = this.getNextDayOfWeek(this.internalDayOfWeek)
          date++
          
          const daysInMonth = this.getDaysInMonth(month, year, century)
          if (date > daysInMonth) {
            date = 1
            month++
            if (month > 12) {
              month = 1
              year++
              if (year > 99) {
                year = 0
                let cent = this.bcdToDecimal(this.internalCentury)
                cent++
                if (cent > 39) cent = 0
                this.internalCentury = this.decimalToBCD(cent)
              }
            }
          }
        }
      }
    }

    this.internalSeconds = this.decimalToBCD(sec)
    this.internalMinutes = this.decimalToBCD(min)
    this.internalHours = this.decimalToBCD(hour)
    this.internalDate = this.decimalToBCD(date)
    this.internalMonth = this.decimalToBCD(month)
    this.internalYear = this.decimalToBCD(year)
  }

  /**
   * Check if alarm should trigger
   */
  private checkAlarm(): void {
    const am1 = (this.alarmSeconds & 0x80) !== 0
    const am2 = (this.alarmMinutes & 0x80) !== 0
    const am3 = (this.alarmHours & 0x80) !== 0
    const am4 = (this.alarmDayDate & 0x80) !== 0

    // If all AM bits are set, alarm is disabled
    if (am1 && am2 && am3 && am4) return

    // Check matching based on AM bits
    const secondsMatch = am1 || (this.internalSeconds === (this.alarmSeconds & 0x7F))
    const minutesMatch = am2 || (this.internalMinutes === (this.alarmMinutes & 0x7F))
    const hoursMatch = am3 || (this.internalHours === (this.alarmHours & 0x7F))
    
    let dayDateMatch = true
    if (!am4) {
      const dyDt = (this.alarmDayDate & 0x40) !== 0
      const alarmValue = this.alarmDayDate & 0x3F
      
      if (dyDt) {
        // Day of week match
        dayDateMatch = this.internalDayOfWeek === alarmValue
      } else {
        // Date match
        dayDateMatch = this.internalDate === alarmValue
      }
    }

    if (secondsMatch && minutesMatch && hoursMatch && dayDateMatch) {
      this.controlA |= 0x08 // Set TDF flag (bit 3)
      this.raiseInterruptIfEnabled(0x08, 0x08)
    }
  }

  private raiseInterruptIfEnabled(flagMask: number, enableMask: number): void {
    if ((this.controlA & flagMask) === 0) return
    if ((this.controlB & enableMask) === 0) return
    this.controlA |= 0x01 // Set IRQF flag (bit 0)
  }

  private setKickstartFlag(): void {
    this.controlA |= 0x04 // Set KSF flag (bit 2)
    this.raiseInterruptIfEnabled(0x04, 0x04)
  }

  private decodeWatchdogCentis(): number {
    const hundredths = this.watchdog1 & 0x0F
    const tenths = (this.watchdog1 >> 4) & 0x0F
    const seconds = this.watchdog2 & 0x0F
    const tensSeconds = (this.watchdog2 >> 4) & 0x0F

    const totalSeconds = (tensSeconds * 10) + seconds
    const totalCentis = (tenths * 10) + hundredths
    return (totalSeconds * 100) + totalCentis
  }

  private reloadWatchdog(): void {
    this.watchdogCounterCentis = this.decodeWatchdogCentis()
    this.watchdogCycleCounter = 0
  }

  private stepWatchdog(): void {
    if ((this.controlB & 0x02) === 0) return // WDE disabled
    if (this.watchdogCounterCentis <= 0) return

    const cyclesPerCentisecond = Math.max(1, Math.floor(this.cpuFrequency / 100))
    this.watchdogCycleCounter++
    if (this.watchdogCycleCounter < cyclesPerCentisecond) return

    this.watchdogCycleCounter = 0
    this.watchdogCounterCentis -= 1
    if (this.watchdogCounterCentis > 0) return

    this.controlA |= 0x02 // Set WDF flag (bit 1)

    if ((this.controlB & 0x01) === 0) {
      this.raiseInterruptIfEnabled(0x02, 0x02)
    } else {
      // WDS=1 steers watchdog to reset; emulate by clearing WDE
      this.controlB &= ~0x02
      this.nmiPending = true
    }
  }

  read(address: number): number {
    address &= 0x1F

    switch (address) {
      case 0x00:
        return this.userSeconds
      case 0x01: return this.userMinutes
      case 0x02: return this.userHours
      case 0x03: return this.userDayOfWeek & 0x07
      case 0x04: return this.userDate
      case 0x05: return this.userMonth | this.monthControl
      case 0x06: return this.userYear
      case 0x07: return this.userCentury
      case 0x08: return this.alarmSeconds
      case 0x09: return this.alarmMinutes
      case 0x0A: return this.alarmHours
      case 0x0B: return this.alarmDayDate
      case 0x0C: return this.watchdog1
      case 0x0D: return this.watchdog2
      case 0x0E:
        // Reading Control A clears the interrupt flags: IRQF, WDF, KSF, TDF
        const result = this.controlA
        this.controlA &= 0xF0 // Clear bits 0-3 (IRQF, WDF, KSF, TDF)
        return result
      case 0x0F: return this.controlB
      case 0x10: return this.ramAddress
      case 0x11: return 0 // Reserved
      case 0x12: return 0 // Reserved
      case 0x13: {
        const value = this.ramData[this.ramAddress]
        if ((this.controlB & 0x20) !== 0) {
          this.ramAddress = (this.ramAddress + 1) & 0xFF
        }
        return value
      }
      default: return 0
    }
  }

  write(address: number, data: number): void {
    data &= 0xFF
    address &= 0x1F

    switch (address) {
      case 0x00:
        this.userSeconds = data
        this.markUserTimeWrite()
        break
      case 0x01:
        this.userMinutes = data
        this.markUserTimeWrite()
        break
      case 0x02:
        this.userHours = data
        this.markUserTimeWrite()
        break
      case 0x03:
        this.userDayOfWeek = data & 0x07
        this.markUserTimeWrite()
        break
      case 0x04:
        this.userDate = data
        this.markUserTimeWrite()
        break
      case 0x05:
        this.userMonth = data & 0x1F
        this.monthControl = data & 0xE0
        this.markUserTimeWrite()
        break
      case 0x06:
        this.userYear = data
        this.markUserTimeWrite()
        break
      case 0x07:
        this.userCentury = data
        this.markUserTimeWrite()
        break
      case 0x08:
        this.alarmSeconds = data
        break
      case 0x09:
        this.alarmMinutes = data
        break
      case 0x0A:
        this.alarmHours = data
        break
      case 0x0B:
        this.alarmDayDate = data
        break
      case 0x0C:
        this.watchdog1 = data
        this.reloadWatchdog()
        break
      case 0x0D:
        this.watchdog2 = data
        this.reloadWatchdog()
        break
      case 0x0E:
        // Writing 1 to flag bits (0-3) clears them; control bits (4-7) are written normally
        this.controlA = (data & 0xF0) | ((this.controlA & 0x0F) & ~(data & 0x0F))
        break
      case 0x0F: {
        const previousTE = (this.controlB & 0x80) !== 0
        this.controlB = data
        const currentTE = (this.controlB & 0x80) !== 0
        // TE falling edge (1→0): commit buffered user writes into internal counters
        if (previousTE && !currentTE) {
          if (this.pendingUserToInternal) {
            this.copyUserToInternal()
            this.pendingUserToInternal = false
          }
          // Mirror the committed time back so CPU reads it immediately
          this.copyInternalToUser()
          this.userSyncNeeded = false
          // Reset cycle accumulator so the next second is measured from now
          this.cycleAccumulator = 0
        }
        this.raiseInterruptIfEnabled(0x04, 0x04)
        if ((this.controlB & 0x02) !== 0) {
          this.reloadWatchdog()
        }
        break
      }
      case 0x10:
        this.ramAddress = data // Set RAM address pointer
        break
      case 0x11:
      case 0x12:
        // Reserved, ignore writes
        break
      case 0x13:
        this.ramData[this.ramAddress] = data // Write to RAM at current address
        if ((this.controlB & 0x20) !== 0) {
          this.ramAddress = (this.ramAddress + 1) & 0xFF
        }
        break
    }
  }



  tick(frequency: number): number {
    this.cpuFrequency = frequency > 0 ? frequency : 1000000

    const teEnabled = (this.controlB & 0x80) !== 0

    if ((this.monthControl & 0x80) !== 0) {
      // EOSC=1: oscillator disabled (DS1511Y+ active-low enable)
      this.stepWatchdog()
      let status = (this.controlA & 0x01) ? 0x80 : 0
      if (this.nmiPending) {
        status |= 0x40
        this.nmiPending = false
      }
      return status
    }

    // Advance the clock by counting CPU cycles.
    // One emulated second = cpuFrequency cycles.
    this.cycleAccumulator++
    while (this.cycleAccumulator >= this.cpuFrequency) {
      this.cycleAccumulator -= this.cpuFrequency
      this.incrementTime()
      this.checkAlarm()

      if (!teEnabled) {
        this.copyInternalToUser()
        this.userSyncNeeded = false
      } else {
        this.userSyncNeeded = true
      }
    }

    if (!teEnabled && this.userSyncNeeded) {
      this.copyInternalToUser()
      this.userSyncNeeded = false
    }

    this.stepWatchdog()

    // Return interrupt status: bit 7 = IRQ, bit 6 = NMI
    let status = (this.controlA & 0x01) ? 0x80 : 0
    if (this.nmiPending) {
      status |= 0x40
      this.nmiPending = false
    }
    return status
  }

  reset(coldStart: boolean): void {
    if (coldStart) {
      // Cold start: Initialize with current time
      this.initializeWithCurrentTime()
      this.watchdogCounterCentis = 0
      this.watchdogCycleCounter = 0
      this.pendingUserToInternal = false
      this.userSyncNeeded = false
      this.setKickstartFlag()
    } else {
      // Warm start: Keep time, reset some control flags but preserve settings
      this.controlA &= 0xF0 // Clear interrupt flags
      this.watchdogCounterCentis = 0
      this.watchdogCycleCounter = 0
      this.pendingUserToInternal = false
      this.userSyncNeeded = false
    }
  }

  /**
   * Load NVRAM data from a Uint8Array (256 bytes extended RAM)
   */
  loadNVRAM(data: Uint8Array | ArrayBuffer | number[] | null): void {
    if (!data) return

    let uint8Data: Uint8Array
    if (data instanceof ArrayBuffer) {
      uint8Data = new Uint8Array(data)
    } else if (data instanceof Uint8Array) {
      uint8Data = data
    } else {
      uint8Data = new Uint8Array(data)
    }

    if (uint8Data.length !== 256) {
      console.warn(`Warning: NVRAM data size (${uint8Data.length} bytes) does not match expected 256 bytes. NVRAM will remain empty.`)
      return
    }

    this.ramData.set(uint8Data)
  }

  /**
   * Get NVRAM data as Uint8Array for saving
   */
  getNVRAM(): Uint8Array {
    return new Uint8Array(this.ramData)
  }
}