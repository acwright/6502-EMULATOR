import { compileExpression, ExpressionError } from './Expression'
import type { CompiledExpression, EvalContext } from './Expression'

export type BreakpointKind = 'exec' | 'read' | 'write' | 'access'

export interface BreakpointSpec {
  kind?: BreakpointKind
  address: number
  /** Inclusive end of a watched range. Defaults to `address`. */
  end?: number
  /** Only break when this evaluates non-zero. */
  condition?: string
  /** Skip this many otherwise-qualifying hits before breaking. */
  ignoreCount?: number
  /** Remove after it fires once — a run-to-cursor. */
  temporary?: boolean
  enabled?: boolean
}

export interface Breakpoint {
  id: number
  kind: BreakpointKind
  address: number
  end: number
  condition?: string
  ignoreCount: number
  temporary: boolean
  enabled: boolean
  /** How many times it has fired. */
  hits: number
  compiled?: CompiledExpression
}

export interface BreakpointHit {
  breakpoint: Breakpoint
  address: number
  /** Which access tripped a watchpoint. Absent for execution breakpoints. */
  access?: 'read' | 'write'
  /**
   * Set when the condition could not be evaluated and the breakpoint fired for
   * that reason rather than because the condition was true. Without this the
   * two are indistinguishable, and a typo in a symbol name looks exactly like a
   * breakpoint ignoring its condition.
   */
  conditionError?: string
}

/**
 * Breakpoints and watchpoints, arranged so that having none costs nothing.
 *
 * Execution breakpoints live in a 64K byte map rather than a list, so the check
 * at each instruction boundary is one indexed load — no iteration, no
 * allocation. `armed` lets the caller skip even that when nothing is set, which
 * is the case every time someone is just running the emulator normally.
 *
 * Conditions are only ever evaluated after the map has already said yes, so
 * their cost is irrelevant to the hot path.
 */
export class Breakpoints {
  /** Non-zero where an execution breakpoint is set. */
  private readonly execMap = new Uint8Array(0x10000)

  /** Non-zero where a read or write watchpoint covers the address. */
  private readonly readMap = new Uint8Array(0x10000)
  private readonly writeMap = new Uint8Array(0x10000)

  private readonly breakpoints = new Map<number, Breakpoint>()
  private nextId = 1

  /** True when any breakpoint is enabled — lets the run loop skip all checks. */
  get armed(): boolean {
    return this.execArmed || this.watchArmed
  }

  /** True when any execution breakpoint is enabled. */
  execArmed = false

  /** True when any watchpoint is enabled; gates the bus hooks. */
  watchArmed = false

  add(spec: BreakpointSpec): Breakpoint {
    const address = spec.address & 0xffff
    const end = Math.max(address, (spec.end ?? spec.address) & 0xffff)

    let compiled: CompiledExpression | undefined
    if (spec.condition) {
      try {
        compiled = compileExpression(spec.condition)
      } catch (e) {
        throw new ExpressionError(
          `condition "${spec.condition}": ${(e as Error).message}`
        )
      }
    }

    const breakpoint: Breakpoint = {
      id: this.nextId++,
      kind: spec.kind ?? 'exec',
      address,
      end,
      ...(spec.condition ? { condition: spec.condition } : {}),
      ignoreCount: spec.ignoreCount ?? 0,
      temporary: spec.temporary ?? false,
      enabled: spec.enabled ?? true,
      hits: 0,
      ...(compiled ? { compiled } : {})
    }

    this.breakpoints.set(breakpoint.id, breakpoint)
    this.reindex()
    return breakpoint
  }

  remove(id: number): boolean {
    const removed = this.breakpoints.delete(id)
    if (removed) this.reindex()
    return removed
  }

  clear(): void {
    this.breakpoints.clear()
    this.reindex()
  }

  setEnabled(id: number, enabled: boolean): boolean {
    const breakpoint = this.breakpoints.get(id)
    if (!breakpoint) return false
    breakpoint.enabled = enabled
    this.reindex()
    return true
  }

  list(): Breakpoint[] {
    return [...this.breakpoints.values()].sort((a, b) => a.id - b.id)
  }

  get(id: number): Breakpoint | undefined {
    return this.breakpoints.get(id)
  }

  /** Rebuild the address maps. Called on every change, never while running. */
  private reindex(): void {
    this.execMap.fill(0)
    this.readMap.fill(0)
    this.writeMap.fill(0)
    this.execArmed = false
    this.watchArmed = false

    for (const breakpoint of this.breakpoints.values()) {
      if (!breakpoint.enabled) continue

      const maps: Uint8Array[] = []
      if (breakpoint.kind === 'exec') maps.push(this.execMap)
      if (breakpoint.kind === 'read' || breakpoint.kind === 'access') maps.push(this.readMap)
      if (breakpoint.kind === 'write' || breakpoint.kind === 'access') maps.push(this.writeMap)

      for (const map of maps) {
        for (let address = breakpoint.address; address <= breakpoint.end; address++) {
          map[address & 0xffff] = 1
        }
      }

      if (breakpoint.kind === 'exec') this.execArmed = true
      else this.watchArmed = true
    }
  }

  /** Cheap pre-check for the run loop: is anything set at this address? */
  hasExecAt(address: number): boolean {
    return this.execMap[address & 0xffff] !== 0
  }

  hasWatchAt(address: number, access: 'read' | 'write'): boolean {
    const map = access === 'read' ? this.readMap : this.writeMap
    return map[address & 0xffff] !== 0
  }

  /**
   * Find the breakpoint that should fire at `address`, honouring conditions and
   * ignore counts. Returns undefined when the map hit but nothing qualified —
   * a condition that came out false, or a hit still being counted down.
   */
  match(
    address: number,
    kind: 'exec' | 'read' | 'write',
    context: EvalContext
  ): BreakpointHit | undefined {
    const at = address & 0xffff

    for (const breakpoint of this.breakpoints.values()) {
      if (!breakpoint.enabled) continue
      if (at < breakpoint.address || at > breakpoint.end) continue

      if (kind === 'exec') {
        if (breakpoint.kind !== 'exec') continue
      } else if (breakpoint.kind !== kind && breakpoint.kind !== 'access') {
        continue
      }

      let conditionError: string | undefined
      if (breakpoint.compiled) {
        let result: number
        try {
          result = breakpoint.compiled(context)
        } catch (e) {
          // A condition that cannot be evaluated — an unknown symbol, say —
          // must not silently swallow the breakpoint. Break, and carry the
          // reason out with the hit: breaking without saying why is
          // indistinguishable from a breakpoint ignoring its condition, which
          // is exactly how a mistyped symbol name presents.
          conditionError = (e as Error).message
          result = 1
        }
        if (!result) continue
      }

      if (breakpoint.ignoreCount > 0) {
        breakpoint.ignoreCount--
        continue
      }

      breakpoint.hits++
      if (breakpoint.temporary) this.remove(breakpoint.id)

      return {
        breakpoint,
        address: at,
        ...(kind === 'exec' ? {} : { access: kind }),
        ...(conditionError ? { conditionError } : {})
      }
    }

    return undefined
  }
}
