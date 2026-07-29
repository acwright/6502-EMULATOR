/**
 * A small expression language for breakpoint conditions.
 *
 * Deliberately tiny: enough to say "stop here, but only when it matters" —
 * `A == $FF`, `[$0400] > 10 && X != 0`, `PC >= main` — and nothing more. A
 * breakpoint condition that needs more than this is better written as code.
 *
 * Numbers are 6502-flavoured: `$C000` and `0xC000` are hex, bare digits are
 * decimal. `[expr]` reads a byte through the bus, and `{expr}` reads a
 * little-endian word, which is how you inspect a pointer.
 */

export class ExpressionError extends Error {}

/** What an expression can see when it runs. */
export interface EvalContext {
  registers: Readonly<Record<string, number>>
  read(address: number): number
  /** Resolve a bare identifier — a symbol name — to an address. */
  symbol?(name: string): number | undefined
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }

const OPERATORS = [
  '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '(', ')', '[', ']', '{', '}',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>'
]

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < input.length) {
    const char = input[i]!

    if (/\s/.test(char)) {
      i++
      continue
    }

    if (char === '$' || (char === '0' && /[xX]/.test(input[i + 1] ?? ''))) {
      const start = char === '$' ? i + 1 : i + 2
      let end = start
      while (end < input.length && /[0-9a-fA-F]/.test(input[end]!)) end++
      if (end === start) throw new ExpressionError(`expected hex digits at "${input.slice(i)}"`)
      tokens.push({ kind: 'number', value: parseInt(input.slice(start, end), 16) })
      i = end
      continue
    }

    if (/[0-9]/.test(char)) {
      let end = i
      while (end < input.length && /[0-9]/.test(input[end]!)) end++
      tokens.push({ kind: 'number', value: Number(input.slice(i, end)) })
      i = end
      continue
    }

    if (/[A-Za-z_.]/.test(char)) {
      let end = i
      while (end < input.length && /[A-Za-z0-9_.]/.test(input[end]!)) end++
      tokens.push({ kind: 'ident', value: input.slice(i, end) })
      i = end
      continue
    }

    const op = OPERATORS.find((candidate) => input.startsWith(candidate, i))
    if (!op) throw new ExpressionError(`unexpected character "${char}"`)
    tokens.push({ kind: 'op', value: op })
    i += op.length
  }

  return tokens
}

/** Binding power, loosest first. Mirrors C, which is what people expect. */
const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '<=': 7,
  '>': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10
}

/** A parsed condition, reusable across evaluations. */
export type CompiledExpression = (context: EvalContext) => number

export function compileExpression(source: string): CompiledExpression {
  const tokens = tokenize(source)
  let pos = 0

  const peek = (): Token | undefined => tokens[pos]
  const isOp = (value: string): boolean => {
    const token = peek()
    return token?.kind === 'op' && token.value === value
  }
  const expect = (value: string): void => {
    if (!isOp(value)) throw new ExpressionError(`expected "${value}"`)
    pos++
  }

  function parsePrimary(): CompiledExpression {
    const token = peek()
    if (!token) throw new ExpressionError('unexpected end of expression')

    if (token.kind === 'number') {
      pos++
      return () => token.value
    }

    if (token.kind === 'ident') {
      pos++
      const name = token.value.toUpperCase()
      return (context) => {
        if (name in context.registers) return context.registers[name]!
        const address = context.symbol?.(token.value)
        if (address !== undefined) return address
        throw new ExpressionError(`unknown name "${token.value}"`)
      }
    }

    if (isOp('(')) {
      pos++
      const inner = parseBinary(0)
      expect(')')
      return inner
    }

    if (isOp('[')) {
      pos++
      const inner = parseBinary(0)
      expect(']')
      return (context) => context.read(inner(context) & 0xffff) & 0xff
    }

    if (isOp('{')) {
      pos++
      const inner = parseBinary(0)
      expect('}')
      return (context) => {
        const address = inner(context) & 0xffff
        return (context.read(address) & 0xff) | ((context.read((address + 1) & 0xffff) & 0xff) << 8)
      }
    }

    for (const [op, apply] of [
      ['-', (value: number) => -value],
      ['~', (value: number) => ~value],
      ['!', (value: number) => (value ? 0 : 1)]
    ] as const) {
      if (isOp(op)) {
        pos++
        const operand = parseUnary()
        return (context) => apply(operand(context))
      }
    }

    throw new ExpressionError(`unexpected "${token.value}"`)
  }

  function parseUnary(): CompiledExpression {
    return parsePrimary()
  }

  function parseBinary(minPrecedence: number): CompiledExpression {
    let left = parseUnary()

    for (;;) {
      const token = peek()
      if (token?.kind !== 'op') break
      const precedence = BINARY_PRECEDENCE[token.value]
      if (precedence === undefined || precedence < minPrecedence) break

      pos++
      const right = parseBinary(precedence + 1)
      const op = token.value
      const l = left
      left = (context) => apply(op, l(context), right(context))
    }

    return left
  }

  const root = parseBinary(0)
  if (pos !== tokens.length) throw new ExpressionError('trailing input after expression')
  return root
}

function apply(op: string, a: number, b: number): number {
  switch (op) {
    case '+': return a + b
    case '-': return a - b
    case '*': return a * b
    case '/': return b === 0 ? 0 : Math.floor(a / b)
    case '%': return b === 0 ? 0 : a % b
    case '&': return a & b
    case '|': return a | b
    case '^': return a ^ b
    case '<<': return a << b
    case '>>': return a >> b
    case '==': return a === b ? 1 : 0
    case '!=': return a !== b ? 1 : 0
    case '<': return a < b ? 1 : 0
    case '<=': return a <= b ? 1 : 0
    case '>': return a > b ? 1 : 0
    case '>=': return a >= b ? 1 : 0
    case '&&': return a && b ? 1 : 0
    case '||': return a || b ? 1 : 0
    default: throw new ExpressionError(`unknown operator "${op}"`)
  }
}

/** Evaluate once. Prefer compileExpression() when the same source is reused. */
export function evaluateExpression(source: string, context: EvalContext): number {
  return compileExpression(source)(context)
}
