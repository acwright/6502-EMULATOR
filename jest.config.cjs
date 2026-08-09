module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
  collectCoverage: true,
  collectCoverageFrom: [
    'src/core/**/*.ts',
    'src/debug/**/*.ts',
    'src/host/**/*.ts',
    // The embed's URL parameter API. Named file by file rather than by
    // directory: it is the only part of src/renderer that has no browser in it,
    // and the rest of that directory would report as uncovered forever.
    'src/renderer/src/embed/params.ts'
  ],
  moduleNameMapper: {
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@debug/(.*)$': '<rootDir>/src/debug/$1',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@/(.*)$': '<rootDir>/src/renderer/src/$1'
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.core.json' }]
  }
}
