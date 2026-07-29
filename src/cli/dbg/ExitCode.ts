/**
 * Exit codes `6502 dbg` and `6502 attach` use to report what happened.
 *
 * An agent scripting the CLI branches on these instead of scraping text, which
 * is the whole reason they are specified rather than left to fall out of
 * whatever Node felt like doing.
 */
export const ExitCode = {
  OK: 0,
  ERROR: 1,
  TIMEOUT: 2,
  /** No emulator could be reached — no lock file, or the socket refused. */
  NOT_RUNNING: 3,
  /** A breakpoint, watchpoint or wait condition matched. */
  HIT: 4
} as const

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]
