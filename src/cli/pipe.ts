/**
 * End quietly when whoever reads our output stops reading.
 *
 * `6502 run --headless | head` closes the pipe after ten lines while the
 * machine is still printing. Node reports the next write as an `EPIPE` error
 * event on the stream, and with no listener that is an uncaught exception: a
 * stack trace and exit 1 for a pipeline that did exactly what was asked. A
 * shell tool that has lost its reader has nothing left to do, so it exits, as
 * `cat` does. Any other stream error is still thrown.
 */
export function exitQuietlyOnClosedPipe(
  stream: NodeJS.EventEmitter,
  exit: (code: number) => void = (code) => process.exit(code)
): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      exit(0)
      return
    }
    throw error
  })
}
