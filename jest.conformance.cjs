// The third-party CPU conformance suites, kept out of the default `npm test`.
//
// Two reasons they are separate: they need about a gigabyte of downloaded test
// data that is not in the repository, and they take minutes rather than seconds.
// Run them with `npm run test:conformance`, which fetches what it needs first.
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/tests/conformance/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
  // Coverage instrumentation on a few million emulated instructions costs far
  // more than it tells us; the default config already reports core coverage.
  collectCoverage: false,
  // Klaus's functional test runs tens of millions of cycles in one go.
  testTimeout: 600_000,
  moduleNameMapper: {
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@debug/(.*)$': '<rootDir>/src/debug/$1',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1'
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.core.json' }]
  }
}
