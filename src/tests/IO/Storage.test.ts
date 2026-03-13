import { Storage } from '../../components/IO/Storage'
import { writeFile, unlink, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('Storage (Compact Flash in IDE Mode)', () => {
  let storageCard: Storage

  beforeEach(() => {
    storageCard = new Storage()
  })

  describe('Initialization', () => {
    it('should initialize with correct default register values', () => {
      expect(storageCard.read(0x01)).toBe(0x00) // Error Register
      expect(storageCard.read(0x02)).toBe(0x00) // Sector Count
      expect(storageCard.read(0x03)).toBe(0x00) // LBA0
      expect(storageCard.read(0x04)).toBe(0x00) // LBA1
      expect(storageCard.read(0x05)).toBe(0x00) // LBA2
      expect(storageCard.read(0x06)).toBe(0xE0) // LBA3 (with mode bits)
      expect(storageCard.read(0x07) & 0x40).toBe(0x40) // Status (RDY bit)
    })

    it('should have IRQ and NMI callbacks', () => {
      expect(typeof storageCard.raiseIRQ).toBe('function')
      expect(typeof storageCard.raiseNMI).toBe('function')
    })

    it('should initialize with all storage zeroed', () => {
      // Verify first sector is all zeros
      storageCard.write(0x02, 1) // Sector count = 1
      storageCard.write(0x03, 0) // LBA = 0
      storageCard.write(0x07, 0x20) // Read sector command

      for (let i = 0; i < 512; i++) {
        expect(storageCard.read(0x00)).toBe(0x00)
      }
    })
  })

  describe('Register Operations', () => {
    describe('Address Masking', () => {
      it('should mask address to lower 3 bits', () => {
        storageCard.write(0x02, 0x42) // Sector count register
        expect(storageCard.read(0x0A)).toBe(0x42) // 0x0A & 0x07 = 0x02
        expect(storageCard.read(0x12)).toBe(0x42) // 0x12 & 0x07 = 0x02
        expect(storageCard.read(0x1A)).toBe(0x42) // 0x1A & 0x07 = 0x02
      })
    })

    describe('LBA Registers', () => {
      it('should write and read LBA0', () => {
        storageCard.write(0x03, 0xAB)
        expect(storageCard.read(0x03)).toBe(0xAB)
      })

      it('should write and read LBA1', () => {
        storageCard.write(0x04, 0xCD)
        expect(storageCard.read(0x04)).toBe(0xCD)
      })

      it('should write and read LBA2', () => {
        storageCard.write(0x05, 0xEF)
        expect(storageCard.read(0x05)).toBe(0xEF)
      })

      it('should mask LBA3 to lower 4 bits and set mode bits', () => {
        storageCard.write(0x06, 0xFF)
        expect(storageCard.read(0x06)).toBe(0xEF) // 0xFF & 0x0F | 0xE0
        
        storageCard.write(0x06, 0x05)
        expect(storageCard.read(0x06)).toBe(0xE5) // 0x05 & 0x0F | 0xE0
      })
    })

    describe('Sector Count Register', () => {
      it('should write and read sector count', () => {
        storageCard.write(0x02, 1)
        expect(storageCard.read(0x02)).toBe(1)
        
        storageCard.write(0x02, 10)
        expect(storageCard.read(0x02)).toBe(10)
      })
    })

    describe('Feature/Error Register', () => {
      it('should read error register', () => {
        const error = storageCard.read(0x01)
        expect(error).toBe(0x00) // No error initially
      })
    })

    describe('Status Register', () => {
      it('should have RDY bit set initially', () => {
        const status = storageCard.read(0x07)
        expect(status & 0x40).toBe(0x40) // RDY bit
      })

      it('should not have ERR bit set initially', () => {
        const status = storageCard.read(0x07)
        expect(status & 0x01).toBe(0x00) // ERR bit
      })

      it('should not have DRQ bit set initially', () => {
        const status = storageCard.read(0x07)
        expect(status & 0x08).toBe(0x00) // DRQ bit
      })
    })
  })

  describe('Identify Drive Command (0xEC)', () => {
    it('should set DRQ flag after identify command', () => {
      storageCard.write(0x07, 0xEC)
      const status = storageCard.read(0x07)
      expect(status & 0x08).toBe(0x08) // DRQ set
    })

    it('should return 512 bytes of identity data', () => {
      storageCard.write(0x07, 0xEC)
      
      let byteCount = 0
      while (storageCard.read(0x07) & 0x08) { // While DRQ is set
        storageCard.read(0x00)
        byteCount++
      }
      
      expect(byteCount).toBe(512)
    })

    it('should clear DRQ flag after reading all identity data', () => {
      storageCard.write(0x07, 0xEC)
      
      // Read all 512 bytes
      for (let i = 0; i < 512; i++) {
        storageCard.read(0x00)
      }
      
      const status = storageCard.read(0x07)
      expect(status & 0x08).toBe(0x00) // DRQ cleared
    })

    it('should contain valid identity data', () => {
      storageCard.write(0x07, 0xEC)
      
      const identity: number[] = []
      for (let i = 0; i < 512; i++) {
        identity.push(storageCard.read(0x00))
      }

      // Check general configuration (word 0)
      expect(identity[0]).toBe(0x84)
      expect(identity[1]).toBe(0x8A)

      // Check serial number starts at byte 20
      const serial = String.fromCharCode(...identity.slice(20, 40))
      expect(serial).toBe('ACWD6502EMUCF1010101')

      // Check firmware revision starts at byte 46
      const firmware = String.fromCharCode(...identity.slice(46, 54))
      expect(firmware).toBe('1.0     ')

      // Check model number starts at byte 54
      const model = String.fromCharCode(...identity.slice(54, 94))
      expect(model).toContain('ACWD6502EMUCF')
    })
  })

  describe('Read Sector Command (0x20/0x21)', () => {
    it('should set DRQ flag after read sector command', () => {
      storageCard.write(0x02, 1) // 1 sector
      storageCard.write(0x03, 0) // LBA = 0
      storageCard.write(0x07, 0x20) // Read sector
      
      const status = storageCard.read(0x07)
      expect(status & 0x08).toBe(0x08) // DRQ set
    })

    it('should read a single sector', () => {
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x20)
      
      let byteCount = 0
      while (storageCard.read(0x07) & 0x08) {
        storageCard.read(0x00)
        byteCount++
      }
      
      expect(byteCount).toBe(512)
    })

    it('should clear DRQ after reading all sector data', () => {
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x20)
      
      for (let i = 0; i < 512; i++) {
        storageCard.read(0x00)
      }
      
      expect(storageCard.read(0x07) & 0x08).toBe(0x00)
    })

    it('should report error for invalid sector (too high)', () => {
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0xFF) // LBA = 0x0FFFFFFF (invalid)
      storageCard.write(0x04, 0xFF)
      storageCard.write(0x05, 0xFF)
      storageCard.write(0x06, 0xFF)
      storageCard.write(0x07, 0x20)
      
      const status = storageCard.read(0x07)
      const error = storageCard.read(0x01)
      
      expect(status & 0x01).toBe(0x01) // ERR bit set
      expect(error & 0x10).toBe(0x10) // IDNF error
    })

    it('should read multiple sectors', () => {
      storageCard.write(0x02, 3) // 3 sectors
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x20)
      
      let byteCount = 0
      while (storageCard.read(0x07) & 0x08) {
        storageCard.read(0x00)
        byteCount++
      }
      
      expect(byteCount).toBe(512 * 3)
    })

    it('should work with command 0x21', () => {
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x21) // Alternate read command
      
      expect(storageCard.read(0x07) & 0x08).toBe(0x08) // DRQ set
    })
  })

  describe('Write Sector Command (0x30/0x31)', () => {
    it('should set DRQ flag after write sector command', () => {
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x30) // Write sector
      
      const status = storageCard.read(0x07)
      expect(status & 0x08).toBe(0x08) // DRQ set
    })

    it('should write and read back a single sector', () => {
      // Write sector 0
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x30)
      
      for (let i = 0; i < 512; i++) {
        storageCard.write(0x00, i & 0xFF)
      }
      
      // Read sector 0
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x20)
      
      for (let i = 0; i < 512; i++) {
        expect(storageCard.read(0x00)).toBe(i & 0xFF)
      }
    })

    it('should clear DRQ after writing all sector data', () => {
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x30)
      
      for (let i = 0; i < 512; i++) {
        storageCard.write(0x00, 0xFF)
      }
      
      expect(storageCard.read(0x07) & 0x08).toBe(0x00)
    })

    it('should report error for invalid sector', () => {
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0xFF)
      storageCard.write(0x04, 0xFF)
      storageCard.write(0x05, 0xFF)
      storageCard.write(0x06, 0xFF)
      storageCard.write(0x07, 0x30)
      
      const status = storageCard.read(0x07)
      expect(status & 0x01).toBe(0x01) // ERR bit
    })

    it('should write multiple sectors', () => {
      storageCard.write(0x02, 2)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x30)
      
      for (let i = 0; i < 512 * 2; i++) {
        storageCard.write(0x00, 0xAA)
      }
      
      // Verify data was written
      storageCard.write(0x02, 2)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x20)
      
      for (let i = 0; i < 512 * 2; i++) {
        expect(storageCard.read(0x00)).toBe(0xAA)
      }
    })

    it('should work with command 0x31', () => {
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x31) // Alternate write command
      
      expect(storageCard.read(0x07) & 0x08).toBe(0x08) // DRQ set
    })
  })

  describe('Erase Sector Command (0xC0)', () => {
    it('should erase a sector', () => {
      // First write some data
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 5) // Sector 5
      storageCard.write(0x07, 0x30)
      
      for (let i = 0; i < 512; i++) {
        storageCard.write(0x00, 0xFF)
      }
      
      // Erase the sector
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 5)
      storageCard.write(0x07, 0xC0)
      
      // Read back and verify zeros
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 5)
      storageCard.write(0x07, 0x20)
      
      for (let i = 0; i < 512; i++) {
        expect(storageCard.read(0x00)).toBe(0x00)
      }
    })

    it('should report error for invalid sector', () => {
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0xFF)
      storageCard.write(0x04, 0xFF)
      storageCard.write(0x05, 0xFF)
      storageCard.write(0x06, 0xFF)
      storageCard.write(0x07, 0xC0)
      
      const status = storageCard.read(0x07)
      expect(status & 0x01).toBe(0x01) // ERR bit
    })

    it('should not set DRQ flag', () => {
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0xC0)
      
      expect(storageCard.read(0x07) & 0x08).toBe(0x00) // DRQ not set
    })
  })

  describe('Set Features Command (0xEF)', () => {
    it('should accept command without error', () => {
      storageCard.write(0x07, 0xEF)
      
      const status = storageCard.read(0x07)
      expect(status & 0x01).toBe(0x00) // No error
    })

    it('should not set DRQ flag', () => {
      storageCard.write(0x07, 0xEF)
      
      expect(storageCard.read(0x07) & 0x08).toBe(0x00)
    })
  })

  describe('Unsupported Commands', () => {
    it('should report error for unsupported command', () => {
      storageCard.write(0x07, 0xFF) // Invalid command
      
      const status = storageCard.read(0x07)
      const error = storageCard.read(0x01)
      
      expect(status & 0x01).toBe(0x01) // ERR bit
      expect(error & 0x04).toBe(0x04) // ABRT error
    })

    it('should not set DRQ for unsupported command', () => {
      storageCard.write(0x07, 0x99)
      
      expect(storageCard.read(0x07) & 0x08).toBe(0x00)
    })
  })

  describe('LBA Addressing', () => {
    it('should correctly calculate 28-bit LBA address', () => {
      // Write pattern to sector at LBA 0x00000045 (using valid low address)
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0x45) // LBA0
      storageCard.write(0x04, 0x00) // LBA1
      storageCard.write(0x05, 0x00) // LBA2
      storageCard.write(0x06, 0x00) // LBA3 (0x00 & 0x0F | 0xE0 = 0xE0)
      storageCard.write(0x07, 0x30)
      
      for (let i = 0; i < 512; i++) {
        storageCard.write(0x00, 0xCC)
      }
      
      // Read back
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0x45)
      storageCard.write(0x04, 0x00)
      storageCard.write(0x05, 0x00)
      storageCard.write(0x06, 0x00)
      storageCard.write(0x07, 0x20)
      
      expect(storageCard.read(0x00)).toBe(0xCC)
    })

    it('should isolate different sectors', () => {
      // Write to sector 0
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x30)
      for (let i = 0; i < 512; i++) {
        storageCard.write(0x00, 0x11)
      }
      
      // Write to sector 1
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 1)
      storageCard.write(0x07, 0x30)
      for (let i = 0; i < 512; i++) {
        storageCard.write(0x00, 0x22)
      }
      
      // Read sector 0 (must read all bytes to complete transfer)
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x20)
      const firstByte0 = storageCard.read(0x00)
      for (let i = 1; i < 512; i++) {
        storageCard.read(0x00)
      }
      expect(firstByte0).toBe(0x11)
      
      // Read sector 1 (must read all bytes to complete transfer)
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 1)
      storageCard.write(0x07, 0x20)
      const firstByte1 = storageCard.read(0x00)
      for (let i = 1; i < 512; i++) {
        storageCard.read(0x00)
      }
      expect(firstByte1).toBe(0x22)
    })
  })

  describe('Error Conditions', () => {
    it('should abort if command issued while transferring', () => {
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x20) // Start read
      
      // Issue another command while first is active
      storageCard.write(0x07, 0x20)
      
      const status = storageCard.read(0x07)
      const error = storageCard.read(0x01)
      
      expect(status & 0x01).toBe(0x01) // ERR bit
      expect(error & 0x04).toBe(0x04) // ABRT error
    })

    it('should abort if command issued while identifying', () => {
      storageCard.write(0x07, 0xEC) // Start identify
      
      // Issue another command
      storageCard.write(0x07, 0x20)
      
      const status = storageCard.read(0x07)
      const error = storageCard.read(0x01)
      
      expect(status & 0x01).toBe(0x01) // ERR bit
      expect(error & 0x04).toBe(0x04) // ABRT error
    })

    it('should clear error flags on new valid command', () => {
      // Trigger an error
      storageCard.write(0x07, 0xFF) // Invalid command
      expect(storageCard.read(0x07) & 0x01).toBe(0x01)
      
      // Issue valid command
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x20)
      
      const status = storageCard.read(0x07)
      expect(status & 0x01).toBe(0x00) // ERR cleared
    })
  })

  describe('Reset', () => {
    it('should reset all registers to default values', () => {
      // Modify registers
      storageCard.write(0x02, 0x42)
      storageCard.write(0x03, 0x11)
      storageCard.write(0x04, 0x22)
      storageCard.write(0x05, 0x33)
      
      storageCard.reset(true)
      
      expect(storageCard.read(0x01)).toBe(0x00) // Error
      expect(storageCard.read(0x02)).toBe(0x00) // Sector Count
      expect(storageCard.read(0x03)).toBe(0x00) // LBA0
      expect(storageCard.read(0x04)).toBe(0x00) // LBA1
      expect(storageCard.read(0x05)).toBe(0x00) // LBA2
      expect(storageCard.read(0x06)).toBe(0xE0) // LBA3
      expect(storageCard.read(0x07) & 0x40).toBe(0x40) // Status RDY
    })

    it('should clear transfer state', () => {
      storageCard.write(0x02, 1)
      storageCard.write(0x03, 0)
      storageCard.write(0x07, 0x20) // Start transfer
      
      storageCard.reset(true)
      
      expect(storageCard.read(0x07) & 0x08).toBe(0x00) // DRQ cleared
    })
  })

  describe('Tick', () => {
    it('should have tick method that does nothing', () => {
      expect(() => {
        storageCard.tick(1000000)
      }).not.toThrow()
    })
  })

  describe('IO Interface Implementation', () => {
    it('should implement IO interface methods', () => {
      expect(typeof storageCard.read).toBe('function')
      expect(typeof storageCard.write).toBe('function')
      expect(typeof storageCard.tick).toBe('function')
      expect(typeof storageCard.reset).toBe('function')
      expect(typeof storageCard.raiseIRQ).toBe('function')
      expect(typeof storageCard.raiseNMI).toBe('function')
    })
  })

  describe('Storage Persistence', () => {
    const testDir = tmpdir()
    const testFile = join(testDir, `storage-test-${Date.now()}.bin`)
    const invalidSizeFile = join(testDir, `storage-invalid-${Date.now()}.bin`)
    const nonExistentFile = join(testDir, `storage-nonexistent-${Date.now()}.bin`)

    afterEach(async () => {
      // Cleanup test files
      const filesToClean = [testFile, invalidSizeFile, nonExistentFile]
      for (const file of filesToClean) {
        if (existsSync(file)) {
          await unlink(file)
        }
      }
    })

    describe('saveToFile', () => {
      it('should save storage data to a file', async () => {
        // Write some known data to storage
        storageCard.write(0x02, 1) // 1 sector
        storageCard.write(0x03, 0) // LBA = 0
        storageCard.write(0x07, 0x30) // Write sector command

        for (let i = 0; i < 512; i++) {
          storageCard.write(0x00, i & 0xFF)
        }

        // Save to file
        await storageCard.saveToFile(testFile)

        // Verify file exists
        expect(existsSync(testFile)).toBe(true)

        // Verify file size is 128MB
        const fileData = await readFile(testFile)
        expect(fileData.length).toBe(128 * 1024 * 1024)
      })

      it('should save complete storage contents', async () => {
        // Write to multiple sectors
        for (let sector = 0; sector < 5; sector++) {
          storageCard.write(0x02, 1)
          storageCard.write(0x03, sector)
          storageCard.write(0x07, 0x30)

          for (let i = 0; i < 512; i++) {
            storageCard.write(0x00, (sector + i) & 0xFF)
          }
        }

        await storageCard.saveToFile(testFile)

        // Read file directly and verify
        const fileData = await readFile(testFile)
        
        // Check first sector
        for (let i = 0; i < 512; i++) {
          expect(fileData[i]).toBe(i & 0xFF)
        }

        // Check second sector
        for (let i = 0; i < 512; i++) {
          expect(fileData[512 + i]).toBe((1 + i) & 0xFF)
        }
      })
    })

    describe('loadFromFile', () => {
      it('should load storage data from an existing file', async () => {
        // Create a test file with known data
        const testData = Buffer.alloc(128 * 1024 * 1024, 0x00)
        
        // Fill first sector with pattern
        for (let i = 0; i < 512; i++) {
          testData[i] = (0xAA + i) & 0xFF
        }

        await writeFile(testFile, testData)

        // Load into storage card
        await storageCard.loadFromFile(testFile)

        // Verify data was loaded
        storageCard.write(0x02, 1)
        storageCard.write(0x03, 0)
        storageCard.write(0x07, 0x20) // Read sector

        for (let i = 0; i < 512; i++) {
          expect(storageCard.read(0x00)).toBe((0xAA + i) & 0xFF)
        }
      })

      it('should handle non-existent file gracefully', async () => {
        // Try to load from a file that doesn't exist
        await expect(storageCard.loadFromFile(nonExistentFile)).resolves.not.toThrow()

        // Storage should remain empty (zeros)
        storageCard.write(0x02, 1)
        storageCard.write(0x03, 0)
        storageCard.write(0x07, 0x20)

        for (let i = 0; i < 512; i++) {
          expect(storageCard.read(0x00)).toBe(0x00)
        }
      })

      it('should reject file with incorrect size', async () => {
        // Create a file that's too small
        const smallData = Buffer.alloc(1024, 0xFF) // Only 1KB
        await writeFile(invalidSizeFile, smallData)

        await storageCard.loadFromFile(invalidSizeFile)

        // Storage should remain empty (zeros)
        storageCard.write(0x02, 1)
        storageCard.write(0x03, 0)
        storageCard.write(0x07, 0x20)

        for (let i = 0; i < 512; i++) {
          expect(storageCard.read(0x00)).toBe(0x00)
        }
      })

      it('should load multiple sectors correctly', async () => {
        const testData = Buffer.alloc(128 * 1024 * 1024, 0x00)
        
        // Fill sectors with different patterns
        for (let sector = 0; sector < 10; sector++) {
          for (let i = 0; i < 512; i++) {
            testData[sector * 512 + i] = (sector * 16 + i) & 0xFF
          }
        }

        await writeFile(testFile, testData)
        await storageCard.loadFromFile(testFile)

        // Verify each sector
        for (let sector = 0; sector < 10; sector++) {
          storageCard.write(0x02, 1)
          storageCard.write(0x03, sector)
          storageCard.write(0x07, 0x20)

          for (let i = 0; i < 512; i++) {
            expect(storageCard.read(0x00)).toBe((sector * 16 + i) & 0xFF)
          }
        }
      })
    })

    describe('Round-trip persistence', () => {
      it('should save and load data without loss', async () => {
        // Write unique pattern to storage
        for (let sector = 0; sector < 100; sector++) {
          storageCard.write(0x02, 1)
          storageCard.write(0x03, sector)
          storageCard.write(0x07, 0x30)

          for (let i = 0; i < 512; i++) {
            storageCard.write(0x00, ((sector * 7 + i * 3) ^ 0x55) & 0xFF)
          }
        }

        // Save to file
        await storageCard.saveToFile(testFile)

        // Create new storage card and load
        const newStorage = new Storage()
        await newStorage.loadFromFile(testFile)

        // Verify all sectors match
        for (let sector = 0; sector < 100; sector++) {
          newStorage.write(0x02, 1)
          newStorage.write(0x03, sector)
          newStorage.write(0x07, 0x20)

          for (let i = 0; i < 512; i++) {
            expect(newStorage.read(0x00)).toBe(((sector * 7 + i * 3) ^ 0x55) & 0xFF)
          }
        }
      })

      it('should preserve data across multiple save/load cycles', async () => {
        // Initial write
        storageCard.write(0x02, 1)
        storageCard.write(0x03, 42)
        storageCard.write(0x07, 0x30)
        for (let i = 0; i < 512; i++) {
          storageCard.write(0x00, 0xCC)
        }
        await storageCard.saveToFile(testFile)

        // Load and modify
        const card2 = new Storage()
        await card2.loadFromFile(testFile)
        card2.write(0x02, 1)
        card2.write(0x03, 43)
        card2.write(0x07, 0x30)
        for (let i = 0; i < 512; i++) {
          card2.write(0x00, 0xDD)
        }
        await card2.saveToFile(testFile)

        // Load again and verify both sectors
        const card3 = new Storage()
        await card3.loadFromFile(testFile)

        // Check sector 42
        card3.write(0x02, 1)
        card3.write(0x03, 42)
        card3.write(0x07, 0x20)
        expect(card3.read(0x00)).toBe(0xCC)

        // Complete reading sector 42
        for (let i = 1; i < 512; i++) {
          card3.read(0x00)
        }

        // Check sector 43
        card3.write(0x02, 1)
        card3.write(0x03, 43)
        card3.write(0x07, 0x20)
        expect(card3.read(0x00)).toBe(0xDD)
      })
    })
  })
})
