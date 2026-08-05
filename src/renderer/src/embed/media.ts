import type { MediaSource } from './params'

/**
 * Turn a parsed `MediaSource` into bytes.
 *
 * The inline half is free — the bytes came out of the URL. The fetched half is
 * the one with conditions on it, and both of them are the host page's to satisfy,
 * not ours:
 *
 * - **CORS.** A cross-origin `rom=`/`prg=`/`cf=` needs
 *   `Access-Control-Allow-Origin` from whatever serves it. Nothing the embed can
 *   do makes up for its absence.
 * - **CSP.** `embed.html` widens `connect-src` to `'self' https:` for exactly
 *   this fetch; a plain `http:` URL is still refused, and correctly so.
 *
 * When either one fails the embed says so and boots anyway — a docs page with a
 * broken program link should still show a working BASIC prompt.
 */
export async function loadMedia(source: MediaSource): Promise<Uint8Array> {
  if (source.kind === 'inline') return source.bytes

  const response = await fetch(source.url, { mode: 'cors', credentials: 'omit' })
  if (!response.ok) {
    throw new Error(`${source.url}: HTTP ${response.status} ${response.statusText}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * `loadMedia` that reports rather than rejects, for the boot sequence — one
 * unreachable URL must not take the rest of the machine's media with it.
 */
export async function tryLoadMedia(
  source: MediaSource,
  what: string,
  problems: string[]
): Promise<Uint8Array | null> {
  try {
    return await loadMedia(source)
  } catch (e) {
    problems.push(`${what}: ${(e as Error).message}`)
    return null
  }
}
