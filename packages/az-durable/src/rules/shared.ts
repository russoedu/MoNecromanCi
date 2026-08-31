/**
 * Minimal ESLint rule shapes, declared locally.
 *
 * @remarks
 * Declared here rather than imported from `@types/eslint` or
 * `@typescript-eslint/utils` because this package ships **zero runtime
 * dependencies**, and a type-only dependency is still a dependency a consumer
 * must be able to resolve. These cover exactly what the three rules use.
 */

/**
 * An ESTree-ish node, narrowed only where a rule actually reads it.
 *
 * @remarks
 * The index signature is what keeps this honest: a rule reads whatever
 * property it needs and casts at the read site, rather than this file growing
 * a partial mirror of ESTree that would drift against the real one.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface Node {
  type: string
  [key: string]: unknown
}

/**
 * The subset of ESLint's rule context these rules touch.
 *
 * @remarks
 * Only `report` is declared, because only `report` is used. Widening this to
 * the real context type would pull in a dependency for no gain.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface RuleContext {
  report: (descriptor: { node: Node; messageId: string; data?: Record<string, string> }) => void
}

/**
 * An ESLint rule module, as the plugin exports it.
 *
 * @remarks
 * `schema: []` is deliberate rather than omitted - every rule here is
 * option-free, and an empty schema makes ESLint reject an options object
 * instead of silently ignoring it.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface Rule {
  meta: {
    type: 'problem' | 'suggestion'
    docs: { description: string }
    schema: []
    messages: Record<string, string>
  }
  create: (context: RuleContext) => Record<string, (node: Node) => void>
}

/**
 * Whether a call expression registers an orchestration.
 *
 * @remarks
 * Matches both `defineOrchestration(...)` and the raw
 * `df.app.orchestration(...)`, since an orchestration written either way has
 * the same determinism constraints.
 *
 * **Heuristic, by construction.** These rules match on call-site SHAPE, so an
 * orchestration body extracted into a helper function is not caught. That is a
 * documented limit rather than a defect: following the value would require type
 * information the rule deliberately does not depend on.
 *
 * @param node - A `CallExpression` node.
 * @returns `true` when the call registers an orchestration.
 * @throws Never - pure inspection.
 * @typeParam None - this function has no generic type parameters.
 */
export function isOrchestrationRegistration (node: Node): boolean {
  const callee = node.callee as Node | undefined
  if (callee === undefined) {
    return false
  }
  if (callee.type === 'Identifier' && callee.name === 'defineOrchestration') {
    return true
  }
  // df.app.orchestration(...) — match on the trailing property, so any local
  // alias for the namespace still matches.
  if (callee.type === 'MemberExpression') {
    const property = callee.property as Node | undefined
    return property?.type === 'Identifier' && property.name === 'orchestration'
  }
  return false
}

/**
 * The name a callee refers to, if it is a plain identifier or member access.
 *
 * @remarks
 * For a member expression this returns the TRAILING property, so `df.now()`
 * and `context.df.now()` both read as `now`. Callers that must distinguish a
 * bare call from a member call check `node.type` themselves - `require-yield-star`
 * does exactly that, because `yield c.df.callActivity(...)` is the correct raw
 * SDK call and must not be flagged.
 *
 * @param node - A callee node.
 * @returns The identifier or property name, or `undefined`.
 * @throws Never - pure inspection.
 * @typeParam None - this function has no generic type parameters.
 */
export function calleeName (node: Node | undefined): string | undefined {
  if (node === undefined) {
    return undefined
  }
  if (node.type === 'Identifier') {
    return node.name as string
  }
  if (node.type === 'MemberExpression') {
    const property = node.property as Node | undefined
    if (property?.type === 'Identifier') {
      return property.name as string
    }
  }
  return undefined
}
