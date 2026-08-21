import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearLock,
  defaultLockPath,
  readLock,
  writeLock
} from '../../../debug/server/LockFile'
import type { SessionLock } from '../../../debug/server/LockFile'

let temp: string
let path: string

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), '6502-lock-'))
  path = join(temp, 'nested', 'session.json')
})

afterEach(() => {
  rmSync(temp, { recursive: true, force: true })
})

const lock = (overrides: Partial<SessionLock> = {}): SessionLock => ({
  pid: process.pid,
  host: '127.0.0.1',
  port: 4321,
  token: 'a-token',
  started: new Date().toISOString(),
  version: '2.2.1',
  host_kind: 'headless',
  ...overrides
})

describe('writing', () => {
  it('creates the directory it needs and round-trips', () => {
    writeLock(path, lock())
    expect(readLock(path)).toMatchObject({ port: 4321, token: 'a-token' })
  })

  // The file holds the token that authorises driving the machine and reading
  // its CF image, so it must not be world-readable.
  it('writes it readable only by its owner', () => {
    writeLock(path, lock())
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('reading', () => {
  it('reports nothing when there is no file', () => {
    expect(readLock(join(temp, 'absent.json'))).toBeUndefined()
  })

  it('reports nothing for a truncated or corrupt file', () => {
    const truncated = join(temp, 'truncated.json')
    writeFileSync(truncated, '{ "port": ')
    expect(readLock(truncated)).toBeUndefined()
  })

  it('reports nothing when the fields it needs are missing', () => {
    const partial = join(temp, 'partial.json')
    writeFileSync(partial, JSON.stringify({ pid: process.pid, host: '127.0.0.1' }))
    expect(readLock(partial)).toBeUndefined()
  })

  /**
   * A lock left by a crashed process is the ordinary case, not an edge one — a
   * Ctrl-C that skipped the cleanup, an OOM kill. Without the liveness check the
   * next `6502 dbg` would sit timing out against a port nobody is listening on.
   */
  it('ignores a lock whose process is gone', () => {
    // A pid that cannot be running: above the maximum any platform allocates.
    writeLock(path, lock({ pid: 0x7ffffffe }))
    expect(readLock(path)).toBeUndefined()
  })
})

describe('clearing', () => {
  it('removes the file', () => {
    writeLock(path, lock())
    clearLock(path)
    expect(existsSync(path)).toBe(false)
  })

  it('does not complain about a file that has already gone', () => {
    expect(() => clearLock(join(temp, 'never-existed.json'))).not.toThrow()
  })
})

describe('the default location', () => {
  it('is session.json under the 6502 home', () => {
    // Explicitly unset, not merely assumed: the suite's setup file points this
    // variable at a temp directory so parallel test files cannot fight over one
    // lock, and an exported SIXTY5O2_HOME in a developer's shell would do the
    // same. Either way the default is only the default when there is no override.
    const previous = process.env.SIXTY5O2_HOME
    delete process.env.SIXTY5O2_HOME
    try {
      expect(defaultLockPath().endsWith(join('.6502', 'session.json'))).toBe(true)
    } finally {
      if (previous !== undefined) process.env.SIXTY5O2_HOME = previous
    }
  })

  // Needed so tests and parallel instances can be kept apart.
  it('honours an overridden home', () => {
    const previous = process.env.SIXTY5O2_HOME
    process.env.SIXTY5O2_HOME = temp
    try {
      expect(defaultLockPath()).toBe(join(temp, 'session.json'))
    } finally {
      if (previous === undefined) delete process.env.SIXTY5O2_HOME
      else process.env.SIXTY5O2_HOME = previous
    }
  })
})
