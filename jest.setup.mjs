process.env.TZ = 'UTC'

beforeAll(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2000-01-01T00:00:00.000Z'))
})

afterAll(() => {
  jest.useRealTimers()
})
