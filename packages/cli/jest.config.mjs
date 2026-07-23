/**
 * Standalone ts-jest config: the shared preset factory's fake-timers setup
 * would break tests that flush real setImmediate.
 */
export default {
  displayName:         'cli',
  testEnvironment:     'node',
  rootDir:             '.',
  roots:               ['<rootDir>/src'],
  testMatch:           ['**/*.test.ts'],
  transform:           { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.jest.json' }] },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
  coverageReporters:   ['text', 'json-summary'],
  coverageThreshold:   {
    global: { statements: 85, branches: 85, functions: 85, lines: 85 },
  },
  clearMocks: true,
}
