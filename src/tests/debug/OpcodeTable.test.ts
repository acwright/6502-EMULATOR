import { OPCODES, MODE_BYTES } from '../../debug/OpcodeTable'
import { CPU } from '../../core/CPU'

/**
 * Two tables describe the same 256 opcodes: the CPU's execution table and the
 * disassembler's metadata table. They will drift.
 *
 * The CPU's addressing modes are bound closures, so production code cannot read
 * them — but `Function.prototype.bind` prefixes the target's name, so a *test*
 * can recover "IMM" from "bound IMM". That is what makes checking the modes
 * possible, and the modes are the part that matters: they determine instruction
 * length, and a wrong length desynchronises every instruction after it.
 */
describe('OpcodeTable', () => {
  const cpu = new CPU(
    () => 0,
    () => {}
  )

  /** 'bound IMM' -> 'IMM' */
  const modeOf = (opcode: number): string =>
    cpu.instructionTable[opcode]!.addrMode.name.replace(/^bound /, '')

  it('has an entry for every opcode', () => {
    expect(OPCODES).toHaveLength(256)
    expect(cpu.instructionTable).toHaveLength(256)
  })

  it('agrees with the CPU on every mnemonic', () => {
    const drifted = OPCODES.flatMap((entry, opcode) =>
      entry.name === cpu.instructionTable[opcode]!.name
        ? []
        : [`$${opcode.toString(16).padStart(2, '0')}: ${entry.name} vs ${cpu.instructionTable[opcode]!.name}`]
    )
    expect(drifted).toEqual([])
  })

  it('agrees with the CPU on every addressing mode', () => {
    const drifted = OPCODES.flatMap((entry, opcode) =>
      entry.mode === modeOf(opcode)
        ? []
        : [`$${opcode.toString(16).padStart(2, '0')}: ${entry.mode} vs ${modeOf(opcode)}`]
    )
    expect(drifted).toEqual([])
  })

  it('derives length from the addressing mode', () => {
    for (const entry of OPCODES) {
      expect(entry.bytes).toBe(MODE_BYTES[entry.mode])
    }
  })

  it('marks unimplemented opcodes as undocumented', () => {
    for (const entry of OPCODES) {
      expect(entry.documented).toBe(entry.name !== '???')
    }
    // The 65C02 fills most of the 6502's illegal-opcode space with NOPs, so a
    // fair few are expected — but not so many that the table is obviously wrong.
    const undocumented = OPCODES.filter((entry) => !entry.documented).length
    expect(undocumented).toBeGreaterThan(0)
    expect(undocumented).toBeLessThan(64)
  })

  it('knows the 65C02 instructions the original 6502 lacks', () => {
    const names = new Set(OPCODES.map((entry) => entry.name))
    for (const added of ['BRA', 'PHX', 'PHY', 'PLX', 'PLY', 'STZ', 'TRB', 'TSB']) {
      expect(names).toContain(added)
    }
    // Bit-branch and bit-set/reset instructions use the three-byte ZPR mode.
    expect(OPCODES[0x0f]).toMatchObject({ name: 'BBR0', mode: 'ZPR', bytes: 3 })
    expect(OPCODES[0xff]).toMatchObject({ name: 'BBS7', mode: 'ZPR', bytes: 3 })
  })
})
