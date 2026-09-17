import { readSavedFlowControl, saveFlowControl } from '../../renderer/src/composables/useFlowControlSetting'

/**
 * The web build's saved flow-control choice. Flow control is on by default, and
 * this key was only ever written when someone ticked or unticked the box, so a
 * saved `off` is kept and nothing else turns it off.
 */
describe('the web build\'s flow-control setting', () => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  }

  beforeEach(() => {
    store.clear()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  })

  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('is on when nothing is saved', () => {
    expect(readSavedFlowControl()).toBe(true)
  })

  it('keeps a saved choice either way', () => {
    saveFlowControl(false)
    expect(readSavedFlowControl()).toBe(false)
    saveFlowControl(true)
    expect(readSavedFlowControl()).toBe(true)
  })

  it('is on when storage cannot be read', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      get: () => {
        throw new Error('private mode')
      },
      configurable: true
    })
    expect(readSavedFlowControl()).toBe(true)
    expect(() => saveFlowControl(false)).not.toThrow()
  })
})
