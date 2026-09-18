import { readSavedSerialCard, saveSerialCard } from '../../renderer/src/composables/useSerialCardSetting'

/**
 * The web build's saved serial card. Nothing saved means the default card,
 * which App.vue leaves in place; what is saved is read as `settings.json`'s
 * is, so a card this app does not offer, or a jumper the card lacks, never
 * reaches the machine.
 */
describe('the web build\'s serial card setting', () => {
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

  it('is nothing when nothing is saved', () => {
    expect(readSavedSerialCard()).toBeNull()
  })

  it('keeps a saved card and its jumpers', () => {
    saveSerialCard({ card: 'standard', jumpers: { cts: 'cable' } })
    expect(readSavedSerialCard()).toEqual({ card: 'standard', jumpers: { cts: 'cable' } })
  })

  it('reads what it saved defensively', () => {
    store.set('6502-emulator-serial-card', JSON.stringify({ card: 'pro', jumpers: { cts: 'cable' } }))
    expect(readSavedSerialCard()).toEqual({ card: 'pro', jumpers: { dcd: 'ground' } })
    store.set('6502-emulator-serial-card', '{not json')
    expect(readSavedSerialCard()).toBeNull()
    store.set('6502-emulator-serial-card', JSON.stringify({ card: 'kim' }))
    expect(readSavedSerialCard()).toBeNull()
  })

  it('is nothing when storage cannot be read', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      get: () => {
        throw new Error('private mode')
      },
      configurable: true
    })
    expect(readSavedSerialCard()).toBeNull()
    expect(() => saveSerialCard({ card: 'ace', jumpers: {} })).not.toThrow()
  })
})
