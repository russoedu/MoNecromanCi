import { createConfig } from '../../jest.preset.mjs'

const base = createConfig('az-durable')

/**
 * Adds `test/` to the roots so the reconstructed workflows in `test/dogfood`
 * are executed, not merely typechecked.
 *
 * @remarks
 * The preset's default is `src` only, which is right for every other project.
 * Here the dogfood workflows deliberately live outside `src` — they are not
 * shipped — but a workflow that only typechecks proves the shapes fit, not that
 * the control flow runs. `test/types/*.test-d.ts` stays untouched by this:
 * `.test-d.ts` does not match Jest's `testMatch`.
 */
export default { ...base, roots: [...base.roots, '<rootDir>/test'] }
