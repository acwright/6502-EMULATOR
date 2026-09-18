import { SERIAL_CARDS, jumpersOf, normalizeSerialCard } from '../core/IO/SerialCard'
import type { JumperPin, JumperPosition, SerialCardConfig, SerialCardModel } from '../core/IO/SerialCard'

/**
 * Choosing the serial card and its jumpers: one source for the CLI, the app
 * and the debug protocol, as `vdp.ts` is for the video card.
 *
 * The card is named the same way everywhere — `--serial-card`,
 * `AppSettings.serialCard`, `session.info.serialCard` — and the values are
 * `SerialCardModel`'s. The jumpers are `--cts` and `--dcd`, `ground` or
 * `cable`. `core/IO/SerialCard.ts` is the hardware; this is what this app
 * offers of it.
 */

/**
 * The cards this app offers. All three: its main target is the ACE, whose
 * R6551 is on the board, and it also serves the COB, VCS and DEV, which take
 * either Serial Card.
 */
export const SERIAL_CARDS_OFFERED: readonly SerialCardModel[] = ['standard', 'pro', 'ace']

/**
 * The card a machine gets when nothing names one: the ACE, `CTS EN` and
 * `DCD EN` at ground, where every board has them. The same as `Machine`'s own
 * `DEFAULT_SERIAL_CARD`, which a test holds it to; kept here so that the main
 * process can name it without loading the machine.
 */
export const DEFAULT_SERIAL_CARD: SerialCardConfig = {
  card: 'ace',
  jumpers: { cts: 'ground', dcd: 'ground' }
}

/** A card's name as a person typed it, or null if it names no card this app offers. */
export function parseSerialCard(raw: string | null | undefined): SerialCardModel | null {
  if (raw === null || raw === undefined) return null
  const value = raw.trim().toLowerCase() as SerialCardModel
  return SERIAL_CARDS_OFFERED.includes(value) ? value : null
}

/** A jumper position as a person typed it, or null. */
export function parseJumperPosition(raw: string | null | undefined): JumperPosition | null {
  if (raw === null || raw === undefined) return null
  const value = raw.trim().toLowerCase()
  return value === 'ground' || value === 'cable' ? value : null
}

/**
 * A card and jumpers read back from somewhere untrusted — a settings file, a
 * protocol call — or null if it names no card this app offers. Jumpers the
 * card lacks are dropped and unreadable ones are at ground, as
 * `normalizeSerialCard` does.
 */
export function readSerialCard(value: unknown): SerialCardConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const { card, jumpers } = value as { card?: unknown; jumpers?: unknown }
  const model = typeof card === 'string' ? parseSerialCard(card) : null
  if (!model) return null
  const given = (typeof jumpers === 'object' && jumpers !== null ? jumpers : {}) as Record<string, unknown>
  const read: SerialCardConfig['jumpers'] = {}
  for (const pin of jumpersOf(model)) {
    const position = typeof given[pin] === 'string' ? parseJumperPosition(given[pin] as string) : null
    if (position) read[pin] = position
  }
  return normalizeSerialCard({ card: model, jumpers: read })
}

/**
 * Whether a card is `DEFAULT_SERIAL_CARD`: the ACE, its jumpers at ground.
 * What `dbg info` and the banner leave unsaid.
 */
export function isDefaultSerialCard(config: SerialCardConfig): boolean {
  const normal = normalizeSerialCard(config)
  return (
    normal.card === DEFAULT_SERIAL_CARD.card &&
    jumpersOf(normal.card).every((pin) => normal.jumpers[pin] === DEFAULT_SERIAL_CARD.jumpers[pin])
  )
}

/**
 * The card and its jumpers as a person reads them off the board:
 * `Serial Card Pro (DCD Select: cable)`, `ACE (CTS EN: ground, DCD EN: ground)`.
 */
export function describeSerialCard(config: SerialCardConfig): string {
  const normal = normalizeSerialCard(config)
  const spec = SERIAL_CARDS[normal.card]
  const jumpers = jumpersOf(normal.card).map(
    (pin: JumperPin) => `${spec.jumperLabels[pin]}: ${normal.jumpers[pin]}`
  )
  return jumpers.length > 0 ? `${spec.name} (${jumpers.join(', ')})` : spec.name
}
