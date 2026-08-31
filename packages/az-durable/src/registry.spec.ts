import { claimName, resetRegistryForTests } from './registry'

describe('duplicate name detection', () => {
  beforeEach(() => {
    resetRegistryForTests()
  })

  it('allows a name once', () => {
    expect(() => {
      claimName('activity', 'createArticle')
    }).not.toThrow()
  })

  it('throws on a duplicate, naming both call sites', () => {
    // Names are global to the Function App and baked into orchestration
    // history, so a duplicate silently misbinds. Failing at startup is the
    // whole point — and the message has to say WHERE, or the reader is left
    // grepping a Function App for the other registration.
    claimName('activity', 'createArticle')
    let thrown: Error | undefined
    try {
      claimName('activity', 'createArticle')
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown?.message).toContain("Duplicate activity name 'createArticle'")
    expect(thrown?.message).toContain('first registered at:')
    expect(thrown?.message).toContain('registered again at:')
  })

  it('separates activities from orchestrations only by message, not by namespace', () => {
    // Deliberate: the Function App has ONE name space. An activity and an
    // orchestration sharing a name is the same misbinding, so it must throw.
    claimName('activity', 'shared')
    expect(() => {
      claimName('orchestration', 'shared')
    }).toThrow(/Duplicate orchestration name 'shared'/)
  })
})
