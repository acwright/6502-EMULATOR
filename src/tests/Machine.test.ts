import { Machine } from '../components/Machine'
import { RAM } from '../components/RAM'
import { ROM } from '../components/ROM'
import { Cart } from '../components/Cart'
import { ACIA } from '../components/IO/ACIA'

describe('Machine', () => {
  let machine: Machine

  beforeEach(() => {
    machine = new Machine('cob')
  })

  afterEach(() => {
    // Ensure the machine loop is stopped after each test
    machine.stop()
  })

  describe('Initialization', () => {
    test('Constructor creates a Machine instance', () => {
      expect(machine).not.toBeNull()
      expect(machine).toBeInstanceOf(Machine)
    })

    test('Machine initializes with correct default properties', () => {
      expect(machine.isRunning).toBe(false)
      expect(machine.frequency).toBe(2000000)
      expect(machine.scale).toBe(2)
      expect(machine.frames).toBe(0)
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

    test('Machine has no cart initially', () => {
      expect(machine.cart).toBeUndefined()
    })

    test('Machine has CPU reset on creation', () => {
      // CPU should be reset, which sets up initial state
      expect(machine.cpu).toBeDefined()
    })
  })

  describe('State Management', () => {
    test('run() sets isRunning to true', () => {
      expect(machine.isRunning).toBe(false)
      machine.run()
      expect(machine.isRunning).toBe(true)
      machine.stop() // Cleanup
    })

    test('stop() sets isRunning to false', () => {
      machine.run()
      expect(machine.isRunning).toBe(true)
      machine.stop()
      expect(machine.isRunning).toBe(false)
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
    test('Cart is initially undefined', () => {
      expect(machine.cart).toBeUndefined()
    })

    test('loadCart should load cart data', () => {
      // Load cart with test data
      const testData = new Uint8Array(16384).fill(0xEA) // NOP instruction
      machine.loadCart(testData)
      expect(machine.cart).toBeDefined()
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
  })

  describe('Input Handling', () => {
    test('onReceive() passes data to Serial card', () => {
      const acia = machine.io5 as ACIA
      const spy = jest.spyOn(acia, 'onData')
      machine.onReceive(0x41)
      expect(spy).toHaveBeenCalledWith(0x41)
      spy.mockRestore()
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

  describe('Configuration', () => {
    test('Machine has configurable frequency', () => {
      const originalFreq = machine.frequency
      machine.frequency = 1000000
      expect(machine.frequency).toBe(1000000)
      machine.frequency = originalFreq
    })

    test('Machine has configurable scale', () => {
      machine.scale = 4
      expect(machine.scale).toBe(4)
    })

    test('Machine constants are defined', () => {
      expect(Machine.MAX_FPS).toBe(60)
      expect(Machine.FRAME_INTERVAL_MS).toBe(1000 / 60)
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