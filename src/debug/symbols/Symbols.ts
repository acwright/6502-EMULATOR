/**
 * Symbol and source-line lookup for a loaded program.
 *
 * Two directions matter and both need to be fast: name to address, for setting
 * a breakpoint on `main`, and address to name, for making a disassembly
 * readable. Source lines are the extra step a DAP adapter needs to put a
 * breakpoint marker in an editor gutter.
 */

export interface Symbol_ {
  name: string
  address: number
  /** Where it came from, for reporting conflicts between loaded files. */
  source?: string
}

export interface SourceLocation {
  file: string
  line: number
}

export class SymbolTable {
  private readonly byName = new Map<string, Symbol_>()

  /** Addresses to every name bound there — aliases are common in assembly. */
  private readonly byAddress = new Map<number, Symbol_[]>()

  /** Address to source position, for the addresses a listing covers. */
  private readonly lines = new Map<number, SourceLocation>()

  get size(): number {
    return this.byName.size
  }

  add(symbol: Symbol_): void {
    const address = symbol.address & 0xffff
    const entry = { ...symbol, address }

    this.byName.set(entry.name, entry)
    const existing = this.byAddress.get(address)
    if (existing) existing.push(entry)
    else this.byAddress.set(address, [entry])
  }

  addLine(address: number, location: SourceLocation): void {
    this.lines.set(address & 0xffff, location)
  }

  merge(other: SymbolTable): void {
    for (const symbol of other.byName.values()) this.add(symbol)
    for (const [address, location] of other.lines) this.lines.set(address, location)
  }

  clear(): void {
    this.byName.clear()
    this.byAddress.clear()
    this.lines.clear()
  }

  /** Address for a name, or undefined. */
  resolve(name: string): number | undefined {
    return this.byName.get(name)?.address
  }

  /**
   * The name bound at exactly this address. Where several names share an
   * address the first one loaded wins, which keeps disassembly stable.
   */
  nameFor(address: number): string | undefined {
    return this.byAddress.get(address & 0xffff)?.[0]?.name
  }

  /**
   * The nearest symbol at or below `address`, with the distance past it.
   *
   * This is what makes an arbitrary PC readable — `main+7` says far more than
   * `$C007`. Bounded so a lone symbol at the bottom of memory does not claim
   * everything above it.
   */
  nearest(address: number, maxDistance = 0x100): { symbol: Symbol_; offset: number } | undefined {
    const at = address & 0xffff
    for (let candidate = at; candidate >= Math.max(0, at - maxDistance); candidate--) {
      const found = this.byAddress.get(candidate)?.[0]
      if (found) return { symbol: found, offset: at - candidate }
    }
    return undefined
  }

  lineFor(address: number): SourceLocation | undefined {
    return this.lines.get(address & 0xffff)
  }

  list(): Symbol_[] {
    return [...this.byName.values()].sort((a, b) => a.address - b.address)
  }

  /** A resolver for the disassembler: exact matches only, no offsets. */
  resolver(): (address: number) => string | undefined {
    return (address) => this.nameFor(address)
  }
}
