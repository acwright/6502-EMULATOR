import { Machine } from '../core/Machine'
import { RAM } from '../core/RAM'
import { ROM } from '../core/ROM'
import { BankedCart, Cart } from '../core/Cart'
import { ACIA } from '../core/IO/ACIA'
import { Empty } from '../core/IO/Empty'
import { captureSnapshot, restoreSnapshot } from '../debug/Snapshot'
import { Video } from '../core/IO/Video'
import { TMS9918A } from '../core/IO/TMS9918A'
import { Video as LibraryVideo, TMS9918A as LibraryTMS9918A, createVideoCard } from '../lib'

describe('Machine', () => {
  let machine: Machine

  beforeEach(() => {
    machine = new Machine()
  })

  describe('Initialization', () => {
    test('Constructor creates a Machine instance', () => {
      expect(machine).not.toBeNull()
      expect(machine).toBeInstanceOf(Machine)
    })

    test('Machine initializes with correct default properties', () => {
      expect(machine.frequency).toBe(1000000)
    })

    test('Machine creates CPU, RAM, ROM, and IO cards', () => {
      expect(machine.cpu).not.toBeNull()
      expect(machine.ram).not.toBeNull()
      expect(machine.rom).not.toBeNull()
      expect(machine.io1).not.toBeNull()
      expect(machine.io2).not.toBeNull()
      expect(machine.io3).not.toBeNull()
      expect(machine.io4).not.toBeNull()
      expect(machine.io5).not.toBeNull()
      expect(machine.io6).not.toBeNull()
      expect(machine.io7).not.toBeNull()
      expect(machine.io8).not.toBeNull()
    })

    // `video()` is `instanceof Video`, and a vacant answer is not an error
    // anywhere: the console quietly routes to serial, which looks exactly like
    // "the BIOS didn't boot". So pin both answers, and that the class a library
    // consumer imports is the one the check recognises.
    test('video() finds the card in io8, and only that card', () => {
      expect(machine.video()).toBe(machine.io8)
      expect(machine.video()).toBeInstanceOf(Video)
      expect(machine.video()).toBeInstanceOf(LibraryVideo)
      expect(new Machine({ io8: new LibraryVideo() }).video()).toBeDefined()
      expect(new Machine({ io8: new Empty() }).video()).toBeUndefined()
    })

    // Either card is the video card. The default stays the PICOVDP, the
    // reference card the goldens and traces are captured on; hosts choose.
    test('video() finds a TMS9918A in io8 too, and the default is the PICOVDP', () => {
      expect(machine.video()!.model).toBe('picovdp')

      const tms = new Machine({ io8: new TMS9918A() })
      expect(tms.video()).toBe(tms.io8)
      expect(tms.video()).toBeInstanceOf(LibraryTMS9918A)
      expect(tms.video()!.model).toBe('tms9918a')
      expect(tms.video()!.registerCount).toBe(8)
      expect(tms.video()!.vramSize).toBe(0x4000)

      expect(new Machine({ io8: createVideoCard('tms9918a') }).video()).toBeInstanceOf(TMS9918A)
      expect(new Machine({ io8: createVideoCard('picovdp') }).video()).toBeInstanceOf(Video)
    })

    test('Machine has no cart initially', () => {
      expect(machine.cart).toBeUndefined()
    })

    test('Machine has CPU reset on creation', () => {
      // CPU should be reset, which sets up initial state
      expect(machine.cpu).toBeDefined()
    })
  })

  describe('Memory Access - Read Operations', () => {
    test('Reading from RAM returns stored values', () => {
      const address = 0x0100
      machine.ram.write(address, 0xAB)
      expect(machine.read(address)).toBe(0xAB)
    })

    test('Reading from uninitialized RAM returns 0', () => {
      expect(machine.read(0x0200)).toBe(0)
    })

    test('Reading from IO1 address space', () => {
      const ioAddress = 0x8000
      machine.io1.write(0, 0x55)
      expect(machine.read(ioAddress)).toBe(0x55)
    })

    test('Reading from IO2 address space', () => {
      const ioAddress = 0x8400
      machine.io2.write(0, 0x66)
      expect(machine.read(ioAddress)).toBe(0x66)
    })

    test('Reading from IO3 (RTC) address space', () => {
      const ioAddress = 0x8800
      const result = machine.read(ioAddress)
      expect(typeof result).toBe('number')
    })

    test('Reading from IO4 (Storage) address space', () => {
      const ioAddress = 0x8C00
      const result = machine.read(ioAddress)
      expect(typeof result).toBe('number')
    })

    test('Reading from IO5 (Serial) address space', () => {
      const ioAddress = 0x9000
      const result = machine.read(ioAddress)
      expect(typeof result).toBe('number')
    })

    test('Reading from IO6 (GPIO) address space', () => {
      const ioAddress = 0x9400
      const result = machine.read(ioAddress)
      expect(typeof result).toBe('number')
    })

    test('Reading from IO7 (Sound) address space', () => {
      const ioAddress = 0x9800
      const result = machine.read(ioAddress)
      expect(typeof result).toBe('number')
    })

    test('Reading from IO8 (Video) address space', () => {
      const ioAddress = 0x9C00
      const result = machine.read(ioAddress)
      expect(typeof result).toBe('number')
    })

    test('Reading from invalid address returns 0', () => {
      // Assuming unmapped space returns 0
      expect(machine.read(0x10000)).toBe(0)
    })

    test('Reading from ROM address space', () => {
      const romAddress = 0xA000
      const result = machine.read(romAddress)
      expect(typeof result).toBe('number')
    })
  })

  describe('Memory Access - Write Operations', () => {
    test('Writing to RAM stores values', () => {
      const address = 0x0100
      machine.write(address, 0xCD)
      expect(machine.ram.read(address)).toBe(0xCD)
    })

    test('Writing to IO1 address space', () => {
      const ioAddress = 0x8000
      machine.write(ioAddress, 0x42)
      expect(machine.io1.read(0)).toBe(0x42)
    })

    test('Writing to IO2 address space', () => {
      const ioAddress = 0x8400
      machine.write(ioAddress, 0x43)
      expect(machine.io2.read(0)).toBe(0x43)
    })

    test('Writing to IO3 address space', () => {
      const ioAddress = 0x8800
      expect(() => machine.write(ioAddress, 0x44)).not.toThrow()
    })

    test('Writing to IO4 address space', () => {
      const ioAddress = 0x8C00
      expect(() => machine.write(ioAddress, 0x45)).not.toThrow()
    })

    test('Writing to IO5 address space', () => {
      const ioAddress = 0x9000
      expect(() => machine.write(ioAddress, 0x46)).not.toThrow()
    })

    test('Writing to IO6 address space', () => {
      const ioAddress = 0x9400
      expect(() => machine.write(ioAddress, 0x47)).not.toThrow()
    })

    test('Writing to IO7 address space', () => {
      const ioAddress = 0x9800
      expect(() => machine.write(ioAddress, 0x48)).not.toThrow()
    })

    test('Writing to IO8 address space', () => {
      const ioAddress = 0x9C00
      expect(() => machine.write(ioAddress, 0x49)).not.toThrow()
    })

    test('Writing to ROM address space does nothing', () => {
      const romAddress = 0xA000
      expect(() => machine.write(romAddress, 0xFF)).not.toThrow()
    })
  })

  describe('Cart Operations', () => {
    /** A banked image whose every 8 KB bank is filled with its own number. */
    const bankedImage = (size: number): Uint8Array => {
      const image = new Uint8Array(size).fill(0xFF)
      for (let bank = 0; bank * 0x2000 < size; bank++) {
        image.fill(bank & 0xFF, bank * 0x2000, (bank + 1) * 0x2000)
      }
      return image
    }

    test('Cart is initially undefined', () => {
      expect(machine.cart).toBeUndefined()
    })

    test('loadCart should load a 32K ROM cart', () => {
      const testData = new Uint8Array(Cart.SIZE).fill(0xEA) // NOP instruction
      machine.loadCart(testData)
      expect(machine.cart).toBeInstanceOf(Cart)
      expect(machine.read(Cart.CODE)).toBe(0xEA)
    })

    test('loadCart picks the mapper by size', () => {
      machine.loadCart(bankedImage(0x20000))
      expect(machine.cart).toBeInstanceOf(BankedCart)
    })

    test('an image of an invalid size leaves the cart alone', () => {
      machine.loadCart(new Uint8Array(Cart.SIZE).fill(0xEA))
      const loaded = machine.cart
      machine.loadCart(new Uint8Array(16384).fill(0x00))
      expect(machine.cart).toBe(loaded)
      expect(machine.read(Cart.CODE)).toBe(0xEA)
    })

    test('unloadCart should remove a loaded cart', () => {
      machine.loadCart(new Uint8Array(Cart.SIZE).fill(0xEA))
      expect(machine.cart).toBeDefined()
      machine.unloadCart()
      expect(machine.cart).toBeUndefined()
    })

    test('a write to $E000–$FFFF banks the window', () => {
      machine.loadCart(bankedImage(0x20000))
      expect(machine.read(0xD000)).toBe(0x00)
      machine.write(0xE000, 0x03)
      expect(machine.read(0xD000)).toBe(0x03)
      // …and the fixed region ignores the register.
      expect(machine.read(0xF000)).toBe(0x0F)
    })

    test('reset clears the bank register — its /MR is on RESB', () => {
      machine.loadCart(bankedImage(0x20000))
      machine.write(0xE000, 0x07)
      expect(machine.read(0xD000)).toBe(0x07)
      machine.reset(false) // a warm reset counts: this is the one easy to miss
      expect((machine.cart as BankedCart).bank).toBe(0)
      expect(machine.read(0xD000)).toBe(0x00)
    })

    test('a write to a flat ROM cart does nothing', () => {
      machine.loadCart(new Uint8Array(Cart.SIZE).fill(0xEA))
      expect(() => machine.write(0xC000, 0x00)).not.toThrow()
      expect(machine.read(0xC000)).toBe(0xEA)
      expect(() => machine.write(0xE000, 0x00)).not.toThrow()
      expect(machine.read(0xE000)).toBe(0xEA)
    })

    test('a write above $C000 with no cart still does nothing', () => {
      expect(() => machine.write(0xC000, 0xFF)).not.toThrow()
      expect(() => machine.write(0xFFFF, 0xFF)).not.toThrow()
    })
  })

  describe('ROM Operations', () => {
    test('loadROM should load ROM data', () => {
      // Load ROM with test data
      const testData = new Uint8Array(16384).fill(0xEA) // NOP instruction
      machine.loadROM(testData)
      expect(machine.rom).toBeDefined()
    })
  })

  describe('CPU Execution', () => {
    test('step() executes one instruction', () => {
      const initialCycles = machine.cpu.cycles
      machine.step()
      // Step should execute at least one cycle
      expect(machine.cpu.cycles).toBeGreaterThanOrEqual(initialCycles)
    })

    test('tick() executes one CPU clock cycle', () => {
      const initialCycles = machine.cpu.cycles
      machine.tick()
      // tick() increments CPU state; cycles may stay same if already counted
      expect(machine.cpu.cycles).toBeGreaterThanOrEqual(initialCycles)
    })

    test('multiple steps execute multiple instructions', () => {
      const initialCycles = machine.cpu.cycles
      machine.step()
      machine.step()
      machine.step()
      expect(machine.cpu.cycles).toBeGreaterThan(initialCycles)
    })

    test('multiple ticks increment cycle counter', () => {
      const initialCycles = machine.cpu.cycles
      for (let i = 0; i < 10; i++) {
        machine.tick()
      }
      expect(machine.cpu.cycles).toBeGreaterThan(initialCycles)
    })

    /**
     * PHI2 comes from the board's 16 MHz oscillator divider, not from the CPU,
     * so a processor halted by STP or WAI must not take the cards down with it.
     * A WAI waiting on the clock card's interrupt would otherwise be waiting on
     * a card that stopped counting the moment the CPU did.
     */
    test('a STP halts the CPU without stopping the I/O cards', () => {
      // One emulated second per 100 cycles, so the clock's seconds register
      // moves within a test-sized budget.
      machine.frequency = 100
      // The empty ROM's reset vector reads $0000, which is RAM.
      machine.poke(0x0000, 0xDB)  // STP
      machine.reset(false)

      machine.runCycles(10)
      expect(machine.cpu.stopped).toBe(true)

      const RTC_SECONDS = 0x8800
      const seconds = machine.read(RTC_SECONDS)
      const cycles = machine.cycles
      const cpuCycles = machine.cpu.cycles

      machine.runCycles(1000)

      expect(machine.cpu.stopped).toBe(true)
      expect(machine.cpu.pc).toBe(0x0001)             // never fetched again
      expect(machine.cycles).toBe(cycles + 1000)      // the clock kept running
      expect(machine.cpu.cycles).toBe(cpuCycles + 1000)
      expect(machine.read(RTC_SECONDS)).not.toBe(seconds)  // ten emulated seconds
    })
  })

  describe('Input Handling', () => {
    test('onReceive() passes data to Serial card', () => {
      const acia = machine.io5 as ACIA
      const spy = jest.spyOn(acia, 'onData')
      machine.onReceive(0x41)
      expect(spy).toHaveBeenCalledWith(0x41)
      spy.mockRestore()
    })

    describe.each([
      { flowControl: true, holds: true },
      { flowControl: false, holds: false }
    ])('with flow control $flowControl', ({ flowControl, holds }) => {
      test(holds
        ? 'serialReady follows the serial card\'s RTS, and is true with no card'
        : 'serialReady stays true whatever RTS does', () => {
        machine.flowControl = flowControl
        expect(machine.serialReady).toBe(!holds) // reset: $00, RTSB high
        machine.write(0x9002, 0x09) // io5 command register: DTR on, RTSB low
        expect(machine.serialReady).toBe(true)
        machine.write(0x9002, 0x01) // DTR on, RTSB high
        expect(machine.serialReady).toBe(!holds)
        machine.write(0x9002, 0x09) // RTSB low
        expect(machine.serialReady).toBe(true)

        const bare = new Machine({ io5: new Empty() })
        bare.flowControl = flowControl
        expect(bare.serialReady).toBe(true)
      })

      test('reaches a serial card in any slot, including one fitted by the caller', () => {
        const fitted = new Machine({ io2: new ACIA() })
        fitted.flowControl = flowControl
        expect((fitted.io2 as ACIA).flowControl).toBe(flowControl)
        expect((fitted.io5 as ACIA).flowControl).toBe(flowControl)
      })

      test(holds
        ? 'input sent while RTS is high reaches the machine once RTS drops'
        : 'input sent while RTS is high reaches the machine at once', () => {
        machine.flowControl = flowControl
        machine.write(0x9002, 0x03) // DTR on, receive IRQ off, RTSB high
        machine.onReceive(0x41)
        machine.runCycles(10)
        expect(machine.read(0x9001) & 0x08).toBe(holds ? 0 : 0x08)
        machine.write(0x9002, 0x0b) // RTSB low
        machine.runCycles(10)
        expect(machine.read(0x9000)).toBe(0x41)
      })
    })

    test('flow control is on by default and survives a snapshot restore', () => {
      expect(machine.flowControl).toBe(true)
      expect((machine.io5 as ACIA).flowControl).toBe(true)
      const on = captureSnapshot(machine)
      machine.flowControl = false
      restoreSnapshot(machine, on)
      machine.reset(true)
      expect(machine.flowControl).toBe(false)
      expect((machine.io5 as ACIA).flowControl).toBe(false)
      expect(JSON.stringify(captureSnapshot(machine))).not.toContain('flowControl')
    })

    test('onKeyDown() routes key to GPIO attachments', () => {
      expect(machine.keyboardMatrixAttachment).toBeDefined()
      expect(machine.keyboardEncoderAttachment).toBeDefined()
      const matrixSpy = jest.spyOn(machine.keyboardMatrixAttachment!, 'updateKey')
      const encoderSpy = jest.spyOn(machine.keyboardEncoderAttachment!, 'updateKey')
      machine.onKeyDown(0x52) // Arrow Up USB HID keycode
      expect(matrixSpy).toHaveBeenCalledWith(0x52, true)
      expect(encoderSpy).toHaveBeenCalledWith(0x52, true)
      matrixSpy.mockRestore()
      encoderSpy.mockRestore()
    })

    test('onKeyUp() routes key to GPIO attachments', () => {
      expect(machine.keyboardMatrixAttachment).toBeDefined()
      expect(machine.keyboardEncoderAttachment).toBeDefined()
      const matrixSpy = jest.spyOn(machine.keyboardMatrixAttachment!, 'updateKey')
      const encoderSpy = jest.spyOn(machine.keyboardEncoderAttachment!, 'updateKey')
      machine.onKeyUp(0x52) // Arrow Up USB HID keycode
      expect(matrixSpy).toHaveBeenCalledWith(0x52, false)
      expect(encoderSpy).toHaveBeenCalledWith(0x52, false)
      matrixSpy.mockRestore()
      encoderSpy.mockRestore()
    })

    test('onJoystickA() routes button state to joystick A attachment', () => {
      expect(machine.joystickAttachmentA).toBeDefined()
      const spy = jest.spyOn(machine.joystickAttachmentA!, 'updateJoystick')
      machine.onJoystickA(0xFF)
      expect(spy).toHaveBeenCalledWith(0xFF)
      spy.mockRestore()
    })

    test('onJoystickB() routes button state to joystick B attachment', () => {
      expect(machine.joystickAttachmentB).toBeDefined()
      const spy = jest.spyOn(machine.joystickAttachmentB!, 'updateJoystick')
      machine.onJoystickB(0xFF)
      expect(spy).toHaveBeenCalledWith(0xFF)
      spy.mockRestore()
    })
  })

  describe('Reset Operations', () => {
    test('reset() resets CPU', () => {
      const spy = jest.spyOn(machine.cpu, 'reset')
      machine.reset(true)
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })

    test('reset(coldStart: true) performs full reset', () => {
      machine.ram.write(0x0000, 0xFF)
      expect(machine.ram.read(0x0000)).toBe(0xFF)
      machine.reset(true)
      expect(machine.ram.read(0x0000)).toBe(0x00)
    })

    test('reset(coldStart: false) performs warm reset', () => {
      machine.ram.write(0x0000, 0xFF)
      machine.reset(false)
      // Warm reset preserves RAM
      expect(machine.ram.read(0x0000)).toBe(0xFF)
    })

    test('reset() resets all IO cards', () => {
      const io1Spy = jest.spyOn(machine.io1, 'reset')
      const io2Spy = jest.spyOn(machine.io2, 'reset')
      const io3Spy = jest.spyOn(machine.io3, 'reset')
      const io4Spy = jest.spyOn(machine.io4, 'reset')
      const io5Spy = jest.spyOn(machine.io5, 'reset')
      const io6Spy = jest.spyOn(machine.io6, 'reset')
      const io7Spy = jest.spyOn(machine.io7, 'reset')
      const io8Spy = jest.spyOn(machine.io8, 'reset')

      machine.reset(true)

      expect(io1Spy).toHaveBeenCalled()
      expect(io2Spy).toHaveBeenCalled()
      expect(io3Spy).toHaveBeenCalled()
      expect(io4Spy).toHaveBeenCalled()
      expect(io5Spy).toHaveBeenCalled()
      expect(io6Spy).toHaveBeenCalled()
      expect(io7Spy).toHaveBeenCalled()
      expect(io8Spy).toHaveBeenCalled()

      io1Spy.mockRestore()
      io2Spy.mockRestore()
      io3Spy.mockRestore()
      io4Spy.mockRestore()
      io5Spy.mockRestore()
      io6Spy.mockRestore()
      io7Spy.mockRestore()
      io8Spy.mockRestore()
    })
  })

  describe('Callbacks', () => {
    test('transmit callback can be set', () => {
      const mockTransmit = jest.fn()
      machine.transmit = mockTransmit
      expect(machine.transmit).toBe(mockTransmit)
    })

    test('render callback can be set', () => {
      const mockRender = jest.fn()
      machine.render = mockRender
      expect(machine.render).toBe(mockRender)
    })

    test('ACIA uses transmit callback when set', () => {
      const mockTransmit = jest.fn()
      machine.transmit = mockTransmit
      // Trigger ACIA to transmit if possible
      const acia = machine.io5 as ACIA
      acia.transmit?.(0x41)
      expect(mockTransmit).toHaveBeenCalledWith(0x41)
    })
  })

  describe('Tap-free bus access', () => {
    /**
     * A debugger reading memory must not trip a watchpoint.
     *
     * The watchpoint is there to catch what the *program* does; having "show me
     * $0400" fire the breakpoint watching $0400 would make it unusable.
     */
    test('peek and poke do not notify the bus taps', () => {
      const onRead = jest.fn()
      const onWrite = jest.fn()
      machine.onRead = onRead
      machine.onWrite = onWrite

      machine.poke(0x0400, 0x42)
      expect(machine.peek(0x0400)).toBe(0x42)

      expect(onRead).not.toHaveBeenCalled()
      expect(onWrite).not.toHaveBeenCalled()

      // The ordinary path still does.
      machine.write(0x0400, 0x43)
      machine.read(0x0400)
      expect(onWrite).toHaveBeenCalledTimes(1)
      expect(onRead).toHaveBeenCalledTimes(1)
    })

    test('peek and poke otherwise decode addresses exactly as read and write do', () => {
      machine.write(0x0500, 0x11)
      expect(machine.peek(0x0500)).toBe(machine.read(0x0500))

      // Writes above $8000 are ignored by both, as the hardware ignores them.
      machine.poke(0xa000, 0x99)
      expect(machine.peek(0xa000)).not.toBe(0x99)
    })
  })

  describe('Configuration', () => {
    test('Machine has configurable frequency', () => {
      const originalFreq = machine.frequency
      machine.frequency = 1000000
      expect(machine.frequency).toBe(1000000)
      machine.frequency = originalFreq
    })

    test('Machine counts elapsed clock cycles', () => {
      expect(machine.cycles).toBe(0)
      machine.runCycles(100)
      expect(machine.cycles).toBe(100)
      machine.tick()
      expect(machine.cycles).toBe(101)
    })
  })

  describe('Cart and ROM Interaction', () => {
    test('Reading from cart address space when no cart is loaded returns 0', () => {
      const cartAddress = 0xC000
      expect(machine.read(cartAddress)).toBe(0)
    })

    test('Reading from ROM takes precedence when no cart', () => {
      const romAddress = 0xA000
      machine.rom.load(Array(ROM.SIZE).fill(0x00))
      const result = machine.read(romAddress)
      expect(typeof result).toBe('number')
    })
  })

  describe('Memory Region Boundaries', () => {
    test('Reading/writing at RAM boundaries', () => {
      machine.write(RAM.START, 0x11)
      expect(machine.read(RAM.START)).toBe(0x11)

      machine.write(RAM.END, 0x22)
      expect(machine.read(RAM.END)).toBe(0x22)
    })

    test('IO1 address space boundaries (0x8000-0x83FF)', () => {
      machine.write(0x8000, 0x33)
      expect(machine.io1.read(0)).toBe(0x33)

      machine.write(0x83FF, 0x44)
      expect(machine.io1.read(0x3FF)).toBe(0x44)
    })

    test('IO2 address space boundaries (0x8400-0x87FF)', () => {
      machine.write(0x8400, 0x55)
      expect(machine.io2.read(0)).toBe(0x55)

      machine.write(0x87FF, 0x66)
      expect(machine.io2.read(0x3FF)).toBe(0x66)
    })
  })
})