import { SymbolTable } from './Symbols'

/**
 * Parsers for the label formats 6502 assemblers emit.
 *
 * VICE labels first, because ca65, 64tass and ACME can all produce them — it is
 * the lowest common denominator and enough for symbolic disassembly and
 * `break main`. The ca65 debug file is the richer one, and the only one here
 * that carries source line numbers.
 */

/**
 * VICE label file:
 *
 *   al C:0800 .start
 *   al 00C012 .PrintChar
 *   add_label C:1234 .foo
 *
 * `al` is add-label, the optional `C:` names the memory space (the computer,
 * as opposed to a disk drive), and the leading dot on the name is VICE's own
 * marker rather than part of the label.
 */
export function parseViceLabels(text: string, source = 'vice'): SymbolTable {
  const table = new SymbolTable()

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue

    const match = /^(?:al|add_label)\s+(?:[A-Za-z]:)?\$?([0-9a-fA-F]+)\s+\.?(\S+)/.exec(line)
    if (!match) continue

    table.add({ name: match[2]!, address: parseInt(match[1]!, 16), source })
  }

  return table
}

/** Split a ca65 attribute list — `id=0,name="x",val=0xC000` — into a map. */
function attributes(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  // Values may be quoted and contain commas, so scan rather than split.
  const re = /(\w+)=("(?:[^"\\]|\\.)*"|[^,\s]*)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(line)) !== null) {
    const value = match[2]!
    out[match[1]!] = value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value
  }
  return out
}

const num = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined
  const value = /^0x/i.test(text) ? parseInt(text.slice(2), 16) : Number(text)
  return Number.isFinite(value) ? value : undefined
}

/**
 * ca65 debug file (`ld65 --dbgfile`).
 *
 * Line-oriented records, each a type followed by attributes:
 *
 *   sym  id=0,name="main",val=0xC000,type=lab,...
 *   seg  id=0,name="CODE",start=0xC000,size=0x100,...
 *   span id=0,seg=0,start=0,size=3,...
 *   line id=0,file=0,line=10,span=0+1
 *   file id=0,name="main.s",...
 *
 * Addresses for source lines are indirect: a line names spans, a span is an
 * offset and size within a segment, and the segment carries the load address.
 * Resolving that chain is what turns a debug file into gutter breakpoints.
 */
export function parseCa65Dbg(text: string, source = 'ca65'): SymbolTable {
  const table = new SymbolTable()

  const files = new Map<number, string>()
  const segments = new Map<number, number>()
  const spans = new Map<number, { seg: number; start: number; size: number }>()
  const lineRecords: { file: number; line: number; spans: number[] }[] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    const [kind] = line.split(/\s+/, 1)
    const attrs = attributes(line.slice(kind!.length))

    switch (kind) {
      case 'sym': {
        const value = num(attrs.val)
        const name = attrs.name
        // Equates and imports have no address; only labels place code or data.
        if (name && value !== undefined) table.add({ name, address: value, source })
        break
      }
      case 'file': {
        const id = num(attrs.id)
        if (id !== undefined && attrs.name) files.set(id, attrs.name)
        break
      }
      case 'seg': {
        const id = num(attrs.id)
        const start = num(attrs.start)
        if (id !== undefined && start !== undefined) segments.set(id, start)
        break
      }
      case 'span': {
        const id = num(attrs.id)
        const seg = num(attrs.seg)
        const start = num(attrs.start)
        const size = num(attrs.size)
        if (id !== undefined && seg !== undefined && start !== undefined && size !== undefined) {
          spans.set(id, { seg, start, size })
        }
        break
      }
      case 'line': {
        const file = num(attrs.file)
        const lineNumber = num(attrs.line)
        // Multiple spans are joined with '+'.
        const ids = (attrs.span ?? '')
          .split('+')
          .map((part) => num(part))
          .filter((value): value is number => value !== undefined)
        if (file !== undefined && lineNumber !== undefined && ids.length > 0) {
          lineRecords.push({ file, line: lineNumber, spans: ids })
        }
        break
      }
    }
  }

  for (const record of lineRecords) {
    const name = files.get(record.file)
    if (!name) continue

    for (const spanId of record.spans) {
      const span = spans.get(spanId)
      if (!span) continue
      const base = segments.get(span.seg)
      if (base === undefined) continue

      for (let offset = 0; offset < span.size; offset++) {
        table.addLine(base + span.start + offset, { file: name, line: record.line })
      }
    }
  }

  return table
}

export type SymbolFormat = 'vice' | 'ca65'

/** Guess a format from the file extension, defaulting to VICE labels. */
export function formatForPath(path: string): SymbolFormat {
  return /\.dbg$/i.test(path) ? 'ca65' : 'vice'
}

export function parseSymbols(text: string, format: SymbolFormat, source?: string): SymbolTable {
  return format === 'ca65' ? parseCa65Dbg(text, source) : parseViceLabels(text, source)
}
