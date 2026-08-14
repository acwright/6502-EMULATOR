/**
 * Static metadata for all 256 opcodes: mnemonic and addressing mode.
 *
 * The CPU's own instructionTable carries the mnemonic, but its addressing modes
 * are bound closures — the *length* of an instruction is not recoverable from
 * it at runtime, and a disassembler cannot work without that. Hence a second
 * table.
 *
 * Two tables describing the same 256 opcodes will drift, so OpcodeTable.test.ts
 * checks this one against the CPU's, mnemonic and mode alike, for every entry.
 * Extracted from the CPU's table rather than typed by hand.
 *
 * The target is the WDC W65C02S specifically, not the Rockwell R65C02: it has
 * WAI at $CB and STP at $DB on top of the Rockwell bit instructions, and it
 * defines widths for the unused opcode space — several of those are two or
 * three bytes rather than one-byte NOPs.
 */

/** 65C02 addressing modes, as named by the CPU's addressing-mode routines. */
export type AddrMode =
  | 'IMP' // implied / accumulator
  | 'IMM' // #$nn
  | 'ZP0' // $nn
  | 'ZPX' // $nn,X
  | 'ZPY' // $nn,Y
  | 'IZX' // ($nn,X)
  | 'IZY' // ($nn),Y
  | 'IZP' // ($nn)
  | 'ABS' // $nnnn
  | 'ABX' // $nnnn,X
  | 'ABY' // $nnnn,Y
  | 'IND' // ($nnnn)
  | 'IAX' // ($nnnn,X)
  | 'REL' // branch displacement
  | 'ZPR' // $nn,$rr — the BBR/BBS bit-branch pair

/** Total instruction length in bytes, opcode included. */
export const MODE_BYTES: Readonly<Record<AddrMode, 1 | 2 | 3>> = {
  IMP: 1,
  IMM: 2,
  ZP0: 2,
  ZPX: 2,
  ZPY: 2,
  IZX: 2,
  IZY: 2,
  IZP: 2,
  REL: 2,
  ABS: 3,
  ABX: 3,
  ABY: 3,
  IND: 3,
  IAX: 3,
  ZPR: 3
}

export interface OpcodeInfo {
  /** Mnemonic, or '???' for an opcode this CPU does not implement. */
  name: string
  mode: AddrMode
  /** Instruction length in bytes, opcode included. */
  bytes: 1 | 2 | 3
  /** False for the '???' entries, which decode as NOPs of various widths. */
  documented: boolean
}

const TABLE: ReadonlyArray<readonly [string, AddrMode]> = [
  ['BRK', 'IMM'],       // $00
  ['ORA', 'IZX'],       // $01
  ['???', 'IMM'],       // $02
  ['???', 'IMP'],       // $03
  ['TSB', 'ZP0'],       // $04
  ['ORA', 'ZP0'],       // $05
  ['ASL', 'ZP0'],       // $06
  ['RMB0', 'ZP0'],      // $07
  ['PHP', 'IMP'],       // $08
  ['ORA', 'IMM'],       // $09
  ['ASL', 'IMP'],       // $0A
  ['???', 'IMP'],       // $0B
  ['TSB', 'ABS'],       // $0C
  ['ORA', 'ABS'],       // $0D
  ['ASL', 'ABS'],       // $0E
  ['BBR0', 'ZPR'],      // $0F
  ['BPL', 'REL'],       // $10
  ['ORA', 'IZY'],       // $11
  ['ORA', 'IZP'],       // $12
  ['???', 'IMP'],       // $13
  ['TRB', 'ZP0'],       // $14
  ['ORA', 'ZPX'],       // $15
  ['ASL', 'ZPX'],       // $16
  ['RMB1', 'ZP0'],      // $17
  ['CLC', 'IMP'],       // $18
  ['ORA', 'ABY'],       // $19
  ['INC', 'IMP'],       // $1A
  ['???', 'IMP'],       // $1B
  ['TRB', 'ABS'],       // $1C
  ['ORA', 'ABX'],       // $1D
  ['ASL', 'ABX'],       // $1E
  ['BBR1', 'ZPR'],      // $1F
  ['JSR', 'ABS'],       // $20
  ['AND', 'IZX'],       // $21
  ['???', 'IMM'],       // $22
  ['???', 'IMP'],       // $23
  ['BIT', 'ZP0'],       // $24
  ['AND', 'ZP0'],       // $25
  ['ROL', 'ZP0'],       // $26
  ['RMB2', 'ZP0'],      // $27
  ['PLP', 'IMP'],       // $28
  ['AND', 'IMM'],       // $29
  ['ROL', 'IMP'],       // $2A
  ['???', 'IMP'],       // $2B
  ['BIT', 'ABS'],       // $2C
  ['AND', 'ABS'],       // $2D
  ['ROL', 'ABS'],       // $2E
  ['BBR2', 'ZPR'],      // $2F
  ['BMI', 'REL'],       // $30
  ['AND', 'IZY'],       // $31
  ['AND', 'IZP'],       // $32
  ['???', 'IMP'],       // $33
  ['BIT', 'ZPX'],       // $34
  ['AND', 'ZPX'],       // $35
  ['ROL', 'ZPX'],       // $36
  ['RMB3', 'ZP0'],      // $37
  ['SEC', 'IMP'],       // $38
  ['AND', 'ABY'],       // $39
  ['DEC', 'IMP'],       // $3A
  ['???', 'IMP'],       // $3B
  ['BIT', 'ABX'],       // $3C
  ['AND', 'ABX'],       // $3D
  ['ROL', 'ABX'],       // $3E
  ['BBR3', 'ZPR'],      // $3F
  ['RTI', 'IMP'],       // $40
  ['EOR', 'IZX'],       // $41
  ['???', 'IMM'],       // $42
  ['???', 'IMP'],       // $43
  ['???', 'ZP0'],       // $44
  ['EOR', 'ZP0'],       // $45
  ['LSR', 'ZP0'],       // $46
  ['RMB4', 'ZP0'],      // $47
  ['PHA', 'IMP'],       // $48
  ['EOR', 'IMM'],       // $49
  ['LSR', 'IMP'],       // $4A
  ['???', 'IMP'],       // $4B
  ['JMP', 'ABS'],       // $4C
  ['EOR', 'ABS'],       // $4D
  ['LSR', 'ABS'],       // $4E
  ['BBR4', 'ZPR'],      // $4F
  ['BVC', 'REL'],       // $50
  ['EOR', 'IZY'],       // $51
  ['EOR', 'IZP'],       // $52
  ['???', 'IMP'],       // $53
  ['???', 'ZPX'],       // $54
  ['EOR', 'ZPX'],       // $55
  ['LSR', 'ZPX'],       // $56
  ['RMB5', 'ZP0'],      // $57
  ['CLI', 'IMP'],       // $58
  ['EOR', 'ABY'],       // $59
  ['PHY', 'IMP'],       // $5A
  ['???', 'IMP'],       // $5B
  ['???', 'ABS'],       // $5C
  ['EOR', 'ABX'],       // $5D
  ['LSR', 'ABX'],       // $5E
  ['BBR5', 'ZPR'],      // $5F
  ['RTS', 'IMP'],       // $60
  ['ADC', 'IZX'],       // $61
  ['???', 'IMM'],       // $62
  ['???', 'IMP'],       // $63
  ['STZ', 'ZP0'],       // $64
  ['ADC', 'ZP0'],       // $65
  ['ROR', 'ZP0'],       // $66
  ['RMB6', 'ZP0'],      // $67
  ['PLA', 'IMP'],       // $68
  ['ADC', 'IMM'],       // $69
  ['ROR', 'IMP'],       // $6A
  ['???', 'IMP'],       // $6B
  ['JMP', 'IND'],       // $6C
  ['ADC', 'ABS'],       // $6D
  ['ROR', 'ABS'],       // $6E
  ['BBR6', 'ZPR'],      // $6F
  ['BVS', 'REL'],       // $70
  ['ADC', 'IZY'],       // $71
  ['ADC', 'IZP'],       // $72
  ['???', 'IMP'],       // $73
  ['STZ', 'ZPX'],       // $74
  ['ADC', 'ZPX'],       // $75
  ['ROR', 'ZPX'],       // $76
  ['RMB7', 'ZP0'],      // $77
  ['SEI', 'IMP'],       // $78
  ['ADC', 'ABY'],       // $79
  ['PLY', 'IMP'],       // $7A
  ['???', 'IMP'],       // $7B
  ['JMP', 'IAX'],       // $7C
  ['ADC', 'ABX'],       // $7D
  ['ROR', 'ABX'],       // $7E
  ['BBR7', 'ZPR'],      // $7F
  ['BRA', 'REL'],       // $80
  ['STA', 'IZX'],       // $81
  ['???', 'IMM'],       // $82
  ['???', 'IMP'],       // $83
  ['STY', 'ZP0'],       // $84
  ['STA', 'ZP0'],       // $85
  ['STX', 'ZP0'],       // $86
  ['SMB0', 'ZP0'],      // $87
  ['DEY', 'IMP'],       // $88
  ['BIT', 'IMM'],       // $89
  ['TXA', 'IMP'],       // $8A
  ['???', 'IMP'],       // $8B
  ['STY', 'ABS'],       // $8C
  ['STA', 'ABS'],       // $8D
  ['STX', 'ABS'],       // $8E
  ['BBS0', 'ZPR'],      // $8F
  ['BCC', 'REL'],       // $90
  ['STA', 'IZY'],       // $91
  ['STA', 'IZP'],       // $92
  ['???', 'IMP'],       // $93
  ['STY', 'ZPX'],       // $94
  ['STA', 'ZPX'],       // $95
  ['STX', 'ZPY'],       // $96
  ['SMB1', 'ZP0'],      // $97
  ['TYA', 'IMP'],       // $98
  ['STA', 'ABY'],       // $99
  ['TXS', 'IMP'],       // $9A
  ['???', 'IMP'],       // $9B
  ['STZ', 'ABS'],       // $9C
  ['STA', 'ABX'],       // $9D
  ['STZ', 'ABX'],       // $9E
  ['BBS1', 'ZPR'],      // $9F
  ['LDY', 'IMM'],       // $A0
  ['LDA', 'IZX'],       // $A1
  ['LDX', 'IMM'],       // $A2
  ['???', 'IMP'],       // $A3
  ['LDY', 'ZP0'],       // $A4
  ['LDA', 'ZP0'],       // $A5
  ['LDX', 'ZP0'],       // $A6
  ['SMB2', 'ZP0'],      // $A7
  ['TAY', 'IMP'],       // $A8
  ['LDA', 'IMM'],       // $A9
  ['TAX', 'IMP'],       // $AA
  ['???', 'IMP'],       // $AB
  ['LDY', 'ABS'],       // $AC
  ['LDA', 'ABS'],       // $AD
  ['LDX', 'ABS'],       // $AE
  ['BBS2', 'ZPR'],      // $AF
  ['BCS', 'REL'],       // $B0
  ['LDA', 'IZY'],       // $B1
  ['LDA', 'IZP'],       // $B2
  ['???', 'IMP'],       // $B3
  ['LDY', 'ZPX'],       // $B4
  ['LDA', 'ZPX'],       // $B5
  ['LDX', 'ZPY'],       // $B6
  ['SMB3', 'ZP0'],      // $B7
  ['CLV', 'IMP'],       // $B8
  ['LDA', 'ABY'],       // $B9
  ['TSX', 'IMP'],       // $BA
  ['???', 'IMP'],       // $BB
  ['LDY', 'ABX'],       // $BC
  ['LDA', 'ABX'],       // $BD
  ['LDX', 'ABY'],       // $BE
  ['BBS3', 'ZPR'],      // $BF
  ['CPY', 'IMM'],       // $C0
  ['CMP', 'IZX'],       // $C1
  ['???', 'IMM'],       // $C2
  ['???', 'IMP'],       // $C3
  ['CPY', 'ZP0'],       // $C4
  ['CMP', 'ZP0'],       // $C5
  ['DEC', 'ZP0'],       // $C6
  ['SMB4', 'ZP0'],      // $C7
  ['INY', 'IMP'],       // $C8
  ['CMP', 'IMM'],       // $C9
  ['DEX', 'IMP'],       // $CA
  ['WAI', 'IMP'],       // $CB
  ['CPY', 'ABS'],       // $CC
  ['CMP', 'ABS'],       // $CD
  ['DEC', 'ABS'],       // $CE
  ['BBS4', 'ZPR'],      // $CF
  ['BNE', 'REL'],       // $D0
  ['CMP', 'IZY'],       // $D1
  ['CMP', 'IZP'],       // $D2
  ['???', 'IMP'],       // $D3
  ['???', 'ZPX'],       // $D4
  ['CMP', 'ZPX'],       // $D5
  ['DEC', 'ZPX'],       // $D6
  ['SMB5', 'ZP0'],      // $D7
  ['CLD', 'IMP'],       // $D8
  ['CMP', 'ABY'],       // $D9
  ['PHX', 'IMP'],       // $DA
  ['STP', 'IMP'],       // $DB
  ['???', 'ABS'],       // $DC
  ['CMP', 'ABX'],       // $DD
  ['DEC', 'ABX'],       // $DE
  ['BBS5', 'ZPR'],      // $DF
  ['CPX', 'IMM'],       // $E0
  ['SBC', 'IZX'],       // $E1
  ['???', 'IMM'],       // $E2
  ['???', 'IMP'],       // $E3
  ['CPX', 'ZP0'],       // $E4
  ['SBC', 'ZP0'],       // $E5
  ['INC', 'ZP0'],       // $E6
  ['SMB6', 'ZP0'],      // $E7
  ['INX', 'IMP'],       // $E8
  ['SBC', 'IMM'],       // $E9
  ['NOP', 'IMP'],       // $EA
  ['???', 'IMP'],       // $EB
  ['CPX', 'ABS'],       // $EC
  ['SBC', 'ABS'],       // $ED
  ['INC', 'ABS'],       // $EE
  ['BBS6', 'ZPR'],      // $EF
  ['BEQ', 'REL'],       // $F0
  ['SBC', 'IZY'],       // $F1
  ['SBC', 'IZP'],       // $F2
  ['???', 'IMP'],       // $F3
  ['???', 'ZPX'],       // $F4
  ['SBC', 'ZPX'],       // $F5
  ['INC', 'ZPX'],       // $F6
  ['SMB7', 'ZP0'],      // $F7
  ['SED', 'IMP'],       // $F8
  ['SBC', 'ABY'],       // $F9
  ['PLX', 'IMP'],       // $FA
  ['???', 'IMP'],       // $FB
  ['???', 'ABS'],       // $FC
  ['SBC', 'ABX'],       // $FD
  ['INC', 'ABX'],       // $FE
  ['BBS7', 'ZPR'],      // $FF
]

export const OPCODES: ReadonlyArray<OpcodeInfo> = TABLE.map(([name, mode]) => ({
  name,
  mode,
  bytes: MODE_BYTES[mode],
  documented: name !== '???'
}))
