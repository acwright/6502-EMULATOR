/**
 * The serial cards an R6551 sits on, and where each of its modem-control
 * inputs comes from.
 *
 * Read out of the schematics: `6502-COB/Hardware/Serial Card/Rev 1.0`,
 * `6502-COB/Hardware/Serial Card Pro/Rev 1.0` and
 * `6502-ACE/Hardware/ACE Board/Rev 1.1`. A pin whose net reaches the DB-9
 * through the level shifter is `cable`; one tied off is `ground`; one on a
 * 1×3 header is `jumper`, and the jumper picks one of the other two.
 *
 * | R6551 pin | Serial Card        | Serial Card Pro        | ACE              |
 * |-----------|--------------------|------------------------|------------------|
 * | CTSB      | jumper `CTS EN`    | cable                  | jumper `CTS EN`  |
 * | DCDB      | ground             | jumper `DCD Select`    | jumper `DCD EN`  |
 * | DSRB      | ground             | cable                  | cable            |
 *
 * RTSB always reaches the cable. DTRB reaches it on the Pro and the ACE and is
 * left floating on the Serial Card, which changes nothing inside the chip:
 * command bit 0 still gates the receiver, transmitter and interrupts (see
 * `ACIA.dataTerminalReady`).
 *
 * Every jumper has been fitted at ground on every board built, which is also
 * what the emulator did before it modelled any of this (6502-COB `09988ca`,
 * 6502-ACE `b181f70`). Ground is asserted, so a card with its jumpers there
 * behaves exactly as one with the lines tied off.
 *
 * This is the hardware, not a menu. Which cards an app offers is the app's
 * business: the ACE's serial is on the ACE board, and cannot be fitted to a KIM.
 */

export type SerialCardModel = 'standard' | 'pro' | 'ace'

/** The R6551's modem-control inputs. RTSB and DTRB are outputs. */
export type SerialPin = 'cts' | 'dcd' | 'dsr'

/** Where a jumper connects its pin: to ground (asserted), or to the cable. */
export type JumperPosition = 'ground' | 'cable'

/** How a card wires one pin. */
export type PinWiring = 'ground' | 'cable' | 'jumper'

/** The pins that can carry a jumper on some card. DSRB never does. */
export type JumperPin = 'cts' | 'dcd'

/** A card, and where its jumpers are. A jumper the card lacks is not here. */
export interface SerialCardConfig {
  card: SerialCardModel
  jumpers: Partial<Record<JumperPin, JumperPosition>>
}

export interface SerialCardSpec {
  /** The card's name as a person reads it. */
  name: string
  wiring: Record<SerialPin, PinWiring>
  /** The silkscreen label of each jumper the card has. */
  jumperLabels: Partial<Record<JumperPin, string>>
}

export const SERIAL_CARDS: Record<SerialCardModel, SerialCardSpec> = {
  standard: {
    name: 'Serial Card',
    wiring: { cts: 'jumper', dcd: 'ground', dsr: 'ground' },
    jumperLabels: { cts: 'CTS EN' }
  },
  pro: {
    name: 'Serial Card Pro',
    wiring: { cts: 'cable', dcd: 'jumper', dsr: 'cable' },
    jumperLabels: { dcd: 'DCD Select' }
  },
  ace: {
    name: 'ACE',
    wiring: { cts: 'jumper', dcd: 'jumper', dsr: 'cable' },
    jumperLabels: { cts: 'CTS EN', dcd: 'DCD EN' }
  }
}

const SERIAL_PINS: readonly SerialPin[] = ['cts', 'dcd', 'dsr']

/** The jumpers a card has, in pin order. */
export function jumpersOf(card: SerialCardModel): JumperPin[] {
  return SERIAL_PINS.filter((pin): pin is JumperPin => SERIAL_CARDS[card].wiring[pin] === 'jumper')
}

/**
 * A config holding exactly the card's own jumpers: one the card lacks is
 * dropped, and one not given is at ground, where every board has it.
 */
export function normalizeSerialCard(config: SerialCardConfig): SerialCardConfig {
  const jumpers: SerialCardConfig['jumpers'] = {}
  for (const pin of jumpersOf(config.card)) {
    jumpers[pin] = config.jumpers[pin] === 'cable' ? 'cable' : 'ground'
  }
  return { card: config.card, jumpers }
}

/**
 * Where each pin's level comes from on this card with these jumpers: `ground`
 * (always asserted) or `cable` (whatever the far end drives).
 */
export function pinSources(config: SerialCardConfig): Record<SerialPin, JumperPosition> {
  const { card, jumpers } = normalizeSerialCard(config)
  const wiring = SERIAL_CARDS[card].wiring
  const source = (pin: SerialPin): JumperPosition => {
    const wired = wiring[pin]
    return wired === 'jumper' ? jumpers[pin as JumperPin]! : wired
  }
  return { cts: source('cts'), dcd: source('dcd'), dsr: source('dsr') }
}
