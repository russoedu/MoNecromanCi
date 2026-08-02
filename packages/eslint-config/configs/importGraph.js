import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import importX from 'eslint-plugin-import-x'

/**
 * Import-graph correctness: an import that resolves to nothing, and a cycle.
 *
 * @remarks
 * Specifically the **intra-project** gap. `@nx/dependency-checks` and
 * `@nx/enforce-module-boundaries` already police edges *between* projects —
 * illegal dependencies, and cycles in the project graph — but neither looks
 * inside a project, so a cycle among a project's own modules, or a relative
 * import pointing at a file that no longer exists, was reported by nothing.
 *
 * Two rules, both unambiguous and both **intra-project**:
 *
 * - `no-cycle` — module A imports B imports A. Legal JavaScript, and it runs
 *   until it doesn't: whichever module is evaluated second sees a partially
 *   initialised namespace, so the failure is a mysterious `undefined` at import
 *   time, sensitive to evaluation order.
 * - `no-self-import` — a file importing itself. Always a mistake, always a
 *   guaranteed cycle.
 *
 * **The resolver is the whole difficulty here, and the reason a naive setup would
 * be worse than nothing.** With `import-x`'s default Node resolver this reported
 * **179** errors on the mnci monorepo, every one of them false: Node's algorithm
 * cannot resolve an extensionless relative TypeScript import (`./pythonProject`
 * → `pythonProject.ts`), which is how essentially all TypeScript is written. A
 * rule that fires on correct code teaches people to switch it off, so the
 * TypeScript resolver is not a refinement — it is the difference between this
 * block working and being harmful.
 *
 * `createTypeScriptImportResolver` is deliberately given **no `project` option**.
 * It then discovers each file's nearest tsconfig itself, which is what a scaffold
 * needs: a generated workspace's tsconfigs cannot be enumerated up front, since
 * `mnci add` keeps adding them. Same reasoning as `projectService: true` in
 * `configs/typeAware.js`, and verified the same way — with the glob removed, the
 * monorepo still reports zero.
 *
 * **`no-unresolved` had to be dropped, and the reason is structural rather than a
 * matter of configuration.** In an mnci workspace a project consumes an internal
 * lib by its scoped name (`@scope/core`), which npm workspaces symlinks into
 * `node_modules` — but that package's manifest points at `./dist/index.js`, and
 * `dist/` does not exist until the dependency is **built**. `lint` does not depend
 * on `build`, so at lint time a completely correct cross-project import resolves to
 * nothing on disk. There are no tsconfig `paths` to fall back on either: the `ts`
 * preset resolves cross-project imports through project references, which a
 * filesystem resolver cannot follow.
 *
 * Verified on a real generated workspace: a publishable lib re-exporting
 * `@scope/core` reported `Unable to resolve path to module '@scope/core'` — a
 * false positive on the internal-lib feature that is central to the whole scaffold.
 * The rule is therefore off, not merely unconfigured, so nobody re-enables it in
 * good faith. Little is lost: `tsc` already reports an unresolved *typed* import,
 * and the workspace runs `typecheck` in CI. The narrow gap left is a
 * side-effect-only import (`import './register-hooks'`) whose file has moved.
 *
 * Scoped to project source for the same reason the type-aware rules are: outside
 * `apps/`, `libs/` and `packages/` there may be no tsconfig for the resolver to
 * use, and a resolver that cannot resolve reports every import as unresolved.
 * Unlike the type-aware parser this fails as ordinary rule violations rather than
 * a fatal error, but a wall of false positives is not much better.
 */
export default [
  {
    name: 'mnci/import-graph',
    files: [
      'apps/*/src/**/*.{ts,mts,cts,tsx}',
      'libs/*/src/**/*.{ts,mts,cts,tsx}',
      'packages/*/src/**/*.{ts,mts,cts,tsx}'
    ],
    plugins: { 'import-x': importX },
    settings: {
      // `resolver-next` is the flat-config form; the legacy `import-x/resolver`
      // string form is deprecated and resolves plugins by name at runtime.
      'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],

      // Load-bearing, and the failure without it is invisible: `no-cycle` has to
      // walk INTO each dependency to see what that file imports, which means
      // parsing it. `languageOptions.parser` only tells ESLint how to parse the
      // file being linted, not how import-x should parse the files it follows, so
      // without this mapping every `.ts` dependency is unparseable and the
      // traversal stops at depth one. `no-cycle` then reports nothing — not an
      // error, not a warning, ever. Verified: with the mapping a two-module cycle
      // is reported on both files; without it, both are clean.
      //
      // `no-unresolved` does NOT need this (it only resolves paths, never parses),
      // which is exactly why the gap is easy to miss — one rule works, the other
      // is silently inert.
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.mts', '.cts', '.tsx'] }
    },
    rules: {
      // `no-unresolved` is deliberately OFF, and cannot be turned on in this
      // layout — see this module's remarks. It is not a tuning choice.
      'import-x/no-unresolved': 'off',
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error'
    }
  }
]
