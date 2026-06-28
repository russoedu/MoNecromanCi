/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset:              'ts-jest',
  testEnvironment:     'node',
  roots:               ['<rootDir>/src'],
  testMatch:           ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
  coverageThreshold:   {
    global: { statements: 85, branches: 85, functions: 85, lines: 85 },
  },
  clearMocks: true,
}
