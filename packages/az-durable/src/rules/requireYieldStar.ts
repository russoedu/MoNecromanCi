import type { Node, Rule } from './shared.js'

/** The wrapper calls that must be delegated to, not yielded. */
const DELEGATED = new Set([
  'callActivity',
  'callSubOrchestration',
  'all',
  'any',
  'waitForEvent',
  'sleepFor',
  'sleepUntil'
])

/**
 * Flags `yield callActivity(...)` where `yield *` is meant.
 *
 * @remarks
 * **A convenience, not a safety net — and the build plan was wrong about this.**
 * The plan described bare `yield` as compiling silently to `any`, "the
 * difference between the package working and appearing to work". Measured
 * against the real typings, it is a COMPILE ERROR in both registration paths:
 * `TS2345` through `defineOrchestration` and `TS2322` through the SDK's own
 * `OrchestrationHandler`, because these helpers return a `Generator` and
 * yielding one where a `Task` is expected does not typecheck.
 *
 * The genuinely silent case is the RAW SDK — `yield context.df.callActivity(...)`
 * returns `any` and compiles — which is the baseline this package replaces.
 *
 * So this rule earns its place only by reporting a clearer message than
 * `TS2345` does. It is in `recommended` for that reason, not because anything
 * depends on it.
 */
export const requireYieldStar: Rule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require `yield *` when calling a delegating helper.' },
    schema: [],
    messages: {
      useYieldStar:
        "Use 'yield *' rather than 'yield' with {{name}}(). Delegation is what carries the " +
        'result type; a bare yield does not typecheck, but the compiler error is obscure.'
    }
  },
  create (context) {
    return {
      YieldExpression: (node: Node) => {
        if (node.delegate === true) {
          return
        }
        const argument = node.argument as Node | undefined
        if (argument?.type !== 'CallExpression') {
          return
        }
        // A BARE IDENTIFIER only. `c.df.callActivity(...)` is the raw SDK call,
        // which is correct code and must not be flagged — matching the trailing
        // property of a member expression would flag it, which a negative
        // fixture caught.
        const callee = argument.callee as Node | undefined
        if (callee?.type !== 'Identifier') {
          return
        }
        const name = callee.name as string
        if (DELEGATED.has(name)) {
          context.report({ node, messageId: 'useYieldStar', data: { name } })
        }
      }
    }
  }
}
