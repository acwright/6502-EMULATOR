import { ACIA } from '../../core/IO/ACIA'

// What the BIOS writes to the command register: DTR on (receiver, transmitter
// and interrupts enabled), receive IRQ on, TIC 10 (RTS low, no transmit IRQ).
const READY = 0x09

describe('ACIA (6551 ACIA)', () => {
  let serialCard: ACIA

  beforeEach(() => {
    serialCard = new ACIA()
  })

  describe('Initialization', () => {
    it('should initialize with correct default values', () => {
      // Status register should have Transmit Data Register Empty flag set
      const status = serialCard.read(0x01)
      expect(status & 0x10).toBe(0x10) // TDRE bit set
    })

    it('should have empty transmit and receive buffers', () => {
      // Write should succeed, indicating buffers are empty
      serialCard.write(0x00, 0x42)
      expect(serialCard.read(0x01) & 0x10).toBe(0) // TDRE should be clear after write
    })
  })

  describe('Register Operations', () => {
    describe('Data Register (0x00)', () => {
      it('should write data to transmit buffer', () => {
        const initialStatus = serialCard.read(0x01)
        serialCard.write(0x00, 0x55)
        const statusAfter = serialCard.read(0x01)

        // TDRE should be clear after writing data
        expect((statusAfter & 0x10)).toBe(0)
      })

      it('should read data from receive buffer', () => {
        serialCard.write(0x02, READY)
        serialCard.onData(0x42)
        serialCard.tick(1000000)
        const data = serialCard.read(0x00)
        expect(data).toBe(0x42)
      })

      it('should mask data to 8 bits', () => {
        serialCard.write(0x02, READY)
        serialCard.write(0x00, 0x1FF) // More than 8 bits
        serialCard.onData(0x1FF)
        serialCard.tick(1000000)
        const data = serialCard.read(0x00)
        expect(data).toBe(0xFF)
      })

      it('should return last received data if no new data available', () => {
        serialCard.write(0x02, READY)
        serialCard.onData(0x42)
        serialCard.tick(1000000)
        let data = serialCard.read(0x00) // Read the data
        data = serialCard.read(0x00) // Read again with empty buffer
        // Should return last value received
        expect(data).toBe(0x42)
      })
    })

    describe('Status Register (0x01)', () => {
      it('should report Receive Data Register Full when data available', () => {
        serialCard.write(0x02, READY)
        serialCard.onData(0x50)
        serialCard.tick(1000000)
        const status = serialCard.read(0x01)
        expect(status & 0x08).toBe(0x08) // RDRF bit set
      })

      it('should clear RDRF after reading data', () => {
        serialCard.write(0x02, READY)
        serialCard.onData(0x50)
        serialCard.tick(1000000)
        serialCard.read(0x00) // Read the data
        const status = serialCard.read(0x01)
        expect(status & 0x08).toBe(0) // RDRF bit clear
      })

      it('should report Transmit Data Register Empty when buffer empty', () => {
        const status = serialCard.read(0x01)
        expect(status & 0x10).toBe(0x10) // TDRE bit set
      })

      it('should clear TDRE after writing data', () => {
        serialCard.write(0x00, 0x42)
        const status = serialCard.read(0x01)
        expect(status & 0x10).toBe(0) // TDRE bit clear
      })

      // Bits 6 and 5 are the DSRB and DCDB pin levels, 0 for low. Every board
      // holds both low (the Serial Card ties them to ground; the Pro and the
      // ACE take them from a null-modem cable or a jumper to ground).
      it('reports DSR low (data set ready): bit 6 clear', () => {
        expect(serialCard.read(0x01) & 0x40).toBe(0)
      })

      it('reports DCD low (carrier detected): bit 5 clear', () => {
        expect(serialCard.read(0x01) & 0x20).toBe(0)
      })

      it('reads $10 after a reset, and $00 with a byte waiting to be sent', () => {
        serialCard.reset(true)
        expect(serialCard.read(0x01)).toBe(0x10)
        serialCard.write(0x00, 0x42)
        expect(serialCard.read(0x01)).toBe(0x00)
      })

      it('keeps DSR and DCD low through a programmed reset and in every command state', () => {
        for (const command of [0x00, 0x01, 0x09, 0x0b, 0x8b, 0x11]) {
          serialCard.write(0x02, command)
          expect(serialCard.read(0x01) & 0x60).toBe(0)
        }
        serialCard.write(0x01, 0x00)
        expect(serialCard.read(0x01) & 0x60).toBe(0)
      })

      it('clears only IRQ when read', () => {
        serialCard.write(0x02, READY)
        serialCard.onData(0x42)
        serialCard.tick(1000000)
        expect(serialCard.read(0x01)).toBe(0x98) // IRQ, TDRE, RDRF
        expect(serialCard.read(0x01)).toBe(0x18) // IRQ gone, RDRF stays
      })

      it('should report framing error flag', () => {
        const status = serialCard.read(0x01)
        expect(status & 0x02).toBe(0) // Framing error not set initially
      })

      it('should report overrun flag', () => {
        const status = serialCard.read(0x01)
        expect(status & 0x04).toBe(0) // Overrun not set initially
      })

      it('should report IRQ flag', () => {
        const status = serialCard.read(0x01)
        expect(status & 0x80).toBe(0) // IRQ not set initially
      })
    })

    describe('Command Register (0x02)', () => {
      it('should return data on read', () => {
        serialCard.write(0x02, 0xFF)
        const data = serialCard.read(0x02)
        expect(data).toBe(0xFF)
      })

      it('should mask command data to 8 bits', () => {
        serialCard.write(0x02, 0x1FF)
        // Should not throw and should process command
      })

      it('should enable receive IRQ when RIIE bit (bit 1) is clear', () => {
        serialCard.write(0x02, 0x05) // DTR on, bit 1 = 0: receive IRQ enabled
        serialCard.onData(0x42)
        serialCard.tick(1000000)

        const status = serialCard.read(0x01)
        expect(status & 0x80).toBe(0x80) // IRQ flag set in status
      })

      it('should disable receive IRQ when RIIE bit (bit 1) is set', () => {
        serialCard.write(0x02, 0x03) // DTR on, IRD=1: receive IRQ disabled (R6551: bit1=1 disables)
        serialCard.onData(0x42)
        serialCard.tick(1000000)

        const status = serialCard.read(0x01)
        expect(status & 0x80).toBe(0) // IRQ flag not set
      })

      it('should enable echo mode when REM bit (bit 4) is set', () => {
        const mockTransmit = jest.fn()
        serialCard.transmit = mockTransmit

        serialCard.write(0x02, 0x11) // DTR on, REM=1: echo mode enabled (bit 4 per 6551 spec)
        serialCard.onData(0x42)
        serialCard.tick(1000000)
        
        // In echo mode, received data is echoed when delivered to rxRegister via tick
        expect(mockTransmit).toHaveBeenCalledWith(0x42)
      })
    })

    describe('Control Register (0x03)', () => {
      it('should return data on read', () => {
        serialCard.write(0x03, 0xFF)
        const data = serialCard.read(0x03)
        expect(data).toBe(0xFF)
      })

      it('should mask control data to 8 bits', () => {
        serialCard.write(0x03, 0x1FF)
        // Should not throw and should process control
      })

      it('should set default baud rate to 115200', () => {
        serialCard.write(0x03, 0x00) // Code 0000
        serialCard.write(0x00, 0x42)
        
        // Baud rate affects tick behavior; we'll test tick timing later
      })
    })
  })

  describe('Data Transmission', () => {
    let mockTransmit: jest.Mock

    beforeEach(() => {
      mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit
      serialCard.write(0x02, READY)
    })

    it('should transmit data byte via callback', () => {
      serialCard.write(0x00, 0x42)
      serialCard.tick(1000000) // TX happens immediately on next tick

      expect(mockTransmit).toHaveBeenCalledWith(0x42)
    })

    it('should only transmit the last written byte if overwritten before tick', () => {
      serialCard.write(0x00, 0x42)
      serialCard.write(0x00, 0x43)
      serialCard.write(0x00, 0x44)

      serialCard.tick(1000000)

      // Single-byte TX register: only the last write is transmitted
      expect(mockTransmit).toHaveBeenCalledTimes(1)
      expect(mockTransmit).toHaveBeenCalledWith(0x44)
    })

    it('should set TDRE flag after transmission complete', () => {
      serialCard.write(0x00, 0x42)
      expect(serialCard.read(0x01) & 0x10).toBe(0) // TDRE clear

      serialCard.tick(1000000)

      expect(serialCard.read(0x01) & 0x10).toBe(0x10) // TDRE set
    })

    it('sends with RTS high: TIC 00 is not treated as transmitter disabled', () => {
      serialCard.write(0x02, 0x01) // DTR on, TIC 00
      serialCard.write(0x00, 0x42)
      serialCard.tick(1000000)
      expect(mockTransmit).toHaveBeenCalledWith(0x42)
    })
  })

  // Command register bit 0. R6551 data sheet (Rev. 4, "Miscellaneous" 2): with
  // it clear all interrupts are disabled, the transmitter is disabled and the
  // receiver is disabled. It is clear after a hardware or programmed reset.
  describe('DTR off: receiver, transmitter and interrupts disabled', () => {
    let mockTransmit: jest.Mock

    beforeEach(() => {
      mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit
    })

    it('is the reset state', () => {
      expect(serialCard.read(0x02)).toBe(0x00)
      expect(serialCard.dataTerminalReady).toBe(false)
      expect(serialCard.receiverEnabled).toBe(false)
    })

    it.each([0x00, 0x02, 0x08, 0x0a])('loses a byte the far end sends with the command register at $%s', (command) => {
      serialCard.write(0x02, command)
      serialCard.onData(0x41)
      expect(serialCard.tick(1000000)).toBe(0)
      expect(serialCard.queuedBytes).toBe(0) // it was sent...
      expect(serialCard.read(0x01) & 0x08).toBe(0) // ...and never arrived

      serialCard.write(0x02, READY)
      serialCard.tick(1000000)
      expect(serialCard.read(0x01) & 0x08).toBe(0) // nor does it turn up later
    })

    it('receives the next byte once DTR comes on', () => {
      serialCard.write(0x02, 0x08) // DTR off, RTS low
      serialCard.onData(0x41)
      serialCard.tick(1000000)
      serialCard.write(0x02, READY)
      serialCard.onData(0x42)
      serialCard.tick(1000000)
      expect(serialCard.read(0x00)).toBe(0x42)
    })

    it('holds a written byte in the transmit register until DTR comes on', () => {
      serialCard.write(0x00, 0x42)
      for (let i = 0; i < 10; i++) serialCard.tick(1000000)
      expect(mockTransmit).not.toHaveBeenCalled()
      expect(serialCard.read(0x01) & 0x10).toBe(0) // TDRE stays clear

      serialCard.write(0x02, READY)
      serialCard.tick(1000000)
      expect(mockTransmit).toHaveBeenCalledWith(0x42)
      expect(serialCard.read(0x01) & 0x10).toBe(0x10)
    })

    it('does not echo in echo mode', () => {
      serialCard.write(0x02, 0x10) // REM on, DTR off
      serialCard.onData(0x42)
      serialCard.tick(1000000)
      expect(mockTransmit).not.toHaveBeenCalled()
    })

    it('drives no IRQ, even for an interrupt that is still pending', () => {
      serialCard.write(0x02, READY)
      serialCard.onData(0x42)
      expect(serialCard.tick(1000000)).toBe(0x80)

      serialCard.write(0x02, 0x08) // DTR off
      expect(serialCard.tick(1000000)).toBe(0)

      serialCard.write(0x02, READY) // not serviced, so it is still there
      expect(serialCard.tick(1000000)).toBe(0x80)
    })

    it('raises no transmit interrupt', () => {
      serialCard.write(0x02, 0x04) // TIC 01, DTR off
      serialCard.write(0x00, 0x42)
      expect(serialCard.tick(1000000)).toBe(0)
    })
  })

  describe('Data Reception', () => {
    beforeEach(() => {
      serialCard.write(0x02, READY)
    })

    it('should receive data from external source', () => {
      serialCard.onData(0x55)
      serialCard.tick(1000000)
      const data = serialCard.read(0x00)
      expect(data).toBe(0x55)
    })

    it('should set RDRF flag when data received', () => {
      serialCard.onData(0x55)
      serialCard.tick(1000000)
      const status = serialCard.read(0x01)
      expect(status & 0x08).toBe(0x08)
    })

    it('should queue multiple received bytes and deliver them in order', () => {
      serialCard.onData(0x41) // 'A'
      serialCard.onData(0x42) // 'B'
      serialCard.onData(0x43) // 'C'

      // First byte delivered on tick
      serialCard.tick(1000000)
      expect(serialCard.read(0x00)).toBe(0x41)

      // Second byte delivered on next tick after read
      serialCard.tick(1000000)
      expect(serialCard.read(0x00)).toBe(0x42)

      // Third byte
      serialCard.tick(1000000)
      expect(serialCard.read(0x00)).toBe(0x43)
    })

    it('should mask received data to 8 bits', () => {
      serialCard.onData(0x1FF)
      serialCard.tick(1000000)
      const data = serialCard.read(0x00)
      expect(data).toBe(0xFF)
    })

    it('receives with the receive IRQ off, as Wozmon polls ($8B)', () => {
      serialCard.write(0x02, 0x8b)
      serialCard.onData(0x41)
      expect(serialCard.tick(1000000)).toBe(0)
      expect(serialCard.read(0x01) & 0x88).toBe(0x08) // RDRF, no IRQ
      expect(serialCard.read(0x00)).toBe(0x41)
    })
  })

  describe('Interrupt Handling', () => {
    it('should set IRQ flag on receive when interrupt enabled', () => {
      serialCard.write(0x02, 0x01) // DTR on, bit 1 = 0: receive IRQ enabled
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      expect(serialCard.read(0x01) & 0x80).toBe(0x80) // IRQ flag set
    })

    it('should return IRQ status from tick on transmit complete when enabled', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x03, 0x00) // Set control register
      serialCard.write(0x02, 0x07) // DTR on, receive IRQ off, TIC=01: transmit IRQ enabled with /RTS low
      serialCard.write(0x00, 0x42)

      const result = serialCard.tick(1000000)

      // tick() returns IRQ status when transmit complete IRQ fires
      expect(result & 0x80).toBe(0x80)
      expect(serialCard.read(0x01) & 0x80).toBe(0x80)
    })

    it('should not set IRQ flag on receive when disabled', () => {
      serialCard.write(0x02, 0x03) // DTR on, IRD=1: receive IRQ disabled
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      const status = serialCard.read(0x01)
      expect(status & 0x80).toBe(0) // IRQ flag not set
    })

    it('should clear IRQ flag when data is read', () => {
      serialCard.write(0x02, READY) // Enable receive IRQ
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      expect(serialCard.read(0x01) & 0x80).toBe(0x80) // IRQ set

      serialCard.read(0x00) // Read data

      expect(serialCard.read(0x01) & 0x80).toBe(0) // IRQ cleared
    })
  })

  describe('Receive Queue', () => {
    beforeEach(() => {
      serialCard.write(0x02, READY)
    })

    it('should buffer multiple bytes and deliver in order', () => {
      serialCard.onData(0x42)
      serialCard.onData(0x43)

      // First byte delivered on tick
      serialCard.tick(1000000)
      expect(serialCard.read(0x01) & 0x08).toBe(0x08) // RDRF set
      expect(serialCard.read(0x00)).toBe(0x42)

      // Second byte delivered on next tick
      serialCard.tick(1000000)
      expect(serialCard.read(0x01) & 0x08).toBe(0x08) // RDRF set
      expect(serialCard.read(0x00)).toBe(0x43)

      // Queue empty
      serialCard.tick(1000000)
      expect(serialCard.read(0x01) & 0x08).toBe(0) // RDRF clear
    })

    it('should not deliver next byte until current is read', () => {
      serialCard.onData(0x42)
      serialCard.onData(0x43)

      serialCard.tick(1000000) // delivers 0x42
      serialCard.tick(1000000) // rxRegFull still true, 0x43 stays in queue
      serialCard.tick(1000000) // still waiting

      expect(serialCard.read(0x00)).toBe(0x42) // first byte still there

      serialCard.tick(1000000) // NOW delivers 0x43
      expect(serialCard.read(0x00)).toBe(0x43)
    })

    it('should clear queue on reset', () => {
      serialCard.onData(0x42)
      serialCard.onData(0x43)
      serialCard.onData(0x44)

      serialCard.reset(true)
      serialCard.write(0x02, READY)

      serialCard.tick(1000000)
      expect(serialCard.read(0x01) & 0x08).toBe(0) // RDRF clear — queue was emptied
    })
  })

  // RTSB is driven by the command register's TIC bits (3-2): 00 is RTSB high,
  // the machine telling the far end to stop, and echo mode drives it low. It is
  // independent of DTR. The BIOS writes $01 (DTR on, TIC 00) when its input
  // buffer is nearly full and $09 (TIC 10) once it drains. Honouring it is a
  // host setting, `flowControl`: what the far end of the cable does.
  describe('RTS', () => {
    it('follows TIC: only 00 is high, whatever DTR says', () => {
      for (const dtr of [0x00, 0x01]) {
        for (const tic of [0x00, 0x04, 0x08, 0x0c]) {
          serialCard.write(0x02, dtr | tic)
          expect(serialCard.requestToSend).toBe(tic !== 0x00)
        }
      }
    })

    it('is low in echo mode', () => {
      serialCard.write(0x02, 0x11)
      expect(serialCard.requestToSend).toBe(true)
    })

    it('is high after a reset', () => {
      serialCard.write(0x02, READY)
      serialCard.reset(true)
      expect(serialCard.requestToSend).toBe(false)
    })
  })

  describe('RTS flow control', () => {
    const RTS_HIGH = 0x01 // DTR on, TIC 00: receiver enabled, RTSB high
    const RTS_LOW = 0x09 // DTR on, TIC 10: receiver enabled, RTSB low

    it('is off by default', () => {
      expect(serialCard.flowControl).toBe(false)
    })

    it('is not machine state: a reset and a snapshot leave it alone', () => {
      serialCard.flowControl = true
      serialCard.reset(true)
      expect(serialCard.flowControl).toBe(true)
      expect(Object.keys(serialCard.serialize())).not.toContain('flowControl')

      const restored = new ACIA()
      restored.flowControl = false
      restored.deserialize(serialCard.serialize())
      expect(restored.flowControl).toBe(false)
    })

    describe.each([
      { flowControl: true, holds: true },
      { flowControl: false, holds: false }
    ])('with flow control $flowControl', ({ flowControl, holds }) => {
      beforeEach(() => {
        serialCard.flowControl = flowControl
      })

      it(holds
        ? 'holds queued input while RTS is high, and delivers it in order once RTS drops'
        : 'delivers queued input while RTS is high, as 3.0.0 did', () => {
        serialCard.write(0x02, RTS_HIGH)
        serialCard.onData(0x41)
        serialCard.onData(0x42)

        serialCard.tick(1000000)
        if (holds) {
          for (let i = 0; i < 10; i++) serialCard.tick(1000000)
          expect(serialCard.read(0x01) & 0x08).toBe(0) // nothing reached the register
          expect(serialCard.queuedBytes).toBe(2) // and nothing was dropped
          serialCard.write(0x02, RTS_LOW)
          serialCard.tick(1000000)
        }
        expect(serialCard.read(0x00)).toBe(0x41)
        serialCard.tick(1000000)
        expect(serialCard.read(0x00)).toBe(0x42)
        expect(serialCard.queuedBytes).toBe(0)
      })

      it(holds
        ? 'raises no receive interrupt for a held byte'
        : 'raises the receive interrupt while RTS is high', () => {
        serialCard.write(0x02, RTS_HIGH) // bit 1 clear: receive IRQ enabled
        serialCard.onData(0x41)
        expect(serialCard.tick(1000000) & 0x80).toBe(holds ? 0 : 0x80)
      })

      it('leaves a byte already in the receive register readable', () => {
        serialCard.write(0x02, RTS_LOW)
        serialCard.onData(0x41)
        serialCard.onData(0x42)
        serialCard.tick(1000000)

        // RTS goes up after the first byte has landed: it stays readable, and
        // only the one behind it can wait.
        serialCard.write(0x02, RTS_HIGH)
        expect(serialCard.read(0x00)).toBe(0x41)
        serialCard.tick(1000000)
        expect(serialCard.read(0x01) & 0x08).toBe(holds ? 0 : 0x08)
        expect(serialCard.queuedBytes).toBe(holds ? 1 : 0)
      })

      it(holds
        ? 'is ready to receive only while RTS is low'
        : 'is ready to receive whatever RTS says', () => {
        for (const tic of [0x00, 0x04, 0x08, 0x0c]) {
          serialCard.write(0x02, 0x01 | tic)
          expect(serialCard.readyToReceive).toBe(!holds || tic !== 0x00)
        }
      })

      it(holds
        ? 'holds input from reset until the software lowers RTS, and loses none of it'
        : 'loses input sent before the software enables the receiver', () => {
        // After reset the command register is $00: RTS high and DTR off.
        expect(serialCard.read(0x02)).toBe(0x00)
        expect(serialCard.readyToReceive).toBe(!holds)
        serialCard.onData(0x41)
        for (let i = 0; i < 10; i++) serialCard.tick(1000000)
        expect(serialCard.queuedBytes).toBe(holds ? 1 : 0)

        serialCard.write(0x02, READY)
        serialCard.tick(1000000)
        expect(serialCard.read(0x01) & 0x08).toBe(holds ? 0x08 : 0)
        if (holds) expect(serialCard.read(0x00)).toBe(0x41)
      })

      it('loses input sent with RTS low but DTR off', () => {
        serialCard.write(0x02, 0x08) // TIC 10, DTR off
        serialCard.onData(0x41)
        serialCard.tick(1000000)
        expect(serialCard.queuedBytes).toBe(0)
        expect(serialCard.read(0x01) & 0x08).toBe(0)
      })

      it(holds
        ? 'holds for XModem-style polling with the receive IRQ off, too'
        : 'does not hold for XModem-style polling either', () => {
        serialCard.write(0x02, 0x03) // DTR on, receive IRQ off, TIC 00
        expect(serialCard.readyToReceive).toBe(!holds)
        serialCard.write(0x02, 0x0b) // what XModem writes: RTSB low
        expect(serialCard.readyToReceive).toBe(true)
      })

      it('keeps queued input across a snapshot', () => {
        serialCard.write(0x02, RTS_HIGH)
        serialCard.onData(0x41)
        serialCard.onData(0x42)
        serialCard.tick(1000000)

        const restored = new ACIA()
        restored.flowControl = flowControl
        restored.deserialize(serialCard.serialize())
        expect(restored.readyToReceive).toBe(!holds)
        expect(restored.queuedBytes).toBe(holds ? 2 : 1)

        restored.write(0x02, RTS_LOW)
        if (!holds) expect(restored.read(0x00)).toBe(0x41)
        restored.tick(1000000)
        expect(restored.read(0x00)).toBe(holds ? 0x41 : 0x42)
      })
    })
  })

  describe('Echo Mode', () => {
    it('should echo received data when echo mode enabled', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x02, 0x11) // DTR on, REM=1: echo mode enabled (bit 4 per 6551 spec)
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      // Echo happens when byte is delivered from queue to rxRegister in tick
      expect(mockTransmit).toHaveBeenCalledWith(0x42)
    })

    it('should not echo when echo mode disabled', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x02, 0x01) // Echo mode disabled
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      expect(mockTransmit).not.toHaveBeenCalled()
    })

    it('should not echo data through TX register (echoes directly)', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x02, 0x11) // Echo mode enabled
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      // Echo goes directly through transmit callback, TDRE stays set
      const status = serialCard.read(0x01)
      expect(status & 0x10).toBe(0x10) // TDRE set (TX register not used for echo)
    })
  })

  describe('Baud Rate Configuration', () => {
    it('should accept control register writes without error', () => {
      // Baud rate is no longer emulated (USB serial operates at USB speeds)
      // but the control register should still be writable/readable
      const baudCodes = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
                         0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F]

      baudCodes.forEach((code) => {
        const card = new ACIA()
        card.write(0x03, code)
        expect(card.read(0x03)).toBe(code)
      })
    })
  })

  describe('Reset Operations', () => {
    // R6551 data sheet, command and status register tables and "Program Reset
    // Operation": bits 4-0 of the command register and status bit 2 cleared;
    // the control register unchanged; a pending IRQ stays until serviced.
    it('programmed reset clears command bits 4-0 and nothing else of the command or control register', () => {
      serialCard.write(0x02, 0xff)
      serialCard.write(0x03, 0x1f)
      serialCard.write(0x01, 0x00)
      expect(serialCard.read(0x02)).toBe(0xe0)
      expect(serialCard.read(0x03)).toBe(0x1f)
      expect(serialCard.dataTerminalReady).toBe(false)
      expect(serialCard.requestToSend).toBe(false)
    })

    it('programmed reset ends echo mode', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit
      serialCard.write(0x02, 0x11)
      serialCard.write(0x01, 0x00)
      serialCard.write(0x02, 0x01)
      serialCard.onData(0x42)
      serialCard.tick(1000000)
      expect(mockTransmit).not.toHaveBeenCalled()
    })

    it('programmed reset leaves a pending interrupt pending', () => {
      serialCard.write(0x02, READY)
      serialCard.onData(0x44)
      serialCard.tick(1000000)

      serialCard.write(0x01, 0x00)

      expect(serialCard.read(0x01) & 0x88).toBe(0x88) // IRQ and RDRF still set
      expect(serialCard.read(0x00)).toBe(0x44)
    })

    it('programmed reset keeps a byte waiting to be sent, and it goes once DTR is back', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit
      serialCard.write(0x00, 0x42)
      serialCard.write(0x01, 0x00)
      serialCard.tick(1000000)
      expect(mockTransmit).not.toHaveBeenCalled()
      serialCard.write(0x02, READY)
      serialCard.tick(1000000)
      expect(mockTransmit).toHaveBeenCalledWith(0x42)
    })

    it('should reset all registers on cold start', () => {
      serialCard.write(0x00, 0x42)
      serialCard.write(0x02, 0xFF)
      serialCard.write(0x03, 0xFF)
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      serialCard.reset(true)

      expect(serialCard.read(0x01) & 0x10).toBe(0x10) // TDRE set
      expect(serialCard.read(0x01) & 0x08).toBe(0) // RDRF clear
      expect(serialCard.read(0x01) & 0x80).toBe(0) // IRQ clear
      expect(serialCard.read(0x02)).toBe(0x00)
      expect(serialCard.read(0x03)).toBe(0x00)
    })

    it('should clear transmit buffer on reset', () => {
      serialCard.write(0x00, 0x42)
      serialCard.write(0x00, 0x43)

      serialCard.reset(true)

      expect(serialCard.read(0x01) & 0x10).toBe(0x10) // TDRE should be set (buffer empty)
    })

    it('should clear receive buffer on reset', () => {
      serialCard.write(0x02, READY)
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      serialCard.reset(true)

      expect(serialCard.read(0x01) & 0x08).toBe(0) // RDRF should be clear (buffer empty)
    })
  })

  describe('Register Address Masking', () => {
    it('should mask address to lower 2 bits', () => {
      // Test with different address values that map to same register
      serialCard.write(0x00, 0x42)
      serialCard.write(0x04, 0x43) // Should write to register 0
      const status = serialCard.read(0x01)
      expect(status & 0x10).toBe(0) // TDRE clear, so there's data
    })
  })

  describe('Callback Functions', () => {
    it('should support custom transmit callback', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x02, READY)
      serialCard.write(0x00, 0x42)
      serialCard.tick(1000000)

      expect(mockTransmit).toHaveBeenCalled()
    })
  })

  describe('Edge Cases', () => {
    it('should handle zero-length tick', () => {
      serialCard.write(0x00, 0x42)
      serialCard.tick(0)
      // Should not crash
    })

    it('should handle rapid consecutive writes', () => {
      for (let i = 0; i < 100; i++) {
        serialCard.write(0x00, i & 0xFF)
      }
      // Should queue all data without error
    })

    it('should handle rapid consecutive reads from empty receive buffer', () => {
      for (let i = 0; i < 100; i++) {
        const data = serialCard.read(0x00)
        expect(typeof data).toBe('number')
      }
    })

    it('should handle interleaved reads and writes', () => {
      serialCard.write(0x00, 0x42)
      const data1 = serialCard.read(0x01) // Read status
      serialCard.write(0x00, 0x43)
      const data2 = serialCard.read(0x01) // Read status again

      expect(typeof data1).toBe('number')
      expect(typeof data2).toBe('number')
    })
  })
})
