import type { BrowserWindow } from 'electron'
import { RpcMethodError } from '../../debug/server/Protocol'
import { DebugBridgeService } from '../../main/debugBridge'

// jest.mock calls are hoisted above imports by ts-jest, so DebugBridgeService
// above already sees this mock — real Electron is unavailable outside an
// actual Electron process.
jest.mock('electron', () => ({ app: { getVersion: () => '9.9.9', isPackaged: true } }))

/**
 * A fake `BrowserWindow` covering only what DebugBridgeService touches:
 * `webContents.send` and `isDestroyed()`. Real Electron is unavailable
 * outside an actual Electron process, and the request/reply correlation
 * logic under test here — the part with genuine room for a subtle bug — does
 * not depend on anything else about the window.
 */
function fakeWindow(): {
  window: BrowserWindow
  sent: { channel: string; payload: unknown }[]
  destroy: () => void
} {
  const sent: { channel: string; payload: unknown }[] = []
  let destroyed = false
  const window = {
    isDestroyed: () => destroyed,
    webContents: {
      send: (channel: string, payload: unknown) => sent.push({ channel, payload })
    }
  } as unknown as BrowserWindow
  return { window, sent, destroy: () => (destroyed = true) }
}

describe('DebugBridgeService', () => {
  it('starts and stops a real server, reporting its own status', async () => {
    const service = new DebugBridgeService()
    expect(service.status()).toEqual({ running: false })

    const status = await service.start({ port: 0, host: '127.0.0.1' })
    expect(status.running).toBe(true)
    expect(status.port).toBeGreaterThan(0)
    expect(service.status()).toEqual(status)

    await service.stop()
    expect(service.status()).toEqual({ running: false })
  })

  it('starting twice is a no-op that returns the existing status', async () => {
    const service = new DebugBridgeService()
    const first = await service.start({ port: 0 })
    const second = await service.start({ port: 0 })
    expect(second).toEqual(first)
    await service.stop()
  })

  describe('the renderer call/reply bridge', () => {
    it('sends a DEBUG_CALL_REQUEST and resolves on a matching reply', async () => {
      const service = new DebugBridgeService()
      const { window, sent } = fakeWindow()
      service.setWindow(window)

      // callRenderer is private; dispatch is how the DebugServer would reach
      // it, and is itself accessible only via start() — so exercise it the
      // same way a real RPC call would, without needing a live socket.
      const status = await service.start({ port: 0 })
      const call = fetch(`http://127.0.0.1:${status.port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'reg.get' })
      })

      // Wait for the request to actually reach the "renderer".
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(sent).toHaveLength(1)
      expect(sent[0]!.channel).toBe('debug:callRequest')
      const request = sent[0]!.payload as { id: number; method: string; params: unknown }
      expect(request.method).toBe('reg.get')

      service.handleReply({ id: request.id, result: { A: 0x42 } })

      const reply = await call
      const body = (await reply.json()) as { result: { A: number } }
      expect(body.result).toEqual({ A: 0x42 })

      await service.stop()
    })

    it('turns an error reply into an RpcMethodError with the same code', async () => {
      const service = new DebugBridgeService()
      const { window, sent } = fakeWindow()
      service.setWindow(window)
      await service.start({ port: 0 })

      const pending = (
        service as unknown as { callRenderer: (m: string, p: unknown) => Promise<unknown> }
      ).callRenderer('bp.set', {})

      await new Promise((resolve) => setTimeout(resolve, 10))
      const request = sent[0]!.payload as { id: number }
      service.handleReply({ id: request.id, error: { code: -32602, message: 'address is required' } })

      await expect(pending).rejects.toThrow(RpcMethodError)
      await expect(pending).rejects.toMatchObject({ code: -32602, message: 'address is required' })

      await service.stop()
    })

    it('ignores a reply for an id nothing is waiting on', () => {
      const service = new DebugBridgeService()
      // A late reply — e.g. the call already timed out — must not throw.
      expect(() => service.handleReply({ id: 999, result: {} })).not.toThrow()
    })

    it('rejects immediately when there is no window to call', async () => {
      const service = new DebugBridgeService()
      await service.start({ port: 0 })

      const pending = (
        service as unknown as { callRenderer: (m: string, p: unknown) => Promise<unknown> }
      ).callRenderer('reg.get', {})

      await expect(pending).rejects.toThrow(/window/)
      await service.stop()
    })

    it('rejects every pending call when the server stops', async () => {
      const service = new DebugBridgeService()
      const { window } = fakeWindow()
      service.setWindow(window)
      await service.start({ port: 0 })

      const pending = (
        service as unknown as { callRenderer: (m: string, p: unknown) => Promise<unknown> }
      ).callRenderer('reg.get', {})

      await service.stop()
      await expect(pending).rejects.toThrow(/stopped/)
    })
  })
})
