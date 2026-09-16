// `Video.test.ts`, unchanged, against 6502-PICOVDP's C core instead of `Video.ts`.
//
// The firmware project builds this card in portable C, and rather than port the
// video tests by hand it runs these ones against its core, through an N-API
// adapter that presents `Video`'s public surface (6502-PICOVDP/PLAN.md section 4).
// This config swaps the module and nothing else: same test file, same helpers,
// same assertions. A test that passes here and against `Video.ts` is a behaviour
// the two implementations share.
//
//   PICOVDP_ADDON=/path/to/6502-PICOVDP/host/node/Video.cjs npm run test:picovdp
//
// PICOVDP_ADDON names the adapter module, which finds its own compiled core; see
// 6502-PICOVDP's README. There is no default, because running `Video.ts` under
// this name by accident would be a green run that proves nothing.
//
// No test is skipped. A test that could only be passed by reaching into the
// TypeScript class rather than through its public surface would be listed here,
// by name, with the reason — never skipped silently.
const { existsSync } = require('node:fs')
const { resolve } = require('node:path')
const base = require('./jest.config.cjs')

const adapter = process.env.PICOVDP_ADDON
if (!adapter) {
  throw new Error('jest.picovdp.cjs: set PICOVDP_ADDON to the 6502-PICOVDP adapter module (host/node/Video.cjs)')
}
if (!existsSync(adapter)) {
  throw new Error(`jest.picovdp.cjs: PICOVDP_ADDON is ${adapter}, and there is nothing there`)
}

module.exports = {
  ...base,
  testMatch: ['<rootDir>/src/tests/IO/Video.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  // Coverage of `src/` says nothing about C.
  collectCoverage: false,
  moduleFileExtensions: [...base.moduleFileExtensions, 'cjs', 'node'],
  moduleNameMapper: {
    // First, so it wins over `@core/`: the test's `../../core/IO/Video`.
    '(^|/)core/IO/Video$': resolve(adapter),
    ...base.moduleNameMapper
  }
}
