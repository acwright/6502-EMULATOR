import { EventEmitter } from 'node:events'
import { exitQuietlyOnClosedPipe } from '../../cli/pipe'

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code })
}

describe('exitQuietlyOnClosedPipe', () => {
  it('exits 0 when the reader has gone (`6502 run | head`)', () => {
    const stream = new EventEmitter()
    const exit = jest.fn()
    exitQuietlyOnClosedPipe(stream, exit)

    stream.emit('error', errno('EPIPE'))

    expect(exit).toHaveBeenCalledWith(0)
  })

  it('still throws any other stream error', () => {
    const stream = new EventEmitter()
    const exit = jest.fn()
    exitQuietlyOnClosedPipe(stream, exit)

    expect(() => stream.emit('error', errno('EIO'))).toThrow('write EIO')
    expect(exit).not.toHaveBeenCalled()
  })
})
