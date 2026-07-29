import { Storage } from '../../core/IO/Storage'
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
        const storageData = storageCard.getData()
        await writeFile(testFile, storageData)

        // Verify file exists
        expect(existsSync(testFile)).toBe(true)

        // Verify file size is 32MB
        const fileData = await readFile(testFile)
        expect(fileData.length).toBe(32 * 1024 * 1024)
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

        const storageData = storageCard.getData()
        await writeFile(testFile, storageData)

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
        const testData = Buffer.alloc(32 * 1024 * 1024, 0x00)
        
        // Fill first sector with pattern
        for (let i = 0; i < 512; i++) {
          testData[i] = (0xAA + i) & 0xFF
        }

        await writeFile(testFile, testData)

        // Load into storage card
        const fileData = await readFile(testFile)
        storageCard.loadData(new Uint8Array(fileData))

        // Verify data was loaded
        storageCard.write(0x02, 1)
        storageCard.write(0x03, 0)
        storageCard.write(0x07, 0x20) // Read sector

        for (let i = 0; i < 512; i++) {
          expect(storageCard.read(0x00)).toBe((0xAA + i) & 0xFF)
        }
      })

      it('should handle non-existent file gracefully', () => {
        // Load with null data
        storageCard.loadData(null)

        // Storage should remain empty (zeros)
        storageCard.write(0x02, 1)
        storageCard.write(0x03, 0)
        storageCard.write(0x07, 0x20)

        for (let i = 0; i < 512; i++) {
          expect(storageCard.read(0x00)).toBe(0x00)
        }
      })

      it('should reject file with non-sector-aligned size', async () => {
        // Create a file that's not a multiple of 512 bytes
        const badData = Buffer.alloc(1023, 0xFF)
        await writeFile(invalidSizeFile, badData)

        const fileData = await readFile(invalidSizeFile)
        storageCard.loadData(new Uint8Array(fileData))

        // Storage should remain empty (zeros)
        storageCard.write(0x02, 1)
        storageCard.write(0x03, 0)
        storageCard.write(0x07, 0x20)

        for (let i = 0; i < 512; i++) {
          expect(storageCard.read(0x00)).toBe(0x00)
        }
      })

      it('should load multiple sectors correctly', async () => {
        const testData = Buffer.alloc(32 * 1024 * 1024, 0x00)
        
        // Fill sectors with different patterns
        for (let sector = 0; sector < 10; sector++) {
          for (let i = 0; i < 512; i++) {
            testData[sector * 512 + i] = (sector * 16 + i) & 0xFF
          }
        }

        await writeFile(testFile, testData)
        const fileData = await readFile(testFile)
        storageCard.loadData(new Uint8Array(fileData))

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
        const storageData = storageCard.getData()
        await writeFile(testFile, storageData)

        // Create new storage card and load
        const newStorage = new Storage()
        const savedData = await readFile(testFile)
        newStorage.loadData(new Uint8Array(savedData))

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
        await writeFile(testFile, storageCard.getData())

        // Load and modify
        const card2 = new Storage()
        let fileData = await readFile(testFile)
        card2.loadData(new Uint8Array(fileData))
        card2.write(0x02, 1)
        card2.write(0x03, 43)
        card2.write(0x07, 0x30)
        for (let i = 0; i < 512; i++) {
          card2.write(0x00, 0xDD)
        }
        await writeFile(testFile, card2.getData())

        // Load again and verify both sectors
        const card3 = new Storage()
        fileData = await readFile(testFile)
        card3.loadData(new Uint8Array(fileData))

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

describe('Storage dirty tracking', () => {
  const SECTOR = Storage.SECTOR_SIZE

  /** 64-sector (32 KB) card — big enough to exercise offsets, small enough to be fast. */
  const smallCard = () => new Storage(64 * SECTOR)

  /** Write `fill` across `count` sectors starting at `lba`, via the register interface. */
  function writeSectors(card: Storage, lba: number, count: number, fill: (i: number) => number) {
    card.write(0x02, count)
    card.write(0x03, lba)
    card.write(0x07, 0x30)
    for (let i = 0; i < count * SECTOR; i++) card.write(0x00, fill(i) & 0xff)
  }

  it('starts clean', () => {
    expect(smallCard().isDirty()).toBe(false)
    expect(smallCard().getDelta()).toEqual({ kind: 'none' })
  })

  it('marks only the written sector dirty, with its byte offset and contents', () => {
    const card = smallCard()
    writeSectors(card, 3, 1, () => 0xab)

    expect(card.isDirty()).toBe(true)
    const delta = card.getDelta()
    expect(delta.kind).toBe('sectors')
    if (delta.kind !== 'sectors') throw new Error('expected sectors')

    expect(delta.offsets).toEqual([3 * SECTOR])
    expect(delta.sectorSize).toBe(SECTOR)
    expect(delta.data.length).toBe(SECTOR)
    expect([...delta.data].every((b) => b === 0xab)).toBe(true)
  })

  it('tracks every sector of a multi-sector write', () => {
    const card = smallCard()
    writeSectors(card, 10, 3, (i) => i)

    const delta = card.getDelta()
    if (delta.kind !== 'sectors') throw new Error('expected sectors')
    expect(delta.offsets).toEqual([10 * SECTOR, 11 * SECTOR, 12 * SECTOR])
    expect(delta.data.length).toBe(3 * SECTOR)
  })

  it('marks erased sectors dirty', () => {
    const card = smallCard()
    writeSectors(card, 5, 1, () => 0xff)
    card.clearDirty()

    card.write(0x03, 5)
    card.write(0x07, 0xc0) // Erase sector

    const delta = card.getDelta()
    if (delta.kind !== 'sectors') throw new Error('expected sectors')
    expect(delta.offsets).toEqual([5 * SECTOR])
    expect([...delta.data].every((b) => b === 0x00)).toBe(true)
  })

  it('does not clear the dirty set — a failed save must be retryable', () => {
    const card = smallCard()
    writeSectors(card, 1, 1, () => 0x11)

    expect(card.getDelta()).toEqual(card.getDelta())
    expect(card.isDirty()).toBe(true)

    card.clearDirty()
    expect(card.isDirty()).toBe(false)
    expect(card.getDelta()).toEqual({ kind: 'none' })
  })

  it('treats a loadData() as a whole-image change', () => {
    const card = smallCard()
    card.clearDirty()
    card.loadData(new Uint8Array(64 * SECTOR).fill(0x7e))

    expect(card.isDirty()).toBe(true)
    expect(card.getDelta()).toEqual({ kind: 'full' })
  })

  it('stays incremental even when most of the image is dirty', () => {
    // A delta is never larger than the image, so there is no dirty-count at
    // which falling back to a full save moves fewer bytes.
    const card = smallCard()
    writeSectors(card, 0, 60, (i) => i)

    const delta = card.getDelta()
    if (delta.kind !== 'sectors') throw new Error('expected sectors')
    expect(delta.offsets.length).toBe(60)
    expect(delta.data.length).toBe(60 * SECTOR)
  })

  it('reset() does not dirty the card — a CF card is non-volatile', () => {
    const card = smallCard()
    card.clearDirty()
    card.reset(true)
    expect(card.isDirty()).toBe(false)
  })

  // The load-bearing test: replaying a delta onto the last-saved image must
  // reproduce the card exactly. A missed dirty sector is silent data loss.
  it('replaying deltas onto a stale image reproduces the card byte for byte', () => {
    const card = smallCard()
    const persisted = card.getData() // "on disk" copy
    card.clearDirty()

    let seed = 12345
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }

    // Several save cycles, each with a random scatter of writes in between.
    for (let cycle = 0; cycle < 5; cycle++) {
      const writes = 1 + rand(3)
      for (let w = 0; w < writes; w++) {
        writeSectors(card, rand(60), 1 + rand(2), () => rand(256))
      }

      const delta = card.getDelta()
      if (delta.kind === 'sectors') {
        delta.offsets.forEach((offset, i) => {
          persisted.set(delta.data.subarray(i * SECTOR, (i + 1) * SECTOR), offset)
        })
      } else if (delta.kind === 'full') {
        persisted.set(card.getData())
      }
      card.clearDirty()
    }

    expect(Buffer.from(persisted).equals(Buffer.from(card.getData()))).toBe(true)
  })
})
