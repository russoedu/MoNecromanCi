import { noNondeterministicOrchestrator } from './rules/noNondeterministicOrchestrator.js'
import { noUntypedActivityHandler } from './rules/noUntypedActivityHandler.js'
import { requireYieldStar } from './rules/requireYieldStar.js'
import type { Rule } from './rules/shared.js'

export type { Rule } from './rules/shared.js'

/**
 * Every rule this plugin ships, by name.
 *
 * @remarks
 * The keys are the names a config writes after the `az-durable/` prefix, so
 * renaming one is a breaking change for any consumer's config.
 */
export const rules: Record<string, Rule> = {
  'no-nondeterministic-orchestrator': noNondeterministicOrchestrator,
  'no-untyped-activity-handler': noUntypedActivityHandler,
  'require-yield-star': requireYieldStar
}

/**
 * The plugin object, for a flat config's `plugins` map.
 *
 * @remarks
 * Shipped from a separate entry point so lint rules are never a runtime import
 * of the wrapper itself.
 */
export const plugin = { rules }

/**
 * The recommended rule set.
 *
 * @remarks
 * Two errors and one warning, and the split is deliberate.
 * `no-nondeterministic-orchestrator` and `no-untyped-activity-handler` catch
 * failures nothing else does — silent replay corruption, and a type collapse
 * TypeScript accepts as legal. `require-yield-star` is a warning because the
 * compiler already rejects the code it flags; it only improves the message.
 */
export const recommended = {
  plugins: { 'az-durable': plugin },
  rules: {
    'az-durable/no-nondeterministic-orchestrator': 'error',
    'az-durable/no-untyped-activity-handler': 'error',
    'az-durable/require-yield-star': 'warn'
  }
} as const

export { noNondeterministicOrchestrator } from './rules/noNondeterministicOrchestrator.js'
export { requireYieldStar } from './rules/requireYieldStar.js'
export { noUntypedActivityHandler } from './rules/noUntypedActivityHandler.js'
