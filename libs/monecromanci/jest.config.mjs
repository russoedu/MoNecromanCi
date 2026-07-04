/**
 * Standalone ts-jest config (deliberately not the shared preset factory: the
 * preset's fake-timers setup would break tests that flush real setImmediate).
 */
export default {
  displayName:         'monecromanci',
  testEnvironment:     'node',
  rootDir:             '.',
  roots:               ['<rootDir>/src'],
  testMatch:           ['**/*.test.ts'],
  transform:           { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.jest.json' }] },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
  coverageThreshold:   {
    global: { statements: 85, branches: 85, functions: 85, lines: 85 },
  },
  clearMocks: true,
}
