import { UsageError } from '../args'

/**
 * Turn `\r`, `\n`, `\t` and `\\` written literally in a shell argument into the
 * bytes they mean.
 *
 * A single-quoted shell string cannot contain a real carriage return, and the
 * plan's own examples — `6502 dbg send 'LIST\r'` — depend on the CLI doing this
 * translation rather than the shell.
 */
export function unescape(text: string): string {
  return text.replace(/\\(r|n|t|\\)/g, (_, code: string) =>
    code === 'r' ? '\r' : code === 'n' ? '\n' : code === 't' ? '\t' : '\\'
  )
}

/**
 * A list of bytes, written as hex pairs (`DEADBEEF`), or comma/space separated
 * values (`0xDE, 0xAD` or `222,173`) — whichever reads naturally for the call.
 */
export function parseByteList(text: string, label: string): number[] {
  const trimmed = text.trim()
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0 && !trimmed.includes(' ')) {
    const bytes: number[] = []
    for (let i = 0; i < trimmed.length; i += 2) bytes.push(parseInt(trimmed.slice(i, i + 2), 16))
    return bytes
  }

  return trimmed
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      const hex = token.startsWith('$') ? token.slice(1) : /^0x/i.test(token) ? token.slice(2) : null
      const value = hex === null ? Number(token) : parseInt(hex, 16)
      if (!Number.isInteger(value) || value < 0 || value > 0xff) {
        throw new UsageError(`${label}: expected bytes 0-255, got "${token}"`)
      }
      return value
    })
}
