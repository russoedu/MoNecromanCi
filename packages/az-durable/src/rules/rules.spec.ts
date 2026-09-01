import { RuleTester } from 'eslint'
import * as tsParser from '@typescript-eslint/parser'
import { noNondeterministicOrchestrator } from './noNondeterministicOrchestrator.js'
import { noUntypedActivityHandler } from './noUntypedActivityHandler.js'
import { requireYieldStar } from './requireYieldStar.js'
import type { Rule } from './shared.js'

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module'
  }
})

/** ESLint's RuleTester types are looser than this package's local Rule shape. */
const asRule = (rule: Rule): never => rule as unknown as never

tester.run('no-nondeterministic-orchestrator', asRule(noNondeterministicOrchestrator), {
  valid: [
    // The whole point of the negative fixtures: these constructs are FINE
    // outside an orchestration, so a rule that flagged them everywhere
    // would be unusable.
    { code: 'const t = Date.now()' },
    { code: 'defineActivity("a", () => { return Date.now() })' },
    { code: 'const d = new Date(someInstant)' },
    // One fixture per handler the rule installs, so every `depth === 0` guard
    // is covered. Mutation testing found the NewExpression one inert: without
    // an argument-less `new Date()` OUTSIDE an orchestration, deleting that
    // guard changed nothing the suite could see.
    { code: 'const d = new Date()' },
    { code: 'const k = process.env.KEY' },
    { code: 'defineActivity("a", () => { return process.env.KEY })' },
    // `new Date(x)` with an argument does not read the clock.
    { code: 'defineOrchestration("o", function* (c) { const d = new Date(input.when) })' },
    { code: 'defineOrchestration("o", function* (c) { const d = now(c) })' }
  ],
  invalid: [
    {
      code: 'defineOrchestration("o", function* (c) { const d = new Date() })',
      errors: [{ messageId: 'newDate' }]
    },
    {
      code: 'defineOrchestration("o", function* (c) { const t = Date.now() })',
      errors: [{ messageId: 'forbidden' }]
    },
    {
      code: 'defineOrchestration("o", function* (c) { const r = Math.random() })',
      errors: [{ messageId: 'forbidden' }]
    },
    {
      code: 'defineOrchestration("o", function* (c) { const k = process.env.KEY })',
      errors: [{ messageId: 'processEnv' }]
    },
    {
      code: 'defineOrchestration("o", function* (c) { const r = fetch(url) })',
      errors: [{ messageId: 'forbidden' }]
    },
    {
      // The raw SDK registration path must be covered too.
      code: 'df.app.orchestration("o", function* (c) { const d = new Date() })',
      errors: [{ messageId: 'newDate' }]
    }
  ]
}
)

tester.run('require-yield-star', asRule(requireYieldStar), {
  valid: [
    { code: 'function* o(c) { const r = yield* callActivity(c, a, 1) }' },
    // A bare yield of a real Task is correct — this rule must not flag it.
    { code: 'function* o(c) { const r = yield c.df.callActivity("a", 1) }' },
    { code: 'function* o(c) { const r = yield someTask }' }
  ],
  invalid: [
    {
      code: 'function* o(c) { const r = yield callActivity(c, a, 1) }',
      errors: [{ messageId: 'useYieldStar' }]
    },
    {
      code: 'function* o(c) { const r = yield all(c, [t]) }',
      errors: [{ messageId: 'useYieldStar' }]
    }
  ]
}
)

tester.run('no-untyped-activity-handler', asRule(noUntypedActivityHandler), {
  valid: [
    // Inference left alone — the supported way to write a handler.
    { code: 'const h = (input: { id: string }) => ({ n: input.id.length })' },
    { code: 'const wrap = <I, O>(h: (i: I) => O) => h' },
    { code: 'const x: SomethingElse = y' }
  ],
  invalid: [
    {
      code: 'const h: ActivityHandler = (i, c) => i',
      errors: [{ messageId: 'erased' }]
    },
    {
      code: 'const h: FunctionHandler = (i, c) => i',
      errors: [{ messageId: 'erased' }]
    },
    {
      code: 'const h: OrchestrationHandler = function* (c) {}',
      errors: [{ messageId: 'erased' }]
    }
  ]
}
)
