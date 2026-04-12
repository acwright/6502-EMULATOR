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
        serialCard.tick(1000000)
        const data = serialCard.read(0x00)
        expect(data).toBe(0x42)
      })

      it('should mask data to 8 bits', () => {
        serialCard.write(0x00, 0x1FF) // More than 8 bits
        serialCard.onData(0x1FF)
        serialCard.tick(1000000)
        const data = serialCard.read(0x00)
        expect(data).toBe(0xFF)
      })

      it('should return last received data if no new data available', () => {
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
        serialCard.onData(0x50)
        serialCard.tick(1000000)
        const status = serialCard.read(0x01)
        expect(status & 0x08).toBe(0x08) // RDRF bit set
      })

      it('should clear RDRF after reading data', () => {
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

      it('should enable receive IRQ when RIIE bit (bit 1) is clear', () => {
        serialCard.write(0x02, 0x04) // bit 1 = 0: receive IRQ enabled
        serialCard.onData(0x42)
        serialCard.tick(1000000)

        const status = serialCard.read(0x01)
        expect(status & 0x80).toBe(0x80) // IRQ flag set in status
      })

      it('should disable receive IRQ when RIIE bit (bit 1) is set', () => {
        serialCard.write(0x02, 0x02) // RIIE=1: receive IRQ disabled (R6551: bit1=1 disables)
        serialCard.onData(0x42)
        serialCard.tick(1000000)

        const status = serialCard.read(0x01)
        expect(status & 0x80).toBe(0) // IRQ flag not set
      })

      it('should enable echo mode when REM bit (bit 4) is set', () => {
        const mockTransmit = jest.fn()
        serialCard.transmit = mockTransmit

        serialCard.write(0x02, 0x10) // REM=1: echo mode enabled (bit 4 per 6551 spec)
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
    it('should transmit data byte via callback', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x00, 0x42)
      serialCard.tick(1000000) // TX happens immediately on next tick

      expect(mockTransmit).toHaveBeenCalledWith(0x42)
    })

    it('should only transmit the last written byte if overwritten before tick', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x00, 0x42)
      serialCard.write(0x00, 0x43)
      serialCard.write(0x00, 0x44)

      serialCard.tick(1000000)

      // Single-byte TX register: only the last write is transmitted
      expect(mockTransmit).toHaveBeenCalledTimes(1)
      expect(mockTransmit).toHaveBeenCalledWith(0x44)
    })

    it('should set TDRE flag after transmission complete', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x00, 0x42)
      expect(serialCard.read(0x01) & 0x10).toBe(0) // TDRE clear

      serialCard.tick(1000000)

      expect(serialCard.read(0x01) & 0x10).toBe(0x10) // TDRE set
    })
  })

  describe('Data Reception', () => {
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
  })

  describe('Interrupt Handling', () => {
    it('should set IRQ flag on receive when interrupt enabled', () => {
      serialCard.write(0x02, 0x00) // bit 1 = 0: receive IRQ enabled
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      expect(serialCard.read(0x01) & 0x80).toBe(0x80) // IRQ flag set
    })

    it('should return IRQ status from tick on transmit complete when enabled', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x03, 0x00) // Set control register
      serialCard.write(0x02, 0x04) // TIC=01: transmit IRQ enabled with /RTS low (bits 3-2 = 01)
      serialCard.write(0x00, 0x42)

      const result = serialCard.tick(1000000)

      // tick() returns IRQ status when transmit complete IRQ fires
      expect(result & 0x80).toBe(0x80)
      expect(serialCard.read(0x01) & 0x80).toBe(0x80)
    })

    it('should not set IRQ flag on receive when disabled', () => {
      serialCard.write(0x02, 0x02) // RIIE=1: receive IRQ disabled
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      const status = serialCard.read(0x01)
      expect(status & 0x80).toBe(0) // IRQ flag not set
    })

    it('should clear IRQ flag when data is read', () => {
      serialCard.write(0x02, 0x00) // Enable receive IRQ
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      expect(serialCard.read(0x01) & 0x80).toBe(0x80) // IRQ set

      serialCard.read(0x00) // Read data

      expect(serialCard.read(0x01) & 0x80).toBe(0) // IRQ cleared
    })
  })

  describe('Receive Queue', () => {
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

      serialCard.tick(1000000)
      expect(serialCard.read(0x01) & 0x08).toBe(0) // RDRF clear — queue was emptied
    })
  })

  describe('Echo Mode', () => {
    it('should echo received data when echo mode enabled', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x02, 0x10) // REM=1: echo mode enabled (bit 4 per 6551 spec)
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      // Echo happens when byte is delivered from queue to rxRegister in tick
      expect(mockTransmit).toHaveBeenCalledWith(0x42)
    })

    it('should not echo when echo mode disabled', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x02, 0x00) // Echo mode disabled
      serialCard.onData(0x42)
      serialCard.tick(1000000)

      expect(mockTransmit).not.toHaveBeenCalled()
    })

    it('should not echo data through TX register (echoes directly)', () => {
      const mockTransmit = jest.fn()
      serialCard.transmit = mockTransmit

      serialCard.write(0x02, 0x10) // Echo mode enabled
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
    it('should perform programmed reset', () => {
      // First setup: send some data so transmit buffer is not empty
      serialCard.write(0x00, 0x42)
      serialCard.write(0x00, 0x43)
      serialCard.write(0x02, 0xFF) // Set command register
      serialCard.onData(0x44)
      serialCard.tick(1000000)
      
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
      serialCard.tick(1000000)

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