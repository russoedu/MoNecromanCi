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
 *
 * Maps NodeNext-style `.js` specifiers back onto the `.ts` files they name.
 *
 * @remarks
 * The source writes `from './activity.js'` because that is what tsc must EMIT into
 * the declarations: under moduleResolution nodenext an extensionless relative
 * specifier is TS2834, and consumers who set skipLibCheck (almost everyone) get
 * every export as `any` instead of an error. tsc resolves `./activity.js` to
 * `activity.ts` itself; Jest does not, so it needs telling.
 */
export default {
  ...base,
  roots: [...base.roots, '<rootDir>/test'],
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
}
