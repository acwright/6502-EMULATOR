import { AttachmentBase } from './Attachment'

/**
 * HD44780 LCD Controller Emulation — GPIO Attachment
 *
 * Emulates a 16×2 (or configurable) character LCD with HD44780 controller
 * connected via 8-bit parallel interface on a 65C22 VIA.
 *
 * Pin mapping (accent on VIA ports):
 *   Port B (D0–D7): 8-bit data bus
 *   Port A bit 5:   RS  (Register Select — 0 = command, 1 = data)
 *   Port A bit 6:   RW  (Read/Write — 0 = write, 1 = read)
 *   Port A bit 7:   E   (Enable — active-high strobe, latched on falling edge)
 *
 * Display modes:
 *   Standard character display with 5×8 pixel characters
 *   Supports CGRAM for up to 8 user-defined characters
 *
 * Output: pixel buffer (cols*(5+1)-1) × (rows*(8+1)-1) with values:
 *   -1 = no pixel (inter-character gap)
 *    0 = pixel off
 *    1 = pixel on
 *
 * Reference: vrEmuLcd by Troy Schrapel
 * https://github.com/visrealm/vrEmuLcd
 */

// ── HD44780 Command bit masks ──────────────────────────────────────

export const LCD_CMD_CLEAR                  = 0x01
export const LCD_CMD_HOME                   = 0x02
export const LCD_CMD_ENTRY_MODE             = 0x04
export const LCD_CMD_ENTRY_MODE_INCREMENT   = 0x02
export const LCD_CMD_ENTRY_MODE_SHIFT       = 0x01
export const LCD_CMD_DISPLAY                = 0x08
export const LCD_CMD_DISPLAY_ON             = 0x04
export const LCD_CMD_DISPLAY_CURSOR         = 0x02
export const LCD_CMD_DISPLAY_CURSOR_BLINK   = 0x01
export const LCD_CMD_SHIFT                  = 0x10
export const LCD_CMD_SHIFT_DISPLAY          = 0x08
export const LCD_CMD_SHIFT_RIGHT            = 0x04
export const LCD_CMD_FUNCTION               = 0x20
export const LCD_CMD_FUNCTION_LCD_2LINE     = 0x08
export const LCD_CMD_SET_CGRAM_ADDR         = 0x40
export const LCD_CMD_SET_DRAM_ADDR          = 0x80

// ── Constants ──────────────────────────────────────────────────────

const CHAR_WIDTH_PX  = 5
const CHAR_HEIGHT_PX = 8

const DDRAM_SIZE              = 128
const CGRAM_STORAGE_CHARS     = 16
const ROM_FONT_CHARS          = 256 - CGRAM_STORAGE_CHARS
const DEFAULT_CGRAM_BYTE      = 0xAA

const DATA_WIDTH_CHARS_1ROW = 80
const DATA_WIDTH_CHARS_2ROW = 40

const CURSOR_MASK = LCD_CMD_DISPLAY_CURSOR_BLINK | LCD_CMD_DISPLAY_CURSOR

// DDRAM row start addresses for multi-row displays
const ROW_OFFSETS = [0x00, 0x40, 0x14, 0x54]

// ── VIA Port A pin positions ───────────────────────────────────────

const PIN_RS = 0x20  // bit 5
const PIN_RW = 0x40  // bit 6
const PIN_E  = 0x80  // bit 7

// ── HD44780 ROM A00 (Japanese) font ────────────────────────────────
// 240 characters (indices 16–255), each stored as 5 bytes — one per
// column, MSB at top. First 16 slots reserved for CGRAM.

const FONT_A00: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0x00,0x00,0x00,0x00,0x00], //  16
  [0x00,0x00,0x00,0x00,0x00], //  17
  [0x00,0x00,0x00,0x00,0x00], //  18
  [0x00,0x00,0x00,0x00,0x00], //  19
  [0x00,0x00,0x00,0x00,0x00], //  20
  [0x00,0x00,0x00,0x00,0x00], //  21
  [0x00,0x00,0x00,0x00,0x00], //  22
  [0x00,0x00,0x00,0x00,0x00], //  23
  [0x00,0x00,0x00,0x00,0x00], //  24
  [0x00,0x00,0x00,0x00,0x00], //  25
  [0x00,0x00,0x00,0x00,0x00], //  26
  [0x00,0x00,0x00,0x00,0x00], //  27
  [0x00,0x00,0x00,0x00,0x00], //  28
  [0x00,0x00,0x00,0x00,0x00], //  29
  [0x00,0x00,0x00,0x00,0x00], //  30
  [0x00,0x00,0x00,0x00,0x00], //  31
  [0x00,0x00,0x00,0x00,0x00], //  32 - (space)
  [0x00,0x00,0xf2,0x00,0x00], //  33 - !
  [0x00,0xe0,0x00,0xe0,0x00], //  34 - "
  [0x28,0xfe,0x28,0xfe,0x28], //  35 - #
  [0x24,0x54,0xfe,0x54,0x48], //  36 - $
  [0xc4,0xc8,0x10,0x26,0x46], //  37 - %
  [0x6c,0x92,0xaa,0x44,0x0a], //  38 - &
  [0x00,0xa0,0xc0,0x00,0x00], //  39 - '
  [0x00,0x38,0x44,0x82,0x00], //  40 - (
  [0x00,0x82,0x44,0x38,0x00], //  41 - )
  [0x28,0x10,0x7c,0x10,0x28], //  42 - *
  [0x10,0x10,0x7c,0x10,0x10], //  43 - +
  [0x00,0x0a,0x0c,0x00,0x00], //  44 - ,
  [0x10,0x10,0x10,0x10,0x10], //  45 - -
  [0x00,0x06,0x06,0x00,0x00], //  46 - .
  [0x04,0x08,0x10,0x20,0x40], //  47 - /
  [0x7c,0x8a,0x92,0xa2,0x7c], //  48 - 0
  [0x00,0x42,0xfe,0x02,0x00], //  49 - 1
  [0x42,0x86,0x8a,0x92,0x62], //  50 - 2
  [0x84,0x82,0xa2,0xd2,0x8c], //  51 - 3
  [0x18,0x28,0x48,0xfe,0x08], //  52 - 4
  [0xe4,0xa2,0xa2,0xa2,0x9c], //  53 - 5
  [0x3c,0x52,0x92,0x92,0x0c], //  54 - 6
  [0x80,0x8e,0x90,0xa0,0xc0], //  55 - 7
  [0x6c,0x92,0x92,0x92,0x6c], //  56 - 8
  [0x60,0x92,0x92,0x94,0x78], //  57 - 9
  [0x00,0x6c,0x6c,0x00,0x00], //  58 - :
  [0x00,0x6a,0x6c,0x00,0x00], //  59 - ;
  [0x10,0x28,0x44,0x82,0x00], //  60 - <
  [0x28,0x28,0x28,0x28,0x28], //  61 - =
  [0x00,0x82,0x44,0x28,0x10], //  62 - >
  [0x40,0x80,0x8a,0x90,0x60], //  63 - ?
  [0x4c,0x92,0x9e,0x82,0x7c], //  64 - @
  [0x7e,0x90,0x90,0x90,0x7e], //  65 - A
  [0xfe,0x92,0x92,0x92,0x6c], //  66 - B
  [0x7c,0x82,0x82,0x82,0x44], //  67 - C
  [0xfe,0x82,0x82,0x44,0x38], //  68 - D
  [0xfe,0x92,0x92,0x92,0x82], //  69 - E
  [0xfe,0x90,0x90,0x90,0x80], //  70 - F
  [0x7c,0x82,0x92,0x92,0x5e], //  71 - G
  [0xfe,0x10,0x10,0x10,0xfe], //  72 - H
  [0x00,0x82,0xfe,0x82,0x00], //  73 - I
  [0x04,0x82,0x82,0xfc,0x00], //  74 - J
  [0xfe,0x10,0x28,0x44,0x82], //  75 - K
  [0xfe,0x02,0x02,0x02,0x02], //  76 - L
  [0xfe,0x40,0x30,0x40,0xfe], //  77 - M
  [0xfe,0x20,0x10,0x08,0xfe], //  78 - N
  [0x7c,0x82,0x82,0x82,0x7c], //  79 - O
  [0xfe,0x90,0x90,0x90,0x60], //  80 - P
  [0x7c,0x82,0x8a,0x84,0x7a], //  81 - Q
  [0xfe,0x90,0x98,0x94,0x62], //  82 - R
  [0x62,0x92,0x92,0x92,0x8c], //  83 - S
  [0x80,0x80,0xfe,0x80,0x80], //  84 - T
  [0xfc,0x02,0x02,0x02,0xfc], //  85 - U
  [0xf8,0x04,0x02,0x04,0xf8], //  86 - V
  [0xfc,0x02,0x1c,0x02,0xfc], //  87 - W
  [0xc6,0x28,0x10,0x28,0xc6], //  88 - X
  [0xe0,0x10,0x0e,0x10,0xe0], //  89 - Y
  [0x86,0x8a,0x92,0xa2,0xc2], //  90 - Z
  [0x00,0xfe,0x82,0x82,0x00], //  91 - [
  [0xa8,0x68,0x3e,0x68,0xa8], //  92 - yen
  [0x00,0x82,0x82,0xfe,0x00], //  93 - ]
  [0x20,0x40,0x80,0x40,0x20], //  94 - ^
  [0x02,0x02,0x02,0x02,0x02], //  95 - _
  [0x00,0x80,0x40,0x20,0x00], //  96 - `
  [0x04,0x2a,0x2a,0x2a,0x1e], //  97 - a
  [0xfe,0x12,0x22,0x22,0x1c], //  98 - b
  [0x1c,0x22,0x22,0x22,0x04], //  99 - c
  [0x1c,0x22,0x22,0x12,0xfe], // 100 - d
  [0x1c,0x2a,0x2a,0x2a,0x18], // 101 - e
  [0x10,0x7e,0x90,0x80,0x40], // 102 - f
  [0x30,0x4a,0x4a,0x4a,0x7c], // 103 - g
  [0xfe,0x10,0x20,0x20,0x1e], // 104 - h
  [0x00,0x22,0xbe,0x02,0x00], // 105 - i
  [0x04,0x02,0x22,0xbc,0x00], // 106 - j
  [0xfe,0x08,0x14,0x22,0x00], // 107 - k
  [0x02,0x82,0xfe,0x02,0x02], // 108 - l
  [0x3e,0x20,0x18,0x20,0x1e], // 109 - m
  [0x3e,0x10,0x20,0x20,0x1e], // 110 - n
  [0x1c,0x22,0x22,0x22,0x1c], // 111 - o
  [0x3e,0x28,0x28,0x28,0x10], // 112 - p
  [0x10,0x28,0x28,0x18,0x3e], // 113 - q
  [0x3e,0x10,0x20,0x20,0x10], // 114 - r
  [0x12,0x2a,0x2a,0x2a,0x04], // 115 - s
  [0x20,0xfc,0x22,0x02,0x04], // 116 - t
  [0x3c,0x02,0x02,0x04,0x3e], // 117 - u
  [0x38,0x04,0x02,0x04,0x38], // 118 - v
  [0x3c,0x02,0x0c,0x02,0x3c], // 119 - w
  [0x22,0x14,0x08,0x14,0x22], // 120 - x
  [0x30,0x0a,0x0a,0x0a,0x3c], // 121 - y
  [0x22,0x26,0x2a,0x32,0x22], // 122 - z
  [0x00,0x10,0x6c,0x82,0x00], // 123 - {
  [0x00,0x00,0xfe,0x00,0x00], // 124 - |
  [0x00,0x82,0x6c,0x10,0x00], // 125 - }
  [0x10,0x10,0x54,0x38,0x10], // 126 - ->
  [0x10,0x38,0x54,0x10,0x10], // 127 - <-
  [0x00,0x00,0x00,0x00,0x00], // 128
  [0x00,0x00,0x00,0x00,0x00], // 129
  [0x00,0x00,0x00,0x00,0x00], // 130
  [0x00,0x00,0x00,0x00,0x00], // 131
  [0x00,0x00,0x00,0x00,0x00], // 132
  [0x00,0x00,0x00,0x00,0x00], // 133
  [0x00,0x00,0x00,0x00,0x00], // 134
  [0x00,0x00,0x00,0x00,0x00], // 135
  [0x00,0x00,0x00,0x00,0x00], // 136
  [0x00,0x00,0x00,0x00,0x00], // 137
  [0x00,0x00,0x00,0x00,0x00], // 138
  [0x00,0x00,0x00,0x00,0x00], // 139
  [0x00,0x00,0x00,0x00,0x00], // 140
  [0x00,0x00,0x00,0x00,0x00], // 141
  [0x00,0x00,0x00,0x00,0x00], // 142
  [0x00,0x00,0x00,0x00,0x00], // 143
  [0x00,0x00,0x00,0x00,0x00], // 144
  [0x00,0x00,0x00,0x00,0x00], // 145
  [0x00,0x00,0x00,0x00,0x00], // 146
  [0x00,0x00,0x00,0x00,0x00], // 147
  [0x00,0x00,0x00,0x00,0x00], // 148
  [0x00,0x00,0x00,0x00,0x00], // 149
  [0x00,0x00,0x00,0x00,0x00], // 150
  [0x00,0x00,0x00,0x00,0x00], // 151
  [0x00,0x00,0x00,0x00,0x00], // 152
  [0x00,0x00,0x00,0x00,0x00], // 153
  [0x00,0x00,0x00,0x00,0x00], // 154
  [0x00,0x00,0x00,0x00,0x00], // 155
  [0x00,0x00,0x00,0x00,0x00], // 156
  [0x00,0x00,0x00,0x00,0x00], // 157
  [0x00,0x00,0x00,0x00,0x00], // 158
  [0x00,0x00,0x00,0x00,0x00], // 159
  [0x00,0x00,0x00,0x00,0x00], // 160
  [0x0e,0x0a,0x0e,0x00,0x00], // 161
  [0x00,0x00,0xf0,0x80,0x80], // 162
  [0x02,0x02,0x1e,0x00,0x00], // 163
  [0x08,0x04,0x02,0x00,0x00], // 164
  [0x00,0x18,0x18,0x00,0x00], // 165
  [0x50,0x50,0x52,0x54,0x78], // 166
  [0x20,0x22,0x2c,0x28,0x30], // 167
  [0x04,0x08,0x1e,0x20,0x00], // 168
  [0x18,0x12,0x32,0x12,0x1c], // 169
  [0x12,0x12,0x1e,0x12,0x12], // 170
  [0x12,0x14,0x18,0x3e,0x10], // 171
  [0x10,0x3e,0x10,0x14,0x18], // 172
  [0x02,0x12,0x12,0x1e,0x02], // 173
  [0x2a,0x2a,0x2a,0x3e,0x00], // 174
  [0x18,0x00,0x1a,0x02,0x1c], // 175
  [0x10,0x10,0x10,0x10,0x10], // 176
  [0x80,0x82,0xbc,0x90,0xe0], // 177
  [0x08,0x10,0x3e,0x40,0x80], // 178
  [0x70,0x40,0xc2,0x44,0x78], // 179
  [0x42,0x42,0x7e,0x42,0x42], // 180
  [0x44,0x48,0x50,0xfe,0x40], // 181
  [0x42,0xfc,0x40,0x42,0x7c], // 182
  [0x50,0x50,0xfe,0x50,0x50], // 183
  [0x10,0x62,0x42,0x44,0x78], // 184
  [0x20,0xc0,0x42,0x7c,0x40], // 185
  [0x42,0x42,0x42,0x42,0x7e], // 186
  [0x40,0xf2,0x44,0xf8,0x40], // 187
  [0x52,0x52,0x02,0x04,0x38], // 188
  [0x42,0x44,0x48,0x54,0x62], // 189
  [0x40,0xfc,0x42,0x52,0x62], // 190
  [0x60,0x12,0x02,0x04,0x78], // 191
  [0x10,0x62,0x52,0x4c,0x78], // 192
  [0x50,0x52,0x7c,0x90,0x10], // 193
  [0x70,0x00,0x72,0x04,0x78], // 194
  [0x20,0xa2,0xbc,0xa0,0x20], // 195
  [0x00,0xfe,0x10,0x08,0x00], // 196
  [0x22,0x24,0xf8,0x20,0x20], // 197
  [0x02,0x42,0x42,0x42,0x02], // 198
  [0x42,0x54,0x48,0x54,0x60], // 199
  [0x44,0x48,0xde,0x68,0x44], // 200
  [0x00,0x02,0x04,0xf8,0x00], // 201
  [0x1e,0x00,0x40,0x20,0x1e], // 202
  [0xfc,0x22,0x22,0x22,0x22], // 203
  [0x40,0x42,0x42,0x44,0x78], // 204
  [0x20,0x40,0x20,0x10,0x0c], // 205
  [0x4c,0x40,0xfe,0x40,0x4c], // 206
  [0x40,0x48,0x44,0x4a,0x70], // 207
  [0x00,0x54,0x54,0x54,0x02], // 208
  [0x1c,0x24,0x44,0x04,0x0e], // 209
  [0x02,0x14,0x08,0x14,0x60], // 210
  [0x50,0x7c,0x52,0x52,0x52], // 211
  [0x20,0xfe,0x20,0x28,0x30], // 212
  [0x02,0x42,0x42,0x7e,0x02], // 213
  [0x52,0x52,0x52,0x52,0x7e], // 214
  [0x20,0xa0,0xa2,0xa4,0x38], // 215
  [0xf0,0x02,0x04,0xf8,0x00], // 216
  [0x3e,0x00,0x7e,0x02,0x0c], // 217
  [0x7e,0x02,0x04,0x08,0x10], // 218
  [0x7e,0x42,0x42,0x42,0x7e], // 219
  [0x70,0x40,0x42,0x44,0x78], // 220
  [0x42,0x42,0x02,0x04,0x18], // 221
  [0x40,0x20,0x80,0x40,0x00], // 222
  [0xe0,0xa0,0xe0,0x00,0x00], // 223
  [0x1c,0x22,0x12,0x0c,0x32], // 224
  [0x04,0xaa,0x2a,0xaa,0x1e], // 225
  [0x1f,0x2a,0x2a,0x2a,0x14], // 226
  [0x14,0x2a,0x2a,0x22,0x04], // 227
  [0x3f,0x02,0x02,0x04,0x3e], // 228
  [0x1c,0x22,0x32,0x2a,0x24], // 229
  [0x0f,0x12,0x22,0x22,0x1c], // 230
  [0x1c,0x22,0x22,0x22,0x3f], // 231
  [0x04,0x02,0x3c,0x20,0x20], // 232
  [0x20,0x20,0x00,0x70,0x00], // 233
  [0x00,0x00,0x20,0xbf,0x00], // 234
  [0x50,0x20,0x50,0x00,0x00], // 235
  [0x18,0x24,0x7e,0x24,0x08], // 236
  [0x28,0xfe,0x2a,0x02,0x02], // 237
  [0x3e,0x90,0xa0,0xa0,0x1e], // 238
  [0x1c,0xa2,0x22,0xa2,0x1c], // 239
  [0x3f,0x12,0x22,0x22,0x1c], // 240
  [0x1c,0x22,0x22,0x12,0x3f], // 241
  [0x3c,0x52,0x52,0x52,0x3c], // 242
  [0x0c,0x14,0x08,0x14,0x18], // 243
  [0x1a,0x26,0x20,0x26,0x1a], // 244
  [0x3c,0x82,0x02,0x84,0x3e], // 245
  [0xc6,0xaa,0x92,0x82,0x82], // 246
  [0x22,0x3c,0x20,0x3e,0x22], // 247
  [0xa2,0x94,0x88,0x94,0xa2], // 248
  [0x3c,0x02,0x02,0x02,0x3f], // 249
  [0x28,0x28,0x3e,0x28,0x48], // 250
  [0x22,0x3c,0x28,0x28,0x2e], // 251
  [0x3e,0x28,0x38,0x28,0x3e], // 252
  [0x08,0x08,0x2a,0x08,0x08], // 253
  [0x00,0x00,0x00,0x00,0x00], // 254
  [0xff,0xff,0xff,0xff,0xff], // 255
]

export class LCDAttachment extends AttachmentBase {

  // ── Display geometry ───────────────────────────────────────────
  readonly cols: number
  readonly rows: number

  // ── HD44780 internal state ─────────────────────────────────────

  private entryModeFlags: number = LCD_CMD_ENTRY_MODE_INCREMENT
  private displayFlags: number = 0x00
  private scrollOffset: number = 0

  /** 128-byte Display Data RAM */
  private ddRam: Uint8Array
  /** Current DDRAM pointer offset */
  private ddPtr: number = 0
  private dataWidthCols: number

  /** Character Generator RAM — 16 characters × 8 rows, stored column-major
   *  as 16 × CHAR_WIDTH_PX bytes (matching vrEmuLcd cgRam layout) */
  private cgRam: Uint8Array
  /** Current CGRAM pointer (null when not in CGRAM mode) */
  private cgPtr: number | null = null

  /** Pixel buffer: each byte is -1 (gap), 0 (off) or 1 (on) */
  buffer: Int8Array
  readonly pixelsWidth: number
  readonly pixelsHeight: number

  // ── Cursor blink timing ────────────────────────────────────────
  private blinkAccumulator: number = 0
  private blinkState: boolean = false
  private static readonly BLINK_PERIOD_MS = 350

  // ── VIA bus latch state ────────────────────────────────────────
  private lastPortA: number = 0
  private lastE: boolean = false

  constructor(cols: number = 16, rows: number = 2, priority: number = 0) {
    super(priority, false, false, false, false)

    this.cols = cols
    this.rows = rows

    this.ddRam = new Uint8Array(DDRAM_SIZE)
    this.cgRam = new Uint8Array(CGRAM_STORAGE_CHARS * CHAR_WIDTH_PX)

    this.dataWidthCols = rows <= 1 ? DATA_WIDTH_CHARS_1ROW : DATA_WIDTH_CHARS_2ROW

    this.pixelsWidth  = cols * (CHAR_WIDTH_PX + 1) - 1
    this.pixelsHeight = rows * (CHAR_HEIGHT_PX + 1) - 1
    this.buffer = new Int8Array(this.pixelsWidth * this.pixelsHeight)

    this.reset()
  }

  // ── Attachment interface ───────────────────────────────────

  reset(): void {
    super.reset()

    this.entryModeFlags = LCD_CMD_ENTRY_MODE_INCREMENT
    this.displayFlags = 0x00
    this.scrollOffset = 0

    this.ddRam.fill(0x20) // space
    this.ddPtr = 0
    this.cgRam.fill(DEFAULT_CGRAM_BYTE)
    this.cgPtr = null

    this.blinkAccumulator = 0
    this.blinkState = false
    this.lastPortA = 0
    this.lastE = false

    this.buffer.fill(-1)
    this.updatePixels()
  }

  tick(cpuFrequency: number): void {
    // Advance cursor blink timer
    const msPerTick = (128 / cpuFrequency) * 1000
    this.blinkAccumulator += msPerTick
    if (this.blinkAccumulator >= LCDAttachment.BLINK_PERIOD_MS) {
      this.blinkAccumulator -= LCDAttachment.BLINK_PERIOD_MS
      this.blinkState = !this.blinkState
    }
  }

  /**
   * Port A carries the control signals.
   * We detect E falling edge to latch the bus.
   */
  writePortA(value: number, ddr: number): void {
    const maskedValue = value & ddr
    const currentE = !!(maskedValue & PIN_E)
    const prevE = this.lastE

    // Latch on falling edge of E — use the PREVIOUS lastPortA so that
    // RS/RW reflect the state while E was still HIGH (HD44780 setup-time
    // requirement).  If the CPU drops RS and E in the same VIA write,
    // this preserves the RS value that was active during the E=1 phase.
    if (prevE && !currentE) {
      this.latchBus()
    }

    this.lastPortA = maskedValue
    this.lastE = currentE
  }

  readPortA(ddr: number, or: number): number {
    return 0xFF
  }

  readPortB(ddr: number, or: number): number {
    // If R/W is high (read mode), provide data on Port B
    const portA = this.lastPortA
    if (portA & PIN_RW) {
      if (portA & PIN_RS) {
        // RS=1, RW=1 → Read data
        return this.readByte()
      } else {
        // RS=0, RW=1 → Read address / busy flag
        return this.readAddress()
      }
    }
    return 0xFF
  }

  // ── Bus latch (E falling edge) ────────────────────────────────

  private latchBus(): void {
    const portA = this.lastPortA
    const rw = !!(portA & PIN_RW)
    const rs = !!(portA & PIN_RS)

    if (rw) {
      // Read operations are handled via readPortB
      return
    }

    // Write operation — capture data from Port B output register.
    // Since we can't directly read the OR, the 6502 software must have
    // written data to Port B *before* toggling E. We store it in writePortB
    // — but the VIA card calls writePortB with the actual value. By the time
    // E falls the data on the bus is the Port B output register value.
    // We need the data value — it's available from the last writePortB call.
    // However, writePortB doesn't store anything here. The VIA resolves
    // the actual output from OR & DDR and passes it to us.
    //
    // For writes, the data on Port B is the value written by the CPU.
    // The VIA will have called writePortB with the data already.
    // We need to capture it — store it via writePortB override.

    // Actually — we need to capture the Port B value. Let's store it.
    const data = this.lastPortBValue

    if (rs) {
      this.writeByte(data)
    } else {
      this.sendCommand(data)
    }

    this.updatePixels()
  }

  private lastPortBValue: number = 0

  override writePortB(value: number, ddr: number): void {
    this.lastPortBValue = value & ddr
  }

  // ── HD44780 Command Processing ────────────────────────────────

  sendCommand(command: number): void {
    if (command & LCD_CMD_SET_DRAM_ADDR) {
      // Set DDRAM address — remaining 7 bits
      this.ddPtr = command & 0x7F
      this.cgPtr = null
    } else if (command & LCD_CMD_SET_CGRAM_ADDR) {
      // Set CGRAM address — remaining 6 bits
      this.cgPtr = command & 0x3F
    } else if (command & LCD_CMD_FUNCTION) {
      // Function set — we just acknowledge (8-bit mode, 2-line assumed)
    } else if (command & LCD_CMD_SHIFT) {
      if (command & LCD_CMD_SHIFT_DISPLAY) {
        // Shift entire display
        if (command & LCD_CMD_SHIFT_RIGHT) {
          --this.scrollOffset
        } else {
          ++this.scrollOffset
        }
      } else {
        // Shift cursor
        if (command & LCD_CMD_SHIFT_RIGHT) {
          this.incrementDdPtr()
        } else {
          this.decrementDdPtr()
        }
      }
    } else if (command & LCD_CMD_DISPLAY) {
      this.displayFlags = command
    } else if (command & LCD_CMD_ENTRY_MODE) {
      this.entryModeFlags = command
    } else if (command & LCD_CMD_HOME) {
      this.ddPtr = 0
      this.scrollOffset = 0
    } else if (command === LCD_CMD_CLEAR) {
      this.ddRam.fill(0x20)
      this.ddPtr = 0
      this.scrollOffset = 0
      this.entryModeFlags = LCD_CMD_ENTRY_MODE_INCREMENT
    }
  }

  // ── Data Write / Read ─────────────────────────────────────────

  writeByte(data: number): void {
    if (this.cgPtr !== null) {
      // Write to CGRAM
      const row = this.cgPtr % CHAR_HEIGHT_PX
      const charBase = this.cgPtr - row

      for (let i = 0; i < CHAR_WIDTH_PX; i++) {
        const bit = data & ((0x01 << (CHAR_WIDTH_PX - 1)) >> i)
        const addr = charBase * CHAR_WIDTH_PX / CHAR_HEIGHT_PX * CHAR_HEIGHT_PX
        // CGRAM is stored column-major like vrEmuLcd: cgRam[char][col]
        // Each column byte has rows packed as bits (MSB = row 0)
        const idx = Math.floor(this.cgPtr / CHAR_HEIGHT_PX) * CHAR_WIDTH_PX + i
        if (idx < this.cgRam.length) {
          if (bit) {
            this.cgRam[idx] |= (0x80 >> row)
          } else {
            this.cgRam[idx] &= ~(0x80 >> row)
          }
        }
      }
    } else {
      // Write to DDRAM
      if (this.ddPtr < DDRAM_SIZE) {
        this.ddRam[this.ddPtr] = data
      }
    }
    this.doShift()
  }

  private readByte(): number {
    if (this.cgPtr !== null) {
      const row = this.cgPtr % CHAR_HEIGHT_PX
      const charIdx = Math.floor(this.cgPtr / CHAR_HEIGHT_PX)
      let data = 0
      for (let i = 0; i < CHAR_WIDTH_PX; i++) {
        const idx = charIdx * CHAR_WIDTH_PX + i
        if (idx < this.cgRam.length && (this.cgRam[idx] & (0x80 >> row))) {
          data |= ((0x01 << (CHAR_WIDTH_PX - 1)) >> i)
        }
      }
      return data
    }
    return this.ddPtr < DDRAM_SIZE ? this.ddRam[this.ddPtr] : 0x20
  }

  readAddress(): number {
    if (this.cgPtr !== null) {
      return this.cgPtr & 0x3F
    }
    return this.ddPtr & 0x7F
  }

  // ── DDRAM pointer management ──────────────────────────────────

  private incrementDdPtr(): void {
    this.ddPtr++
    if (this.rows > 1) {
      if (this.ddPtr === 0x28) {
        this.ddPtr = 0x40
      } else if (this.ddPtr === 0x68 || this.ddPtr >= DDRAM_SIZE) {
        this.ddPtr = 0x00
      }
    } else if (this.ddPtr >= 80) {
      this.ddPtr = 0
    }
  }

  private decrementDdPtr(): void {
    this.ddPtr--
    if (this.rows > 1) {
      if (this.ddPtr < 0) {
        this.ddPtr = 0x67
      } else if (this.ddPtr === 0x3F) {
        this.ddPtr = 0x27
      }
    } else {
      if (this.ddPtr < 0) {
        this.ddPtr = 79
      }
    }
  }

  private doShift(): void {
    if (this.cgPtr !== null) {
      // Shift CGRAM pointer
      if (this.entryModeFlags & LCD_CMD_ENTRY_MODE_INCREMENT) {
        this.cgPtr++
        if (this.cgPtr >= CGRAM_STORAGE_CHARS * CHAR_HEIGHT_PX) {
          this.cgPtr = 0
        }
      } else {
        this.cgPtr--
        if (this.cgPtr < 0) {
          this.cgPtr = CGRAM_STORAGE_CHARS * CHAR_HEIGHT_PX - 1
        }
      }
      return
    }

    // Shift display or cursor
    if (this.entryModeFlags & LCD_CMD_ENTRY_MODE_SHIFT) {
      if (this.entryModeFlags & LCD_CMD_ENTRY_MODE_INCREMENT) {
        ++this.scrollOffset
      } else {
        --this.scrollOffset
      }
    }

    if (this.entryModeFlags & LCD_CMD_ENTRY_MODE_INCREMENT) {
      this.incrementDdPtr()
    } else {
      this.decrementDdPtr()
    }
  }

  // ── Character Data Lookup ─────────────────────────────────────

  /**
   * Get the 5-column font data for a character.
   * Characters 0–15 come from CGRAM; 16–255 from ROM.
   */
  private charBits(c: number): readonly number[] | Uint8Array {
    if (c < CGRAM_STORAGE_CHARS) {
      // Return a slice of cgRam for this character
      const start = c * CHAR_WIDTH_PX
      return this.cgRam.subarray(start, start + CHAR_WIDTH_PX)
    }
    return FONT_A00[c - CGRAM_STORAGE_CHARS]
  }

  // ── Data Offset Helper ────────────────────────────────────────

  private getDataOffset(row: number, col: number): number {
    if (row >= this.rows) row = this.rows - 1

    // Normalize negative scroll offset
    let scroll = this.scrollOffset
    while (scroll < 0) {
      scroll += this.dataWidthCols
    }

    const dataCol = (col + scroll) % this.dataWidthCols

    if (this.rows > 1) {
      return ROW_OFFSETS[row] + dataCol
    }
    return dataCol
  }

  // ── Pixel Buffer Update ───────────────────────────────────────

  updatePixels(): void {
    const displayOn = !!(this.displayFlags & LCD_CMD_DISPLAY_ON)

    // Determine cursor state
    let cursorOn = this.displayFlags & CURSOR_MASK
    if (this.displayFlags & LCD_CMD_DISPLAY_CURSOR_BLINK) {
      if (this.blinkState) {
        cursorOn &= ~LCD_CMD_DISPLAY_CURSOR_BLINK
      }
    }

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        // Top-left pixel for this character cell
        const charTopLeftX = col * (CHAR_WIDTH_PX + 1)
        const charTopLeftY = row * (CHAR_HEIGHT_PX + 1)

        // DDRAM offset
        const ddOffset = this.getDataOffset(row, col)
        const charCode = this.ddRam[ddOffset] ?? 0x20

        // Should we draw cursor here?
        const drawCursor = cursorOn && (ddOffset === this.ddPtr) && this.cgPtr === null

        // Get font data
        const bits = this.charBits(charCode)

        // Render 5×8 character
        for (let y = 0; y < CHAR_HEIGHT_PX; y++) {
          for (let x = 0; x < CHAR_WIDTH_PX; x++) {
            const pixelIdx = (charTopLeftY + y) * this.pixelsWidth + (charTopLeftX + x)

            if (!displayOn) {
              this.buffer[pixelIdx] = 0
              continue
            }

            // Font data is column-major: bits[x] has row bits, MSB = row 0
            let pixel = (bits[x] & (0x80 >> y)) ? 1 : 0

            // Cursor override
            if (drawCursor) {
              if ((cursorOn & LCD_CMD_DISPLAY_CURSOR_BLINK) ||
                  ((cursorOn & LCD_CMD_DISPLAY_CURSOR) && y === CHAR_HEIGHT_PX - 1)) {
                pixel = 1
              }
            }

            this.buffer[pixelIdx] = pixel as 0 | 1
          }
        }
      }
    }
  }

  // ── Public Accessors (for rendering / debugging) ──────────────

  /** Get the raw DDRAM contents */
  getDDRam(): Uint8Array {
    return this.ddRam
  }

  /** Get the current DDRAM address pointer */
  getDDPtr(): number {
    return this.ddPtr
  }

  /** Get the display flags */
  getDisplayFlags(): number {
    return this.displayFlags
  }

  /** Get the entry mode flags */
  getEntryModeFlags(): number {
    return this.entryModeFlags
  }

  /** Get scroll offset */
  getScrollOffset(): number {
    return this.scrollOffset
  }

  /** Get CGRAM pointer (null if not in CGRAM mode) */
  getCGPtr(): number | null {
    return this.cgPtr
  }

  /** Read the text content of a specific display row */
  getRowText(row: number): string {
    let text = ''
    for (let col = 0; col < this.cols; col++) {
      const offset = this.getDataOffset(row, col)
      text += String.fromCharCode(this.ddRam[offset])
    }
    return text
  }

  /** Pixel state at a given coordinate: -1 (gap), 0 (off), 1 (on) */
  pixelState(x: number, y: number): number {
    const offset = y * this.pixelsWidth + x
    if (offset >= 0 && offset < this.buffer.length) {
      return this.buffer[offset]
    }
    return -1
  }
}
