import { calleeName, isOrchestrationRegistration, type Node, type Rule } from './shared.js'

/** Global reads that differ on every replay, with the replacement to suggest. */
const FORBIDDEN_CALLS: Record<string, string> = {
  'Date.now': 'now(context).getTime()',
  'Math.random': 'context.df.newGuid(...) or an activity',
  'crypto.randomUUID': 'context.df.newGuid(...)',
  fetch: 'an activity — network calls must not run in an orchestrator',
  axios: 'an activity — network calls must not run in an orchestrator'
}

/**
 * Flags non-deterministic operations inside an orchestration body.
 *
 * @remarks
 * The highest-value rule in the package. Each of these returns a DIFFERENT
 * value on every replay, and the failure is silent: the orchestration still
 * completes, it just produces output that disagrees with its own history.
 * Nothing in the runtime reports it.
 *
 * Every message names the replacement, because "this is non-deterministic" is
 * only half of what a reader needs.
 *
 * Heuristic by design — see {@link isOrchestrationRegistration}.
 */
export const noNondeterministicOrchestrator: Rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow non-deterministic operations inside an orchestration.' },
    schema: [],
    messages: {
      forbidden: '{{what}} is non-deterministic on replay. Use {{fix}} instead.',
      newDate: 'new Date() is non-deterministic on replay. Use now(context) instead.',
      processEnv:
        'process.env is read at replay time and may differ between deploys. ' +
        'Read it in an activity, or pass it as orchestration input.'
    }
  },
  create (context) {
    let depth = 0
    const enter = (node: Node): void => {
      if (isOrchestrationRegistration(node)) {
        depth += 1
      }
    }
    const exit = (node: Node): void => {
      if (isOrchestrationRegistration(node)) {
        depth -= 1
      }
    }
    return {
      CallExpression: (node: Node) => {
        enter(node)
        if (depth === 0) {
          return
        }
        const callee = node.callee as Node | undefined
        const object = callee?.object as Node | undefined
        const full =
          object?.type === 'Identifier'
            ? `${String(object.name)}.${String(calleeName(callee))}`
            : (calleeName(callee) ?? '')
        const fix = FORBIDDEN_CALLS[full]
        if (fix !== undefined) {
          context.report({ node, messageId: 'forbidden', data: { what: full, fix } })
        }
      },
      'CallExpression:exit': exit,
      NewExpression: (node: Node) => {
        if (depth === 0) {
          return
        }
        const callee = node.callee as Node | undefined
        const args = node.arguments as unknown[] | undefined
        // `new Date(someInstant)` is fine and common — only the argument-less
        // form reads the wall clock.
        if (callee?.type === 'Identifier' && callee.name === 'Date' && (args?.length ?? 0) === 0) {
          context.report({ node, messageId: 'newDate' })
        }
      },
      MemberExpression: (node: Node) => {
        if (depth === 0) {
          return
        }
        const object = node.object as Node | undefined
        const property = node.property as Node | undefined
        if (
          object?.type === 'Identifier' &&
          object.name === 'process' &&
          property?.type === 'Identifier' &&
          property.name === 'env'
        ) {
          context.report({ node, messageId: 'processEnv' })
        }
      }
    }
  }
}
