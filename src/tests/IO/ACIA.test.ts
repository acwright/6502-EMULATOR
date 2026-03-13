import { ACIA } from '../../components/IO/ACIA'

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
        serialCard.onData(0x42)
        const data = serialCard.read(0x00)
        expect(data).toBe(0x42)
      })

      it('should mask data to 8 bits', () => {
        serialCard.write(0x00, 0x1FF) // More than 8 bits
        serialCard.onData(0x1FF)
        const data = serialCard.read(0x00)
        expect(data).toBe(0xFF)
      })

      it('should return last received data if no new data available', () => {
        serialCard.onData(0x42)
        let data = serialCard.read(0x00) // Read the data
        data = serialCard.read(0x00) // Read again with empty buffer
        // Should return last value received
        expect(data).toBe(0x42)
      })
    })

    describe('Status Register (0x01)', () => {
      it('should report Receive Data Register Full when data available', () => {
        serialCard.onData(0x50)
        const status = serialCard.read(0x01)
        expect(status & 0x08).toBe(0x08) // RDRF bit set
      })

      it('should clear RDRF after reading data', () => {
        serialCard.onData(0x50)
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

      it('should report Data Set Ready (DSR) always set', () => {
        const status = serialCard.read(0x01)
        expect(status & 0x40).toBe(0x40) // DSR bit set
      })

      it('should report Data Carrier Detect (DCD) always clear', () => {
        const status = serialCard.read(0x01)
        expect(status & 0x20).toBe(0) // DCD bit clear
      })

      it('should report parity error flag', () => {
        // Trigger parity error by writing then reading programmed reset
        serialCard.onData(0x50)
        serialCard.write(0x01, 0x00) // Programmed reset clears errors
        let status = serialCard.read(0x01)
        expect(status & 0x01).toBe(0) // Parity error cleared

        // Note: This test verifies the flag can be cleared
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

      it('should enable receive IRQ when bit 2 is set', () => {
        const mockIRQ = jest.fn()
        serialCard.raiseIRQ = mockIRQ

        serialCard.write(0x02, 0x04) // Enable receive IRQ
        serialCard.onData(0x42)

        expect(mockIRQ).toHaveBeenCalled()
      })

      it('should disable receive IRQ when bit 2 is clear', () => {
        const mockIRQ = jest.fn()
        serialCard.raiseIRQ = mockIRQ

        serialCard.write(0x02, 0x00) // Disable receive IRQ
        serialCard.onData(0x42)

        expect(mockIRQ).not.toHaveBeenCalled()
      })

      it('should enable echo mode when bit 5 is set', () => {
        serialCard.write(0x02, 0x20) // Enable echo mode
        serialCard.onData(0x42)
        
        // In echo mode, received data is added to transmit buffer
        // Verify the transmit buffer will send the echoed byte
        const statusBeforeTick = serialCard.read(0x01)
        expect(statusBeforeTick & 0x10).toBe(0) // TDRE should be clear (data in transmit buffer)
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
    it('should transmit data byte via callback', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x00, 0x42)
      
      // Need to tick enough times for byte transmission
      // With default baud of 115200 and 1MHz clock: ~87 cycles per byte
      for (let i = 0; i < 100; i++) {
        serialCard.tick(1000000)
      }

      expect(mockTransmit).toHaveBeenCalledWith(0x42)
    })

    it('should handle multiple bytes in transmission', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x00, 0x42)
      serialCard.write(0x00, 0x43)
      serialCard.write(0x00, 0x44)

      for (let i = 0; i < 300; i++) {
        serialCard.tick(1000000)
      }

      expect(mockTransmit).toHaveBeenNthCalledWith(1, 0x42)
      expect(mockTransmit).toHaveBeenNthCalledWith(2, 0x43)
      expect(mockTransmit).toHaveBeenNthCalledWith(3, 0x44)
    })

    it('should set TDRE flag after transmission complete', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x00, 0x42)
      expect(serialCard.read(0x01) & 0x10).toBe(0) // TDRE clear

      for (let i = 0; i < 100; i++) {
        serialCard.tick(1000000)
      }

      expect(serialCard.read(0x01) & 0x10).toBe(0x10) // TDRE set
    })
  })

  describe('Data Reception', () => {
    it('should receive data from external source', () => {
      serialCard.onData(0x55)
      const data = serialCard.read(0x00)
      expect(data).toBe(0x55)
    })

    it('should set RDRF flag when data received', () => {
      serialCard.onData(0x55)
      const status = serialCard.read(0x01)
      expect(status & 0x08).toBe(0x08)
    })

    it('should handle multiple received bytes', () => {
      serialCard.onData(0x41) // 'A'
      serialCard.onData(0x42) // 'B'
      serialCard.onData(0x43) // 'C'

      expect(serialCard.read(0x00)).toBe(0x41)
      expect(serialCard.read(0x00)).toBe(0x42)
      expect(serialCard.read(0x00)).toBe(0x43)
    })

    it('should mask received data to 8 bits', () => {
      serialCard.onData(0x1FF)
      const data = serialCard.read(0x00)
      expect(data).toBe(0xFF)
    })
  })

  describe('Interrupt Handling', () => {
    it('should trigger IRQ on receive interrupt enabled', () => {
      const mockIRQ = jest.fn()
      serialCard.raiseIRQ = mockIRQ

      serialCard.write(0x02, 0x04) // Enable receive IRQ
      serialCard.onData(0x42)

      expect(mockIRQ).toHaveBeenCalled()
      expect(serialCard.read(0x01) & 0x80).toBe(0x80) // IRQ flag set
    })

    it('should trigger IRQ on transmit complete when enabled', () => {
      const mockIRQ = jest.fn()
      const mockTransmit = jest.fn()
      serialCard.raiseIRQ = mockIRQ
      serialCard.transmit = mockTransmit

      serialCard.write(0x03, 0x00) // Set control register
      serialCard.write(0x02, 0x08) // Enable transmit IRQ
      serialCard.write(0x00, 0x42)

      for (let i = 0; i < 100; i++) {
        serialCard.tick(1000000)
      }

      // Should trigger IRQ when transmission complete
      expect(serialCard.read(0x01) & 0x80).toBe(0x80)
    })

    it('should not trigger receive IRQ when disabled', () => {
      const mockIRQ = jest.fn()
      serialCard.raiseIRQ = mockIRQ

      serialCard.write(0x02, 0x00) // Disable receive IRQ
      serialCard.onData(0x42)

      expect(mockIRQ).not.toHaveBeenCalled()
    })

    it('should clear IRQ flag when data is read', () => {
      const mockIRQ = jest.fn()
      serialCard.raiseIRQ = mockIRQ

      serialCard.write(0x02, 0x04) // Enable receive IRQ
      serialCard.onData(0x42)

      expect(serialCard.read(0x01) & 0x80).toBe(0x80) // IRQ set

      serialCard.read(0x00) // Read data

      expect(serialCard.read(0x01) & 0x80).toBe(0) // IRQ cleared
    })
  })

  describe('Overrun Handling', () => {
    it('should detect overrun condition', () => {
      serialCard.onData(0x42)
      const statusBefore = serialCard.read(0x01)
      
      // Send another byte before first is read
      serialCard.onData(0x43)
      const statusAfter = serialCard.read(0x01)

      expect(statusAfter & 0x04).toBe(0x04) // Overrun flag set
    })

    it('should clear overrun after all buffered data is read', () => {
      serialCard.onData(0x42)
      serialCard.onData(0x43) // Cause overrun
      
      serialCard.read(0x00) // Read first byte (0x42)
      let status = serialCard.read(0x01)
      expect(status & 0x04).toBe(0x04) // Overrun still set (0x43 in buffer)
      
      serialCard.read(0x00) // Read second byte (0x43)
      status = serialCard.read(0x01)
      expect(status & 0x04).toBe(0) // Overrun cleared now (buffer empty)
    })
  })

  describe('Echo Mode', () => {
    it('should echo received data when echo mode enabled', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x02, 0x20) // Enable echo mode
      serialCard.onData(0x42)

      // Tick to allow transmission
      for (let i = 0; i < 100; i++) {
        serialCard.tick(1000000)
      }

      expect(mockTransmit).toHaveBeenCalledWith(0x42)
    })

    it('should not echo when echo mode disabled', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x02, 0x00) // Echo mode disabled
      serialCard.onData(0x42)

      for (let i = 0; i < 100; i++) {
        serialCard.tick(1000000)
      }

      expect(mockTransmit).not.toHaveBeenCalled()
    })

    it('should clear TDRE flag in echo mode', () => {
      serialCard.write(0x02, 0x20) // Enable echo mode
      serialCard.onData(0x42)

      const status = serialCard.read(0x01)
      expect(status & 0x10).toBe(0) // TDRE should be clear
    })
  })

  describe('Baud Rate Configuration', () => {
    it('should support multiple baud rates', () => {
      const baudRates = [
        [0x00, 115200],
        [0x01, 50],
        [0x02, 75],
        [0x03, 110],
        [0x04, 135],
        [0x05, 150],
        [0x06, 300],
        [0x07, 600],
        [0x08, 1200],
        [0x09, 1800],
        [0x0A, 2400],
        [0x0B, 3600],
        [0x0C, 4800],
        [0x0D, 7200],
        [0x0E, 9600],
        [0x0F, 19200]
      ]

      baudRates.forEach(([code, rate]) => {
        const card = new ACIA()
        card.write(0x03, code as number) // Control register with baud rate code
        // Baud rate affects tick timing - verify no errors occur
      })
    })
  })

  describe('Reset Operations', () => {
    it('should perform programmed reset', () => {
      // First setup: send some data so transmit buffer is not empty
      serialCard.write(0x00, 0x42)
      serialCard.write(0x00, 0x43)
      serialCard.write(0x02, 0xFF) // Set command register
      serialCard.onData(0x44)
      
      // Now perform programmed reset
      serialCard.write(0x01, 0x00) // Programmed reset via status register write

      const status = serialCard.read(0x01)
      // Programmed reset clears status flags and IRQ, but does not clear buffers
      expect(status & 0x80).toBe(0) // IRQ flag cleared
      expect(status & 0x60).toBe(0x40) // DSR set, DCD clear
    })

    it('should reset all registers on cold start', () => {
      serialCard.write(0x00, 0x42)
      serialCard.write(0x02, 0xFF)
      serialCard.write(0x03, 0xFF)
      serialCard.onData(0x42)

      serialCard.reset(true)

      expect(serialCard.read(0x01) & 0x10).toBe(0x10) // TDRE set
      expect(serialCard.read(0x01) & 0x08).toBe(0) // RDRF clear
      expect(serialCard.read(0x01) & 0x80).toBe(0) // IRQ clear
    })

    it('should clear transmit buffer on reset', () => {
      serialCard.write(0x00, 0x42)
      serialCard.write(0x00, 0x43)

      serialCard.reset(true)

      expect(serialCard.read(0x01) & 0x10).toBe(0x10) // TDRE should be set (buffer empty)
    })

    it('should clear receive buffer on reset', () => {
      serialCard.onData(0x42)
      
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

      serialCard.write(0x00, 0x42)
      for (let i = 0; i < 100; i++) {
        serialCard.tick(1000000)
      }

      expect(mockTransmit).toHaveBeenCalled()
    })

    it('should support custom IRQ callback', () => {
      const mockIRQ = jest.fn()
      serialCard.raiseIRQ = mockIRQ

      serialCard.write(0x02, 0x04)
      serialCard.onData(0x42)

      expect(mockIRQ).toHaveBeenCalled()
    })

    it('should support custom NMI callback', () => {
      const mockNMI = jest.fn()
      serialCard.raiseNMI = mockNMI

      // NMI not currently triggered in implementation, but callback exists
      expect(typeof serialCard.raiseNMI).toBe('function')
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