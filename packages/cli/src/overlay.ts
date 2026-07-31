import { globSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { markExecutable, readCodeWorkspace, readJson, toJson, writeFileEnsured } from './util/fsx'

/**
 * Where a generated monorepo publishes its npm packages.
 *
 * @remarks
 * Supports Azure Artifacts and the public npm registry. GitHub Packages is
 * out of scope for this cut.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type RegistryConfig =
  | { kind: 'azure-artifacts'; organization: string; project: string; artifactsFeed: string }
  | { kind: 'npm' }

/**
 * Which CI provider(s) {@link applyOverlay} writes a pipeline file for.
 *
 * @remarks
 * `azure` (the default) writes only `azure-pipelines.yml`; `github` writes
 * only `.github/workflows/ci.yml`; `both` writes both — so a GitHub-hosted
 * repo can pick the provider it actually runs on instead of carrying an
 * unused Azure Pipelines file.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type CiProvider = 'azure' | 'github' | 'both'

/**
 * The stack chosen at `mnci new` — asked up front, honoured by every `add`.
 *
 * @remarks
 * TypeScript is not a knob: every workspace runs the **dual compiler**
 * ({@link TS_COMPILER_DEPENDENCIES}) — TypeScript 6 for the programmatic API
 * (Nx's graph/plugins, Vite, typescript-eslint, the editor) and TypeScript 7's
 * native `tsc` for the `typecheck`/`build` tasks. The only stack knob is the
 * unit-test runner, persisted as Nx **generator defaults** in `nx.json`.
 * Linting is ESLint + Prettier (always).
 *
 * @typeParam None - this type has no generic type parameters.
 */
export interface StackConfig {
  /** Unit-test runner (both Nx-native for the plugin kinds). */
  testRunner: 'jest' | 'vitest'
}

/**
 * The `--yes` / flagless defaults — the current opinionated stack.
 *
 * @remarks
 * Jest: the test runner existing generated repos (and the e2e suite)
 * already assume, so defaulting to it keeps behaviour unchanged when
 * the stack is not chosen explicitly. Linting is always ESLint + Prettier.
 */
export const DEFAULT_STACK: StackConfig = { testRunner: 'jest' }

/**
 * Prettier version pinned into all workspaces.
 *
 * @remarks
 * Prettier handles code formatting following JavaScript Standard Style
 * in all generated workspaces.
 */
export const PRETTIER_VERSION = '^3.8.1'

/**
 * The dual TypeScript compiler stamped into every workspace's `devDependencies`.
 *
 * @remarks
 * TypeScript 7 is the native (Go) compiler: much faster, but it ships no
 * programmatic API yet, so tools that import `typescript` (Nx's
 * `@nx/js/typescript` plugin and project graph, Vite, typescript-eslint, the
 * editor language service) still need TypeScript 6. The
 * [Nx TS 7 guide](https://nx.dev/docs/technologies/typescript/guides/typescript-7)
 * solves this with two npm aliases: `typescript` resolves to a TS 6 package
 * (API intact, and its binary is `tsc6`, not `tsc`), while `@typescript/native`
 * provides the TS 7 `tsc`. The `@nx/js/typescript` plugin's inferred
 * `typecheck`/`build` tasks then run `tsc` = TS 7, while Nx analyses config
 * through the TS 6 API — automatically, with no target rewiring. Frozen per
 * repo by the committed lockfile, so `npm ci` reproduces it.
 */
export const TS_COMPILER_DEPENDENCIES: Record<string, string> = {
  '@typescript/native': 'npm:typescript@^7.0.2',
  typescript: 'npm:@typescript/typescript6@^6.0.2',
}

/**
 * Returns the npm registry URL for a registry config.
 *
 * @remarks
 * Public npm needs no scoped registry, so it returns `undefined`.
 *
 * @param registry - The monorepo's resolved registry configuration.
 * @returns The registry URL, or `undefined` for the public npm registry.
 * @throws Never - performs a pure mapping with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function registryUrl(registry: RegistryConfig): string | undefined {
  if (registry.kind === 'azure-artifacts') {
    return `https://pkgs.dev.azure.com/${registry.organization}/${registry.project}/_packaging/${registry.artifactsFeed}/npm/registry/`
  }
  return undefined
}

/**
 * Builds the `.npmrc` body for a registry configuration.
 *
 * @remarks
 * **This deliberately emits no configuration — only comments.** Publish
 * authentication is an explicitly deferred design decision, not an oversight,
 * and the file is still written so the deferral is visible in the generated
 * workspace rather than being an absence nobody notices.
 *
 * What it used to emit was wrong in ways worth recording, since the same
 * mistakes are easy to reintroduce:
 *
 * - The public-npm variant carried no `@scope:registry` line at all, while the
 *   CLI's README claimed "scope routing makes accidental public publishes
 *   impossible" — and `overlay.test.ts` actively asserted the line's absence.
 *   The documented safety property never existed.
 * - `legacy-peer-deps=true` was added for `@nxazure/func`, a plugin removed
 *   long ago. It stayed behind and quietly weakened dependency resolution in
 *   every generated workspace.
 *
 * **Known consequence, stated plainly:** the generated CI still exports
 * `NODE_AUTH_TOKEN` (public npm) or `PAT` (Azure Artifacts) for the release
 * step, but with an empty `.npmrc` nothing consumes them — `actions/setup-node`
 * is configured without `registry-url`, so `npm publish` will not
 * authenticate. The token wiring is intentionally left in place so completing
 * this is a one-line change once the auth design is settled. See the "Known
 * gaps" section of `packages/cli/README.md`.
 *
 * @param _registry - The monorepo's resolved registry configuration. Unused
 * while auth is deferred; the parameter is kept because the auth lines return
 * here once designed, and dropping it would churn every call site twice.
 * @param _scope - The npm scope (e.g. `@demo`). Unused, same reason.
 * @returns The full text of the generated `.npmrc`.
 * @throws Never - performs a pure mapping with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function npmrcContent(_registry: RegistryConfig, _scope: string): string {
  return `; Intentionally empty.
;
; Publish authentication is not configured yet. The generated CI exports a
; token for the release step (NODE_AUTH_TOKEN for public npm, PAT for Azure
; Artifacts), but nothing here consumes it, so 'npm publish' will not
; authenticate until this is wired up.
;
; See "Known gaps" in the @mnci/cli README.
`
}

/**
 * Builds the `release` block merged into a generated workspace's `nx.json`.
 *
 * @remarks
 * The tag-only model: versions are computed from conventional commits since
 * each package's last release tag, the bump is
 * **never committed** (`git.commit: false`) — only the tag is created and
 * pushed — so a protected `main` never rejects a release, and future runs
 * resolve versions from tag names, not from a committed `package.json`.
 * `fallbackCurrentVersionResolver: 'disk'` keeps a brand-new package (no tag
 * yet) from hard-erroring.
 *
 * The git options live under a top-level `git` (not `version.git`): the
 * guarded CI release step and the generated `release:preview` script both run
 * the combined `nx release` command (never the bare `nx release version`
 * subcommand), and Nx hard-errors that combined command when git options are
 * granular (`version.git`/`changelog.git`) instead of top-level — the reverse
 * of the bare `version` subcommand's own requirement, which is why the two
 * forms aren't interchangeable (verified empirically).
 *
 * **GitHub Releases (`ci === 'github'` only).** Verified empirically against
 * the pinned Nx version (23.1.0, real `--dry-run` runs, and the installed
 * `release.js` source) that the combined `nx release` command now tags
 * *before* it pushes — an earlier version of this comment described a bug
 * where Nx's internal push fired before the tag existed, silently losing
 * every tag; that ordering bug no longer reproduces on this pinned version.
 * Nx itself also refuses to enable `createRelease` while `git.push: false`
 * (hard error: "createRelease... cannot be enabled when git push is
 * explicitly disabled"), so `push: true` here is required, not optional, once
 * `createRelease` is on. `changelog.projectChangelogs.file: false` sends the
 * generated changelog content straight into the GitHub Release body without
 * writing an unpushable `CHANGELOG.md` (`git.commit` stays `false`, so a
 * written file would just be silently discarded at the end of every CI run).
 * `workspaceChangelog` stays `false` for every provider: projects release
 * independently (see below), so only per-project changelogs/releases make
 * sense — a single workspace-wide changelog would conflate unrelated
 * packages' histories. `GITHUB_TOKEN` (GitHub Actions' own built-in token,
 * already sufficient under the `contents: write` permission the workflow
 * already grants) is exported in {@link githubActionsYaml}'s release step;
 * once it's pushing anyway, {@link githubActionsYaml} drops its separate
 * explicit `git push origin --tags` step as redundant.
 *
 * **Azure-only and `both`** deliberately keep today's `push: false` /
 * no-`createRelease` behaviour. GitHub Releases only make sense when the repo
 * is actually hosted on GitHub, which `ci` alone cannot confirm for `'azure'`
 * (Azure Pipelines can build a GitHub-hosted repo too) or safely guarantee
 * for `'both'` (both pipeline files exist; whichever one actually executes
 * might be the Azure one, which has no `GITHUB_TOKEN` to give Nx) — so this
 * scope is intentionally limited to the one case where a `GITHUB_TOKEN` is
 * guaranteed to exist: GitHub Actions as the *only* configured provider.
 * {@link azurePipelinesYaml} is unchanged and keeps its own explicit
 * `git push origin --tags` step for exactly this reason.
 *
 * Two directories are released: `packages/*` (publishable **npm** libraries)
 * and `python-packages/*` (publishable **Python** packages) — deliberately one
 * flat project list, not two named `release.groups`: Nx hard-errors
 * `nx release` entirely (every group, not just the empty one) when any
 * explicit group matches zero projects — a real failure mode for a workspace
 * that has added Python packages but no npm ones yet, or vice versa (verified
 * empirically). A flat list has no such all-or-nothing requirement: it stays
 * releasable as soon as *either* glob matches something. Each project's own
 * `versionActions` (npm's default, or `@mnci/nx-python-pip`'s
 * `PythonVersionActions` — stamped onto every publishable Python lib's own
 * `project.json` by that plugin's own `library` generator, not by anything
 * here) reads/writes the right manifest (`package.json` vs `pyproject.toml`)
 * — project-level config wins over the group's, so both kinds coexist in the
 * one group correctly. Publishable **Flutter/Dart** packages also live in
 * `packages/*` and are covered by the same flat list;
 * `@mnci/nx-flutter`'s own `library` generator stamps its
 * `DartVersionActions` on for `pubspec.yaml`.
 * Internal libraries live in `libs/` and apps in `apps/`, so release scoping
 * needs no tags for them.
 *
 * `!tag:type:go-lib` is the one exception, and it is a **bug fix**, not
 * fine-tuning. A `go-lib` also lands in `packages/`, but it has no
 * per-project manifest at all — mnci puts every Go project in one root
 * `go.mod` — so Nx falls back to its default `versionActions`, looks for a
 * `packages/<name>/package.json` that does not exist, and aborts. Because
 * that happens while building the release graph, it takes down the release of
 * **every** project in the workspace, not just the Go one: before this
 * exclusion, a single `mnci add go-lib` made `nx release` exit 1 for the
 * whole repo (verified empirically, then re-verified green with the
 * exclusion in place).
 *
 * Excluding rather than teaching Go a `versionActions` is the semantically
 * correct fix: in a single-module layout there is exactly one Go module, so
 * its packages have no independent versions to bump: a consumer running
 * `go get` on one of them resolves against the *module's* tag, so a
 * per-project version would be a fiction. Go's "publishing" is that
 * repo-level tag, which is not a per-project release concern.
 *
 * @param ci - Which CI provider(s) the workspace generates a pipeline for —
 * only `'github'` (GitHub Actions and nothing else) turns on GitHub Release
 * creation; see the remarks above for why `'azure'` and `'both'` do not.
 * @returns The object to merge onto `nx.json`'s `release` key.
 * @throws Never - builds a plain object with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function releaseConfig(ci: CiProvider): Record<string, unknown> {
  const githubReleases = ci === 'github'
  return {
    projectsRelationship: 'independent',
    projects: ['packages/*', 'python-packages/*', '!tag:type:go-lib'],
    releaseTag: { pattern: '{projectName}@{version}' },
    git: { commit: false, tag: true, push: githubReleases },
    version: {
      conventionalCommits: true,
      fallbackCurrentVersionResolver: 'disk',
      // Build only what is being released. Without this, @nx/js:lib's generator
      // defaults the pre-version command to building EVERY project, so a broken
      // (or merely slow) app build would block releasing unrelated packages.
      // Set here at `new` time it wins: the generator only fills this in when
      // absent (it spreads the existing release.version over its default). Both
      // globs are listed; `nx run-many` no-ops cleanly when one matches nothing.
      preVersionCommand: 'npx nx run-many -t build --projects=packages/*,python-packages/*',
    },
    changelog: githubReleases
      ? {
          workspaceChangelog: false,
          projectChangelogs: { createRelease: 'github', file: false },
        }
      : { workspaceChangelog: false },
  } as const
}

/**
 * The `sync` block merged into a generated workspace's `nx.json`.
 *
 * @remarks
 * `--preset=ts` already registers `@nx/js:typescript-sync` on the `build` and
 * `typecheck` targets (via the `@nx/js/typescript` plugin), so Nx already
 * detects a stale TypeScript project reference — e.g. after hand-editing a
 * file to add a new cross-project import — on the next `build`/`typecheck`/
 * `affected` run. Without this block that detection only **prompts**
 * ("Would you like to sync the identified changes?"): easy to miss, and it
 * blocks any non-interactive run. `applyChanges: true` makes Nx fix it
 * silently instead, locally, every time — no more `nx sync` run by hand.
 *
 * This is deliberately safe in CI: per Nx's own docs, a non-interactive run
 * (CI) always runs sync generators in dry-run mode and **fails** instead of
 * applying, regardless of this setting — so a forgotten local sync still
 * surfaces as a clear CI failure ({@link azurePipelinesYaml}'s explicit
 * `nx sync:check` step gives that failure early and unambiguously) rather
 * than silently patching an ephemeral CI checkout that never gets committed.
 */
export const SYNC_CONFIG = { applyChanges: true } as const

/**
 * The `@nx/eslint/plugin` registration merged into a generated workspace's `nx.json`.
 *
 * @remarks
 * This plugin is what gives every project its `lint` target: it maps ESLint
 * config *directories* onto the project roots beneath them, so the single root
 * config mnci writes covers the whole workspace and no project needs one of its
 * own.
 *
 * mnci registers it because mnci owns linting. Nx would otherwise add it as a
 * side effect of the first `nx g … --linter=eslint`, which is both invisible
 * and no longer true: the generators are invoked with `--linter=none` (see
 * `add/shared.ts`), precisely so they stop scaffolding a per-project config —
 * and, more pressingly, stop dragging in `eslint-plugin-import@2.31.0`, whose
 * peer range caps at ESLint 9 and made `mnci add react-app` fail outright on
 * the ESLint 10 toolchain this workspace installs.
 *
 * A consequence worth stating: `npm run lint` now works in a workspace with
 * zero projects, which it previously did only by accident.
 */
export const ESLINT_PLUGIN_CONFIG = {
  plugin: '@nx/eslint/plugin',
  options: { targetName: 'lint' },
} as const

/**
 * The plugin name of an `nx.json` `plugins` entry.
 *
 * @remarks
 * Nx accepts both the bare-string form (`"@nx/eslint/plugin"`) and the object
 * form (`{ plugin, options }`), and a real workspace can hold a mix.
 *
 * @param entry - One element of `nx.json`'s `plugins` array.
 * @returns The plugin name, or `undefined` for an entry in neither form.
 * @throws Never - pure property read.
 * @typeParam None - this function has no generic type parameters.
 */
function pluginName(entry: unknown): string | undefined {
  return typeof entry === 'string' ? entry : (entry as { plugin?: string }).plugin
}

/**
 * Returns a copy of an `nx.json` object with `@nx/eslint/plugin` registered.
 *
 * @remarks
 * Idempotent, so `mnci upgrade` cannot accumulate duplicate entries — and a
 * workspace where Nx already added the plugin (generated before this existed)
 * keeps its own entry, options included, rather than having them overwritten.
 *
 * @param nxJson - The parsed `nx.json`.
 * @returns A new object whose `plugins` array contains the ESLint plugin.
 * @throws Never - performs a pure object merge with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function withEslintPlugin(nxJson: Record<string, unknown>): Record<string, unknown> {
  const plugins = (nxJson.plugins as unknown[] | undefined) ?? []
  const registered = plugins.some(entry => pluginName(entry) === ESLINT_PLUGIN_CONFIG.plugin)
  return registered
    ? { ...nxJson, plugins }
    : { ...nxJson, plugins: [...plugins, ESLINT_PLUGIN_CONFIG] }
}

/**
 * Returns a copy of an `nx.json` object with the release block applied.
 *
 * @remarks
 * Pure read-modify-write on the object the Nx preset generated — this never
 * templates whole config files, it only patches in the one opinion Nx has no
 * default for.
 *
 * @param nxJson - The parsed `nx.json` produced by `create-nx-workspace`.
 * @param ci - Which CI provider(s) the workspace generates a pipeline for —
 * forwarded to {@link releaseConfig} to decide whether GitHub Release
 * creation is turned on.
 * @returns A new object with `release` (and `defaultBase: 'main'`) set.
 * @throws Never - performs a pure object merge with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function withReleaseConfig(
  nxJson: Record<string, unknown>,
  ci: CiProvider
): Record<string, unknown> {
  return { ...nxJson, defaultBase: 'main', release: releaseConfig(ci) }
}

/**
 * The commitlint config written into generated workspaces.
 *
 * @remarks
 * Conventional commits are the release mechanism's input, so they are
 * enforced at commit time — the one piece Nx itself does not provide.
 */
export const COMMITLINT_CONFIG = `export default { extends: ['@commitlint/config-conventional'] }
`

/**
 * The husky `commit-msg` hook body that runs commitlint.
 *
 * @remarks
 * `--no` keeps npx from installing anything at commit time — commitlint is a
 * devDependency installed by `mnci new`.
 */
export const COMMIT_MSG_HOOK = `npx --no -- commitlint --edit "$1"
`

/**
 * The Prettier config written into generated workspaces.
 *
 * @remarks
 * Follows JavaScript Standard Style: no semicolons, single quotes, 2-space
 * indents, and **no trailing commas** — Standard forbids them, so `es5` (the
 * value this used to carry) was wrong.
 *
 * This is written as `.prettierrc.json`, and {@link removeNxScaffolding}
 * deletes the `.prettierrc` that `create-nx-workspace` leaves behind. That
 * deletion is load-bearing, not tidying: `.prettierrc` sits ABOVE
 * `.prettierrc.json` in Prettier's config precedence, so while both existed
 * every option below was silently ignored in every generated workspace and the
 * effective config was Nx's `{ "singleQuote": true }`. Verified with
 * `prettier.resolveConfig` before and after.
 *
 * Prettier owns all formatting. The three JavaScript Standard rules Prettier
 * never touches (`spaced-comment`, `lines-between-class-members`,
 * `unicode-bom`) live in `@mnci/eslint-config`'s stylistic block instead.
 * `space-before-function-paren` is deliberately NOT among them: Prettier
 * actively reverses it, so enabling it would make `lint` and `format:check`
 * mutually unsatisfiable.
 */
export const PRETTIER_CONFIG = `{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "none",
  "arrowParens": "avoid",
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false
}
`

/**
 * The `@mnci/eslint-config` version generated workspaces depend on.
 *
 * @remarks
 * A caret range, so `npm update` carries lint-rule improvements into existing
 * workspaces without an `mnci upgrade` — the reason the config ships as a
 * package rather than as a template string in this file.
 */
export const ESLINT_CONFIG_VERSION = '^0.1.0'

/**
 * The `@mnci/eslint-config` spec to write into a generated workspace's manifest.
 *
 * @remarks
 * Reads `MNCI_ESLINT_CONFIG_SPEC` so the e2e suite can point this at a local
 * tarball (`npm pack`'d from `packages/eslint-config`) instead of the published
 * registry package — without it, `npm install` in a freshly generated workspace
 * 404s until the package has been released at least once. Same escape hatch
 * `add/python.ts` and `add/flutter.ts` already use for their plugins
 * (`MNCI2_PYTHON_PIP_SPEC`, `MNCI_NX_FLUTTER_SPEC`).
 *
 * {@link ESLINT_CONFIG_VERSION} is the default and the only value a real
 * `mnci new` ever writes.
 *
 * @returns The dependency spec (a semver range, or a path/URL when overridden).
 * @throws Never - reads an environment variable.
 * @typeParam None - this function has no generic type parameters.
 */
export function eslintConfigSpec(): string {
  return process.env.MNCI_ESLINT_CONFIG_SPEC ?? ESLINT_CONFIG_VERSION
}

/**
 * The `eslint` version generated workspaces depend on.
 *
 * @remarks
 * `@mnci/eslint-config` peers on `eslint`, so it never installs one itself.
 */
export const ESLINT_VERSION = '^9.39.0'

/**
 * The ESLint toolchain a generated workspace needs as real devDependencies.
 *
 * @remarks
 * Declaring these is load-bearing, and the reason is easy to miss: `eslint`
 * ends up in `node_modules` anyway (hoisted via `@mnci/eslint-config`), but
 * Nx's generators resolve it from the workspace **manifest**, not from disk.
 * Without the declaration, `mnci add npm-lib` fails outright with "Unable to
 * find `eslint`. Ensure a valid `eslint` version is installed" — verified
 * against a real generated workspace.
 *
 * `create-nx-workspace --preset=ts` does not install any of these; they used
 * to arrive incidentally, whenever the first `nx add @nx/react`-style plugin
 * install happened to pull them in. Now that mnci owns the root ESLint config
 * it owns the toolchain that config needs, rather than relying on that
 * accident.
 *
 * `@nx/eslint` (the `lint` target's executor and the inference plugin) and
 * `@nx/eslint-plugin` (the `@nx/dependency-checks` rule) are pinned to the
 * workspace's own Nx version — a mismatched pair breaks target inference.
 *
 * @param nxVersion - The `nx` version already in the workspace manifest.
 * @returns The devDependency entries to merge in.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
export function eslintToolchainDependencies(nxVersion: string): Record<string, string> {
  return {
    eslint: ESLINT_VERSION,
    '@nx/eslint': nxVersion,
    '@nx/eslint-plugin': nxVersion,
    '@mnci/eslint-config': eslintConfigSpec(),
  }
}

/**
 * The root `eslint.config.mjs` written into generated workspaces.
 *
 * @remarks
 * ESLint config is an mnci-owned file as of this change; it previously was not
 * owned at all, so workspaces silently kept `create-nx-workspace`'s bare
 * `@nx/eslint-plugin` default while the richer rules lived only in mnci's own
 * repo.
 *
 * Deliberately three lines: every rule lives in `@mnci/eslint-config`, so the
 * thirteen plugins are that package's dependencies instead of thirteen
 * devDependencies in every generated workspace.
 *
 * `workspaceRoot` enables the `@nx/dependency-checks` block for `packages/*`
 * and `libs/*` — it has to scan for `private: true` manifests, which is why it
 * needs the path rather than deriving one.
 */
export const ESLINT_CONFIG = `import mnci from '@mnci/eslint-config'

export default mnci({ workspaceRoot: import.meta.dirname })
`

/**
 * The .prettierignore written into generated workspaces.
 *
 * @remarks
 * Patterns to exclude from Prettier formatting, matching root locations.
 *
 * The non-JS entries are not padding. This list used to cover only the
 * JavaScript toolchain, while mnci also generates Python and Dart projects whose
 * tool directories land inside the workspace — and `packages/cli/README.md`
 * explicitly tells users to create a venv there. So `npm run format:check`
 * failed on the `site-packages` tree under `.venv` in any workspace that
 * followed the documented Python setup, and `npm run format` would have
 * rewritten files inside installed third-party packages. Harmless while
 * formatting was unenforced; a hard failure now that it is a CI gate, which is
 * how it surfaced.
 */
export const PRETTIER_IGNORE = `node_modules
dist
dist-dev
dist-uat
dist-prod
coverage
.next
out
.nx
tmp
package-lock.json
*.lock
.venv
venv
__pycache__
.pytest_cache
.ruff_cache
.dart_tool
`

/**
 * VS Code workspace file template for generated monorepos.
 *
 * @remarks
 * Creates a single .code-workspace file that configures the entire monorepo:
 * folder structure, recommended extensions (ESLint, Prettier), workspace
 * settings, and a `tasks` array. The array starts empty; `add/*.ts`'s
 * `registerProjectCommands` (`commands/add/shared.ts`) appends a
 * `build`/`qa`/`start` task per project as it is added, so this template
 * itself carries no project-specific content — it must stay generic across
 * every `mnci new`-generated workspace, not just this repo's own dogfooded
 * root.
 * Users open this file in VS Code (`File > Open Workspace from File`).
 *
 * **`existingTasks` is what keeps `mnci upgrade` non-destructive**, and the need
 * for it was masked by another bug. The overlay owns this file's folders,
 * settings and extensions, but the `tasks` array is per-project state written by
 * `mnci add`, not by the overlay — so regenerating the file wholesale destroys
 * every registered task. That never surfaced only because upgrade used to write
 * to `undefined.code-workspace` and leave the real file untouched; fixing the
 * filename exposed it immediately (verified: a workspace with three projects lost
 * all five of its tasks). Tasks are carried through verbatim rather than
 * regenerated, since the overlay has no idea which projects exist.
 *
 * @param workspaceName - The workspace name.
 * @param existingTasks - The `tasks` object read from a file already on disk, to
 * carry through unchanged. Omitted for a fresh `mnci new`, where there is none.
 * @returns The JSON string for a .code-workspace file.
 * @throws Never - performs pure string formatting with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function vscodeWorkspace(
  workspaceName: string,
  existingTasks?: { version?: string; tasks?: Record<string, unknown>[] }
): string {
  return JSON.stringify(
    {
      folders: [{ path: '.', name: workspaceName }],
      settings: {
        'eslint.validate': [
          'javascript',
          'javascriptreact',
          'typescript',
          'typescriptreact',
          'json',
          'jsonc',
          'markdown',
          'yaml',
        ],
        'editor.codeActionsOnSave': {
          'source.fixAll.eslint': 'explicit',
        },
        'editor.defaultFormatter': 'esbenp.prettier-vscode',
        'editor.formatOnSave': true,
        '[json]': {
          'editor.defaultFormatter': 'esbenp.prettier-vscode',
        },
        '[jsonc]': {
          'editor.defaultFormatter': 'esbenp.prettier-vscode',
        },
        '[yaml]': {
          'editor.defaultFormatter': 'esbenp.prettier-vscode',
        },
      },
      extensions: {
        recommendations: [
          'dbaeumer.vscode-eslint',
          'esbenp.prettier-vscode',
          'nrwl.angular-console',
          'firsttris.vscode-jest-runner',
        ],
      },
      tasks: {
        version: existingTasks?.version ?? '2.0.0',
        tasks: existingTasks?.tasks ?? [],
      },
    },
    null,
    2
  )
}

/**
 * The curated npm scripts stamped into a generated workspace's root manifest.
 *
 * @remarks
 * Each one is a single cross-platform Nx (or husky) invocation — the everyday
 * entry points, nothing more. `affected` compares against `main`
 * (`defaultBase` in `nx.json`); `release:preview` shows what `nx release`
 * would do on CI without touching anything.
 */
export const ROOT_SCRIPTS = {
  build: 'nx run-many -t build',
  lint: 'nx run-many -t lint',
  test: 'nx run-many -t test',
  affected: 'nx affected -t lint,test,build',
  graph: 'nx graph',
  'release:preview': 'nx release --dry-run',
  prepare: 'husky',
} as const

/**
 * The curated scripts with formatting via Prettier and linting via ESLint.
 *
 * @remarks
 * ESLint is a per-project Nx target (`nx run-many -t lint`) following code-quality
 * and correctness rules. Prettier handles all formatting (`npm run format` writes;
 * `npm run format:check` verifies without writing), following JavaScript Standard Style.
 *
 * Every stack also gets `python:install`, chaining the same two guards CI runs
 * ({@link PYTHON_INSTALL_GUARD} then {@link PYTHON_WORKSPACE_INSTALL_GUARD}) —
 * the fixed dev toolchain (ruff/pytest/build/twine) plus an editable install of
 * every workspace Python project, so a fresh clone's `pip install` step is one
 * command instead of "read the CI pipeline to find the right invocation". Both
 * guards already no-op cleanly on a workspace with no Python projects, so it is
 * safe to stamp unconditionally rather than gating on whether one exists yet.
 *
 * @returns The root scripts object to stamp into the manifest.
 * @throws Never - pure mapping.
 */
export function rootScripts(): Record<string, string> {
  return {
    ...ROOT_SCRIPTS,
    format: 'prettier --write .',
    'format:check': 'prettier --check .',
    'python:install': `${PYTHON_INSTALL_GUARD} && ${PYTHON_WORKSPACE_INSTALL_GUARD}`,
  }
}

/**
 * The Nx `generators` defaults patched into `nx.json` from the chosen stack.
 *
 * @remarks
 * Lets a user's own **direct** `nx g @nx/react:app ...` (outside `mnci add`)
 * pick up the workspace's chosen test runner automatically, and — via
 * `linter: 'none'` — keep the workspace's single root ESLint config intact
 * instead of scaffolding a competing per-project one.
 *
 * `mnci add` itself does **not** read this back — see {@link mnciConfig} for
 * the dedicated, single-source-of-truth block it reads instead. The two used
 * to be conflated (`add` inferred the stack from one of these three identical
 * blocks), an implicit "all three stay in lockstep" invariant nothing enforced.
 *
 * @param stack - The chosen stack.
 * @returns The `generators` object for `nx.json`.
 * @throws Never - pure mapping.
 * @typeParam None - this function has no generic type parameters.
 */
export function generatorDefaults(stack: StackConfig): Record<string, unknown> {
  const shared = {
    // `none`, not `eslint`, and the workspace is still fully linted. The root
    // config plus `@nx/eslint/plugin` ({@link ESLINT_PLUGIN_CONFIG}) give every
    // project its `lint` target; `eslint` here would only make the generator
    // scaffold a per-project config mnci deletes anyway — and drag in
    // `eslint-plugin-import@2.31.0`, which peer-caps at ESLint 9 and breaks the
    // install outright on this workspace's ESLint 10.
    linter: 'none',
    unitTestRunner: stack.testRunner,
  }
  return {
    '@nx/react:application': shared,
    '@nx/react:library': shared,
    '@nx/js:library': shared,
  }
}

/**
 * The `mnci` block patched into `nx.json` from the options a `new`/`upgrade`
 * call resolved.
 *
 * @remarks
 * Two independent readers trust this one block: `mnci add`'s
 * `readWorkspaceStack` (`add.ts`) reads only `.stack`, and `mnci upgrade`
 * (`readMnciConfig`, below) reads the whole thing back as the defaults for
 * everything an explicit flag does not override — the only reason `scope`/
 * `registry`/`agent`/`variableGroup`/`ci` are persisted at all, since nothing
 * else in a generated workspace records them. Deliberately separate from
 * {@link generatorDefaults}, which serves Nx's own generator-default
 * mechanism instead (a real, independent feature: it makes a user's own
 * direct `nx g` pick up the right defaults too).
 *
 * @param options - The resolved overlay options (a `new`/`upgrade` call).
 * @returns The `mnci` object for `nx.json`.
 * @throws Never - pure mapping.
 * @typeParam None - this function has no generic type parameters.
 */
export function mnciConfig(options: OverlayOptions): Record<string, unknown> {
  return {
    // Persisted so `mnci upgrade` can name the `<name>.code-workspace` file it
    // rewrites. Its absence is why upgrade used to write a file literally called
    // `undefined.code-workspace` and therefore never refreshed the real one —
    // see `resolveWorkspaceName` in `commands/upgrade.ts`, which still needs a
    // fallback chain for workspaces generated before this field existed.
    workspaceName: options.workspaceName,
    scope: options.scope,
    registry: options.registry,
    agent: options.agent,
    variableGroup: options.variableGroup,
    ci: options.ci,
    stack: { testRunner: options.stack.testRunner },
  }
}

/**
 * Reads back whatever a previous `new`/`upgrade` call persisted via
 * {@link mnciConfig}.
 *
 * @remarks
 * The read-side counterpart `mnci upgrade` (`commands/upgrade.ts`) uses to
 * resolve options: an explicit flag wins, otherwise the persisted value here
 * is the default, so a plain `mnci upgrade` with no flags re-applies the
 * exact same overlay the workspace already has, just regenerated from
 * today's `overlay.ts`. A workspace generated before this was persisted (or
 * hand-edited to remove it) simply has fewer fields here — `upgrade` reports
 * exactly which ones are missing rather than guessing.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Whatever subset of {@link OverlayOptions} is persisted in
 * `nx.json`'s `mnci` block (empty object when there is none).
 * @throws Propagates any Node.js `fs`/JSON error reading `nx.json`.
 * @typeParam None - this function has no generic type parameters.
 */
export function readMnciConfig(workspaceRoot: string): Partial<OverlayOptions> {
  const nxJson = readJson<Record<string, unknown>>(join(workspaceRoot, 'nx.json'))
  return (nxJson.mnci as Partial<OverlayOptions> | undefined) ?? {}
}

/**
 * The Python package registry's `twine upload` URL for a registry config.
 *
 * @remarks
 * Azure Artifacts feeds are **multi-protocol**: the same org/project/feed that
 * serves npm also serves Python, so the pypi upload URL is derived from the same
 * {@link RegistryConfig} — no separate Python registry prompt at `new`. Public
 * npm has no Python analogue wired in this cut (publishing to public PyPI needs
 * a PyPI token, a separate mechanism), so it returns `undefined` and the CI
 * Python-publish step is omitted.
 *
 * @param registry - The monorepo's resolved registry configuration.
 * @returns The pypi upload URL for Azure Artifacts, or `undefined` for npm.
 * @throws Never - performs a pure mapping with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function pythonPublishUrl(registry: RegistryConfig): string | undefined {
  if (registry.kind === 'azure-artifacts') {
    return `https://pkgs.dev.azure.com/${registry.organization}/${registry.project}/_packaging/${registry.artifactsFeed}/pypi/upload/`
  }
  return undefined
}

/**
 * The portable `node -e` one-liner that installs the fixed Python toolchain
 * (`ruff`/`pytest`/`build`/`twine`) from `requirements-dev.txt`.
 *
 * @remarks
 * Shared bit-for-bit by {@link azurePipelinesYaml} and {@link githubActionsYaml}
 * — one guard script, so the two providers can never drift on what "install
 * Python deps" means. Skips cleanly on a workspace with no Python projects
 * (no `requirements-dev.txt`, written by `add/python.ts` on the first
 * Python `add`).
 *
 * Resolves `python` vs `python3` at run time via `process.platform`, not a
 * hard-coded name: the standard python.org Windows installer registers only
 * `python.exe`, so a build agent on a `windows-latest` (or self-hosted
 * Windows) runner hard-fails immediately on a hard-coded `python3` with
 * "'python3' is not recognized as an internal or external command" — every
 * POSIX system (the assumed default) registers `python3`. Same resolution
 * {@link PYTHON_WORKSPACE_INSTALL_GUARD} and every `@mnci/nx-python-pip`
 * executor use (that package's own `pythonCommand` helper); this guard is a
 * plain generated string, not TypeScript, so it inlines the identical check
 * rather than importing it.
 */
const PYTHON_INSTALL_GUARD = `node -e "if(!require('node:fs').existsSync('requirements-dev.txt')){console.log('No Python projects - skipping.');process.exit(0)}const py=process.platform==='win32'?'python':'python3';process.exit(require('node:child_process').spawnSync(py+' -m pip install -r requirements-dev.txt',{stdio:'inherit',shell:true}).status ?? 1)"`

/**
 * The portable `node -e` one-liner that editable-installs every Python
 * project into one shared environment, so cross-project imports resolve at
 * lint/test/dev time — the pip-world counterpart of `npm install` hoisting
 * every workspace package into one root `node_modules`.
 *
 * @remarks
 * Pip has no native workspace protocol (no hoisting, no auto-symlinking of
 * sibling packages), so this is hand-built rather than something pip does on
 * its own: every project with a `pyproject.toml` (`apps/*`, `python-packages/*`,
 * `libs/*` — apps, publishable libs, and internal libs alike) is
 * `pip install -e`'d, and every Azure Function app (`requirements.txt`, no
 * `pyproject.toml` — the shape `@mnci/nx-python-pip`'s `function-application`
 * generator writes) gets `pip install -r`'d, all in **one** `pip install`
 * invocation (not one per project) so the resolver sees every requirement
 * together, same as one `npm install` at the root.
 *
 * This is deliberately broader than the `test` executor's own per-project
 * `pip install -e .` (`@mnci/nx-python-pip`'s `installEditable` option,
 * which only installs the project under test, not what it imports): an
 * internal lib is normally only woven into a consumer at **build** time (the
 * `build` executor's vendoring copy step — see `@mnci/nx-python-pip`'s
 * README), so without this step a project that imports an internal lib
 * cannot resolve that import at test/dev time, only at the final wheel. This
 * step editable-installs the internal lib too, so the import resolves
 * everywhere it is written, not just in the built artifact. It does not
 * change what a published wheel contains — vendoring at build time is
 * unaffected, since pip has no registry-time equivalent of installing an
 * unpublished workspace-only package.
 *
 * Shared bit-for-bit by {@link azurePipelinesYaml} and {@link githubActionsYaml}.
 * Skips cleanly when the workspace has no Python projects. Runs after
 * {@link PYTHON_INSTALL_GUARD} (the fixed dev toolchain), before `sync:check`.
 * Resolves `python` vs `python3` at run time the same way
 * {@link PYTHON_INSTALL_GUARD} does — see its remarks.
 */
const PYTHON_WORKSPACE_INSTALL_GUARD = `node -e "const fs=require('node:fs'),path=require('node:path');const editableDirs=[...fs.globSync('apps/*/pyproject.toml'),...fs.globSync('python-packages/*/pyproject.toml'),...fs.globSync('libs/*/pyproject.toml')].map((p)=>path.dirname(p));const requirementsFiles=fs.globSync('apps/*/requirements.txt');if(editableDirs.length===0&&requirementsFiles.length===0){console.log('No Python projects - skipping.');process.exit(0)}const args=['-m','pip','install','--quiet',...editableDirs.flatMap((d)=>['-e',d]),...requirementsFiles.flatMap((f)=>['-r',f])];const py=process.platform==='win32'?'python':'python3';process.exit(require('node:child_process').spawnSync(py,args,{stdio:'inherit'}).status ?? 1)"`

/**
 * The portable `node -e` one-liner that runs `pip-audit` against the shared
 * Python environment, non-blocking (warn-only).
 *
 * @remarks
 * Shared bit-for-bit by {@link azurePipelinesYaml} and {@link githubActionsYaml}.
 * Runs after {@link PYTHON_WORKSPACE_INSTALL_GUARD}, so the environment it
 * scans already has every project's real dependencies installed (not just
 * the fixed toolchain) — a bare `pip-audit` with no arguments audits
 * whatever is currently installed, which by this point in the pipeline is
 * the workspace's actual dependency set. Skips cleanly when the workspace
 * has no Python projects (same `requirements-dev.txt` check every other
 * Python guard here uses).
 *
 * **Deliberately non-blocking**: `pip-audit`'s own exit code is discarded
 * (`process.exit(0)` always) rather than failing the build — the sibling
 * `npm audit` step ({@link NPM_AUDIT_STEP}) makes the identical choice, and
 * for the identical reason: an upstream-only advisory with no
 * user-actionable fix (a transitive dependency of a pinned tool, not
 * patchable by editing this workspace's own manifest) would otherwise turn
 * every build red for a problem nobody here can fix. See
 * {@link NPM_AUDIT_STEP}'s remarks for the concrete example this reasoning
 * is drawn from.
 */
const PIP_AUDIT_GUARD = `node -e "if(!require('node:fs').existsSync('requirements-dev.txt')){console.log('No Python projects - skipping.');process.exit(0)}const py=process.platform==='win32'?'python':'python3';require('node:child_process').spawnSync(py,['-m','pip_audit'],{stdio:'inherit'});process.exit(0)"`

/**
 * The portable `node -e` one-liner that downloads the workspace's Go module
 * dependencies.
 *
 * @remarks
 * Shared bit-for-bit by {@link azurePipelinesYaml} and {@link githubActionsYaml},
 * and gated on the workspace-root `go.mod` that `add/go.ts` writes on the
 * first `mnci add go-*` — so a workspace with no Go projects skips cleanly,
 * exactly like the Python guards skip on a missing `requirements-dev.txt`.
 *
 * One root `go.mod` is the whole story here: mnci generates Go projects into
 * a single module (see `add/go.ts`), so there is no per-project manifest to
 * walk and no `go.work` to keep in step — a plain `go mod download` at the
 * root fetches everything every Go project needs.
 *
 * Strictly speaking this step is optional, since `go build` and `go test`
 * both fetch on demand. It is here so a network failure surfaces as an
 * obvious "download dependencies" failure rather than as a confusing error
 * inside the build, matching what the Python install steps do.
 */
const GO_MODULE_DOWNLOAD_GUARD = `node -e "if(!require('node:fs').existsSync('go.mod')){console.log('No Go projects - skipping.');process.exit(0)}process.exit(require('node:child_process').spawnSync('go',['mod','download'],{stdio:'inherit'}).status ?? 1)"`

/**
 * The portable `node -e` one-liner that installs `golangci-lint` when the
 * workspace has Go projects and the agent does not already provide it.
 *
 * @remarks
 * Needed because mnci's generated Go `lint` target pins
 * `linter: golangci-lint` — `@nx-go/nx-go`'s own default is `go fmt`, which
 * only reformats and would make a green lint step meaningless. Hosted agents
 * ship Go but not golangci-lint, so CI has to supply it.
 *
 * Installs via `go install`, which needs no package manager, no sudo and no
 * platform switch — the same binary lands on Linux, macOS and Windows
 * agents. `go install` places it in `GOBIN` (or `GOPATH/bin`), so that
 * directory is appended to `PATH` for subsequent steps through each
 * provider's own mechanism (see the call sites).
 *
 * Skips when `golangci-lint` is already resolvable, so a self-hosted agent
 * that pre-installs it pays nothing.
 */
const GOLANGCI_LINT_INSTALL_GUARD = `node -e "const fs=require('node:fs'),cp=require('node:child_process');if(!fs.existsSync('go.mod')){console.log('No Go projects - skipping.');process.exit(0)}if(cp.spawnSync('golangci-lint',['--version'],{stdio:'ignore'}).status===0){console.log('golangci-lint already installed - skipping.');process.exit(0)}process.exit(cp.spawnSync('go',['install','github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest'],{stdio:'inherit'}).status ?? 1)"`

/**
 * The shared prelude that resolves `GOPATH/bin` — where
 * {@link GOLANGCI_LINT_INSTALL_GUARD}'s `go install` puts the linter.
 *
 * @remarks
 * Not a step on its own: {@link GO_TOOL_PATH_AZURE} and
 * {@link GO_TOOL_PATH_GITHUB} each append the one line that publishes the
 * directory to the rest of the job, because the two providers use entirely
 * different mechanisms for that (a logging command vs a file). Everything up
 * to that point — the skip-when-no-Go check and reading `go env GOPATH` —
 * is identical, so it lives here once.
 */
const GO_TOOL_PATH_PRELUDE = `const fs=require('node:fs'),cp=require('node:child_process');if(!fs.existsSync('go.mod')){console.log('No Go projects - skipping.');process.exit(0)}const r=cp.spawnSync('go',['env','GOPATH'],{encoding:'utf8'});if(r.status!==0){console.log('Could not resolve GOPATH - skipping.');process.exit(0)}const bin=require('node:path').join(r.stdout.trim(),'bin');`

/**
 * Azure Pipelines: publishes `GOPATH/bin` to later steps in the job.
 *
 * @remarks
 * Uses the `task.prependpath` logging command — Azure's supported way for a
 * step to alter `PATH` for the steps that follow it. Skips cleanly when the
 * workspace has no Go projects, so this is inert in a JS-only repo.
 */
const GO_TOOL_PATH_AZURE = `node -e "${GO_TOOL_PATH_PRELUDE}console.log('##vso[task.prependpath]'+bin)"`

/**
 * GitHub Actions: publishes `GOPATH/bin` to later steps in the job.
 *
 * @remarks
 * Appends to the file named by `GITHUB_PATH`, the documented equivalent of
 * Azure's `prependpath` logging command. Skips cleanly both when the
 * workspace has no Go projects and when `GITHUB_PATH` is unset (i.e. when
 * the same script is run outside Actions).
 */
const GO_TOOL_PATH_GITHUB = `node -e "${GO_TOOL_PATH_PRELUDE}if(!process.env.GITHUB_PATH){console.log('Not running in GitHub Actions - skipping.');process.exit(0)}fs.appendFileSync(process.env.GITHUB_PATH,bin+${String.raw`'\n'`})"`

/**
 * The Flutter SDK version the generated pipeline installs.
 *
 * @remarks
 * Pinned, unlike `golangci-lint`'s `@latest`, because the Flutter version
 * *determines the Dart version*, and Dart is what has the hard floor here:
 * pub workspaces — the whole basis of mnci's central-dependency model for
 * Dart — need Dart 3.6+. A floating `stable` could in principle move the
 * toolchain under a workspace without warning, so the version is explicit and
 * bumped deliberately.
 *
 * `3.44.8` ships Dart 3.12.2. Exported so tests can assert it and so bumping
 * it is a one-line change.
 */
export const FLUTTER_SDK_VERSION = '3.44.8'

/**
 * The shared expression that resolves where the Flutter SDK is installed.
 *
 * @remarks
 * Deliberately **outside** the workspace, under the agent's home directory —
 * not in a workspace-local `.flutter-sdk`. Two reasons, and the second is the
 * serious one:
 *
 * 1. Nothing needs adding to `.gitignore` (the overlay writes no `.gitignore`
 *    of its own; `create-nx-workspace` owns that file).
 * 2. The Flutter SDK ships **its own `pubspec.yaml` files** — dozens of them,
 *    across `packages/flutter`, `packages/flutter_test` and the rest. Cloning
 *    it inside the workspace would drop those into the pub workspace's own
 *    tree, where `pub` treats a stray nested pubspec as an error to resolve
 *    around, and would give Nx thousands of extra files to glob for its
 *    project graph.
 *
 * Keyed by version, so bumping {@link FLUTTER_SDK_VERSION} provisions a fresh
 * clone instead of leaving a stale checkout on a cached agent. Computed
 * identically by the install guard and the PATH guards so they always agree.
 */
const FLUTTER_SDK_DIRECTORY_EXPRESSION = `require('node:path').join(require('node:os').homedir(),'.mnci-flutter-${FLUTTER_SDK_VERSION}')`

/**
 * The portable `node -e` one-liner that installs the Flutter SDK.
 *
 * @remarks
 * Flutter is the one toolchain the pipeline genuinely has to install: Python
 * and Go both ship on every hosted agent image, Flutter does not. So unlike
 * the Python and Go guards — which only fetch *dependencies* — this one
 * fetches the SDK itself.
 *
 * Installed by shallow `git clone` at a pinned tag, which is Flutter's own
 * documented install method and the only one that is genuinely uniform across
 * agents: the release archives differ by platform (`.tar.xz` on Linux,
 * `.zip` on macOS/Windows), which would force a platform switch and an
 * extractor into what is meant to be one portable line. `git` is already a
 * hard requirement of this pipeline, so nothing new is assumed.
 * `--depth 1` keeps it to a single revision.
 *
 * Two levels of skip, mirroring {@link GOLANGCI_LINT_INSTALL_GUARD}: nothing
 * happens without a workspace-root `pubspec.yaml` (so a JS-only repo pays
 * nothing), and nothing happens when `flutter` already resolves — so a
 * self-hosted agent with a preinstalled SDK, or a second run on a warm
 * workspace, skips the download entirely.
 */
const FLUTTER_SDK_INSTALL_GUARD = `node -e "const fs=require('node:fs'),cp=require('node:child_process');if(!fs.existsSync('pubspec.yaml')){console.log('No Flutter projects - skipping.');process.exit(0)}if(cp.spawnSync('flutter',['--version'],{stdio:'ignore',shell:process.platform==='win32'}).status===0){console.log('Flutter SDK already on PATH - skipping.');process.exit(0)}const sdk=${FLUTTER_SDK_DIRECTORY_EXPRESSION};if(fs.existsSync(sdk)){console.log('Flutter SDK already installed at '+sdk+' - skipping.');process.exit(0)}process.exit(cp.spawnSync('git',['clone','--depth','1','--branch','${FLUTTER_SDK_VERSION}','https://github.com/flutter/flutter.git',sdk],{stdio:'inherit'}).status ?? 1)"`

/**
 * The shared prelude that resolves the Flutter SDK's `bin` directory.
 *
 * @remarks
 * Not a step on its own — {@link FLUTTER_TOOL_PATH_AZURE} and
 * {@link FLUTTER_TOOL_PATH_GITHUB} each append the one line that publishes the
 * directory, exactly as the Go pair does. Skips when there are no Flutter
 * projects, and also when the SDK was never cloned because one was already on
 * `PATH` (in which case there is nothing to publish).
 */
const FLUTTER_TOOL_PATH_PRELUDE = `const fs=require('node:fs'),path=require('node:path');if(!fs.existsSync('pubspec.yaml')){console.log('No Flutter projects - skipping.');process.exit(0)}const sdk=${FLUTTER_SDK_DIRECTORY_EXPRESSION};if(!fs.existsSync(sdk)){console.log('Flutter SDK was not installed by mnci (already on PATH) - skipping.');process.exit(0)}const bin=path.join(sdk,'bin');`

/**
 * Azure Pipelines: publishes the Flutter SDK's `bin` to later steps.
 *
 * @remarks
 * Uses the `task.prependpath` logging command, the same mechanism
 * {@link GO_TOOL_PATH_AZURE} uses.
 */
const FLUTTER_TOOL_PATH_AZURE = `node -e "${FLUTTER_TOOL_PATH_PRELUDE}console.log('##vso[task.prependpath]'+bin)"`

/**
 * GitHub Actions: publishes the Flutter SDK's `bin` to later steps.
 *
 * @remarks
 * Appends to the file named by `GITHUB_PATH`, mirroring
 * {@link GO_TOOL_PATH_GITHUB}, and skips cleanly when run outside Actions.
 */
const FLUTTER_TOOL_PATH_GITHUB = `node -e "${FLUTTER_TOOL_PATH_PRELUDE}if(!process.env.GITHUB_PATH){console.log('Not running in GitHub Actions - skipping.');process.exit(0)}fs.appendFileSync(process.env.GITHUB_PATH,bin+${String.raw`'\n'`})"`

/**
 * The portable `node -e` one-liner that resolves every Dart dependency.
 *
 * @remarks
 * **This is the dependency-injection step for Flutter**, and it is a single
 * command for the whole workspace by design. Because every project is a
 * member of the root pub workspace (`workspace:` in the root `pubspec.yaml`,
 * `resolution: workspace` in each member), one `flutter pub get` at the root
 * resolves **internal and external dependencies together** into one
 * `pubspec.lock` and one `.dart_tool/package_config.json` — pub even deletes
 * any stale per-package copies.
 *
 * That is why there is no second, workspace-wide step here of the kind Python
 * needs ({@link PYTHON_WORKSPACE_INSTALL_GUARD} exists only because pip has no
 * workspace protocol and every project must be editable-installed by hand).
 * Dart has a real workspace protocol, so this one line is the whole story —
 * and a project importing an internal lib resolves it with a plain version
 * constraint, no `path:` and no vendoring.
 *
 * Runs with `shell: true` on Windows only, where `flutter` is a `.bat` shim
 * that `spawnSync` cannot execute directly.
 */
const FLUTTER_PUB_GET_GUARD = `node -e "const fs=require('node:fs');if(!fs.existsSync('pubspec.yaml')){console.log('No Flutter projects - skipping.');process.exit(0)}process.exit(require('node:child_process').spawnSync('flutter',['pub','get'],{stdio:'inherit',shell:process.platform==='win32'}).status ?? 1)"`

/**
 * The `npm audit` step run right after `npm ci`, non-blocking (warn-only).
 *
 * @remarks
 * Shared bit-for-bit by {@link azurePipelinesYaml} and {@link githubActionsYaml}
 * — a single-line shell command, not a `node -e` guard, since it needs no
 * existence check (`package-lock.json` always exists). `||` is a standard
 * conditional-execution operator in both `cmd.exe` and POSIX `sh` (verified
 * empirically elsewhere in this file, e.g. `git init -q -b main && git add -A`
 * in the real e2e suite), so this one line runs unchanged on every agent OS.
 *
 * **Deliberately non-blocking.** Verified empirically (a real `npm audit` on
 * this monorepo's own dependency tree) that every flagged vulnerability
 * traced back to `nx`'s and `verdaccio`'s own bundled transitive
 * dependencies, both already at their latest published release — nothing an
 * edit to *this* workspace's manifest could fix, only a future upstream
 * release. A hard-failing audit step would have turned CI red for a problem
 * with no user-actionable fix, for as long as upstream took to patch it. The
 * real, current fix for a genuinely actionable finding (targeted
 * `package.json` `overrides` on just the vulnerable transitive package, not
 * a blanket `--force`) is exactly what this monorepo's own `fix(deps)`
 * commit did — a manual, reviewed response, not something CI should attempt
 * automatically. So this step's job is visibility (a clearly labelled
 * section in every CI log), not enforcement.
 */
const NPM_AUDIT_STEP =
  'npm audit --audit-level=high || echo npm audit found vulnerabilities, see log above - non-blocking, run npm audit locally to inspect'

/**
 * The portable `node -e` one-liner that packs every app into
 * `dist/drop/<type>-<name>.zip` via each app's own `package` target.
 *
 * @remarks
 * Shared bit-for-bit by {@link azurePipelinesYaml} and {@link githubActionsYaml}.
 * Skips cleanly when the workspace has no apps yet.
 */
const PACK_APPS_GUARD = `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});if(fs.globSync('apps/*/project.json').length===0){console.log('No apps to pack - skipping.');process.exit(0)}process.exit(require('node:child_process').spawnSync('npx nx run-many -t package',{stdio:'inherit',shell:true}).status ?? 1)"`

/**
 * Builds the portable `node -e` one-liner that versions, tags and publishes
 * both `packages/*` (npm) and `python-packages/*` (Python) via `nx release`.
 *
 * @remarks
 * Shared bit-for-bit by {@link azurePipelinesYaml} and {@link githubActionsYaml}
 * — `pythonPublishEnv` is the only provider-specific fragment (both providers
 * decode the same base64 `PAT` env var, so the fragment itself is identical
 * too; only the caller decides whether to inject it). Skips cleanly when
 * there is nothing to release (`nx release` hard-errors on an empty scope).
 *
 * @param pythonPublishEnv - A `node -e`-fragment that exports `TWINE_*` when
 * there are Python packages and a configured feed, or `''` to export nothing.
 * @returns The full `node -e` release one-liner.
 * @throws Never - pure string building.
 * @typeParam None - this function has no generic type parameters.
 */
function releaseGuard(pythonPublishEnv: string): string {
  return `node -e "const fs=require('node:fs'),cp=require('node:child_process');const hasNpm=fs.globSync('packages/*/package.json').length>0;const hasPython=fs.globSync('python-packages/*/pyproject.toml').length>0;if(!hasNpm&&!hasPython){console.log('Nothing to release - skipping.');process.exit(0)}const env={...process.env};${pythonPublishEnv}process.exit(cp.spawnSync('npx nx release --yes',{stdio:'inherit',shell:true,env}).status ?? 1)"`
}

/**
 * Injected into {@link releaseGuard}: when there are Python packages and a
 * configured Azure feed, export twine publish credentials (the raw PAT,
 * decoded from the base64 value both providers read from a `PAT` env var).
 *
 * @param pythonPublishUrl - The twine upload URL for Python packages, or
 * `undefined` to leave Python publishing unconfigured (public npm).
 * @returns The `node -e` fragment, or `''` when there is no Python feed.
 * @throws Never - pure string mapping.
 * @typeParam None - this function has no generic type parameters.
 */
function pythonPublishEnvFragment(pythonPublishUrl?: string): string {
  return pythonPublishUrl
    ? `if(hasPython){env.TWINE_REPOSITORY_URL='${pythonPublishUrl}';env.TWINE_USERNAME='AzureArtifacts';env.TWINE_PASSWORD=Buffer.from(process.env.PAT,'base64').toString()}`
    : ''
}

/**
 * The env var name + value pair that authenticates `npm ci`/`nx release publish`,
 * keyed by registry kind — two genuinely different secrets, never conflated.
 *
 * @remarks
 * Azure Artifacts' `.npmrc` (`npmrcContent`) reads a base64-encoded PAT via
 * `${PAT}`; public npm's reads a raw npm automation token via
 * `${NODE_AUTH_TOKEN}`. Before this, both {@link azurePipelinesYaml} and
 * {@link githubActionsYaml} always exported `PAT` regardless of registry —
 * harmless for Azure Artifacts, but silently non-functional for public npm
 * (nothing ever populated `NODE_AUTH_TOKEN`, so a public-npm workspace's CI
 * could build and version but never actually authenticate a publish).
 *
 * @param registryKind - The workspace's registry kind.
 * @param variableReference - Renders a named secret/variable in the calling
 * provider's own syntax (Azure `$(NAME)`, GitHub `${{ secrets.NAME }}`).
 * @returns A `[envVarName, value]` pair to render under the step's `env:` block.
 * @throws Never - pure mapping.
 * @typeParam None - this function has no generic type parameters.
 */
function npmAuthEnvVariable(
  registryKind: RegistryConfig['kind'],
  variableReference: (name: string) => string
): [string, string] {
  return registryKind === 'npm'
    ? ['NODE_AUTH_TOKEN', variableReference('NPM_TOKEN')]
    : ['PAT', variableReference('PAT')]
}

/**
 * Renders the `pool:` block body for a chosen build agent.
 *
 * @remarks
 * One CLI value drives it: Microsoft-hosted images start `ubuntu-`/`windows-`/
 * `macos-` (`ubuntu-latest`, `windows-2022`, `macos-13`, …) → `vmImage`;
 * anything else is treated as a self-hosted pool name → `name`. Either way the
 * pipeline's steps are OS-agnostic, so it runs unchanged on the chosen agent.
 *
 * @param agent - The vmImage or self-hosted pool name.
 * @returns The two-space-indented `pool:` child line.
 * @throws Never - pure string mapping.
 * @typeParam None - this function has no generic type parameters.
 */
export function poolBlock(agent: string): string {
  return /^(ubuntu|windows|macos)-/i.test(agent) ? `  vmImage: ${agent}` : `  name: ${agent}`
}

/**
 * Builds the generated workspace's whole CI: one short Azure Pipelines file.
 *
 * @remarks
 * Runs unchanged on ANY agent OS (Linux, macOS, Windows): no bash, no
 * PowerShell — every step is a built-in task or a single-line
 * `git`/`npm`/`npx`/`node` command `cmd.exe` and `sh` execute identically.
 *
 * Every run first checks `nx sync:check` — a fast, explicit failure when
 * someone forgot to run `nx sync` (and commit the result) after adding a
 * cross-project import. `sync.applyChanges` in `nx.json` ({@link SYNC_CONFIG})
 * means that locally this almost never happens: Nx auto-applies the fix on the
 * next build/typecheck instead of just prompting.
 *
 * On `main` (non-PR) the pipeline: **packs every app** into `dist/drop/` as one
 * zip per app named `<type>-<name>.zip` (each app owns an `nx` `package`
 * target — {@link runAdd}), publishes `dist/drop` as the **`drop`** artifact,
 * emits one **build tag per app** (`##vso[build.addbuildtag]<type>-<name>`,
 * derived from the zip filenames so it is *exactly* the zip name — the classic
 * release/CD pipeline keys off it), then `nx release`s: **publish packages +
 * tag main** (versions from conventional commits, tag-only push).
 *
 * npm auth is the base64 PAT from the `variableGroup` (default `Build`): the
 * group exposes `$(PAT)`, mapped as env on the npm steps and read by the root
 * `.npmrc`'s `_password` block. No `npmAuthenticate@0` (it would overwrite
 * that password).
 *
 * Hard-won Azure lessons carried over:
 * - `checkout: self` detaches HEAD; re-attach with `git checkout -B` first or
 *   `nx release` cannot push tags.
 * - Fetch all refs + tags up front (version resolution needs the tags).
 * - A git identity is required to create annotated tags on CI.
 * - One-time grants (project admin): *Project Collection Build Service* needs
 *   *Contribute* on the repo (tag push); the PAT's owner needs feed *publish*.
 *
 * `nx release` versions BOTH `packages/*` (npm) and `python-packages/*`
 * (Python) from conventional commits and tags each — one unified release. When
 * `pythonPublishUrl` is set (Azure Artifacts — {@link pythonPublishUrl}), the
 * release step also exports `TWINE_*` so `nx release` publishes the Python
 * packages with `twine`, reusing the base64 `PAT` decoded to the raw token
 * twine/pypi basic-auth needs (no second secret; Azure accepts any username).
 * For the public-npm registry that env is omitted, so a Python package there
 * is still versioned + tagged but its publish needs user-provided `TWINE_*`.
 * Before any Python target runs, one guarded step installs the fixed toolchain
 * (`ruff`/`pytest`/`build`/`twine`) from the workspace's `requirements-dev.txt`
 * — written by `add/python.ts` on the first Python `add` — and a second
 * editable-installs every Python project into that same environment (the
 * pip-world counterpart of `npm install` hoisting every workspace package
 * into one root `node_modules`); both are skipped cleanly on a workspace with
 * no Python projects.
 *
 * @param agent - The build agent (vmImage or self-hosted pool name).
 * @param variableGroup - The Library variable group holding the base64 `PAT`.
 * @param pythonPublishUrl - The twine upload URL for Python packages, or
 * `undefined` to leave Python publishing unconfigured (public npm).
 * @returns The full text of `azure-pipelines.yml`.
 * @throws Never - performs a pure mapping with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function azurePipelinesYaml(
  agent: string,
  variableGroup: string,
  pythonPublishUrl?: string,
  registryKind: RegistryConfig['kind'] = 'azure-artifacts'
): string {
  const onMain = `and(succeeded(), ne(variables['Build.Reason'], 'PullRequest'), eq(variables['Build.SourceBranchName'], 'main'))`
  const [npmAuthName, npmAuthValue] = npmAuthEnvVariable(registryKind, name => `$(${name})`)
  return `name: monorepo-ci-$(Date:yyyyMMdd)$(Rev:.r)

# Generated by MoNecromanCI. Deliberately thin: Nx builds, 'nx release'
# versions from conventional commits and pushes ONLY a tag to main, and each
# app is packed into dist/drop/<type>-<name>.zip by its own 'package' target.
#
# Cross-platform by construction: no bash, no PowerShell. Every step is a
# built-in task or a single-line git/npm/npx/node command, so the pipeline
# runs unchanged on Linux, macOS and Windows agents.

trigger:
  branches:
    include: [main]

pr:
  branches:
    include: [main]

pool:
${poolBlock(agent)}

variables:
  # Holds the npm auth secret the root .npmrc reads: the base64-encoded \`PAT\`
  # for an Azure Artifacts feed, or a raw npm automation token as \`NPM_TOKEN\`
  # for public npm. Mark it secret in Library. Add app build vars here too if needed.
  - group: ${variableGroup}

steps:
  - checkout: self
    # Lets later steps push release tags back to the repo. The Project
    # Collection Build Service account needs Contribute permission on this
    # repo (Project Settings -> Repositories -> Security) — one-time grant.
    persistCredentials: true
    fetchDepth: 0

  # checkout leaves a detached HEAD; nx release needs a real branch.
  - script: git checkout -B $(Build.SourceBranchName)
    displayName: Attach HEAD to the source branch

  # Version resolution needs the release tags.
  - script: git fetch --all --prune --tags
    displayName: Fetch branches and release tags

  - script: git config user.name "Azure Pipelines" && git config user.email "pipeline@dev.azure.com"
    displayName: Set the git identity used for release tags

  - task: UseNode@1
    inputs:
      version: 24.x

  - script: npm ci
    displayName: Install dependencies
    env:
      ${npmAuthName}: ${npmAuthValue}

  # Non-blocking: surfaces known-vulnerable dependencies in every CI log
  # without failing the build over an upstream-only advisory nobody here can
  # fix (see NPM_AUDIT_STEP's remarks in overlay.ts for why).
  - script: ${NPM_AUDIT_STEP}
    displayName: npm audit (non-blocking)

  # Installs the fixed Python toolchain (ruff, pytest, build, twine, pip-audit)
  # — written by 'mnci add' to requirements-dev.txt on the first Python
  # project. Plain pip, no uv/Poetry: portable guard skips cleanly on a
  # workspace with none.
  - script: ${PYTHON_INSTALL_GUARD}
    displayName: Install Python dependencies (ruff, pytest, build, twine, pip-audit)

  # Editable-installs every Python project into one shared environment, the
  # pip-world counterpart of 'npm install' hoisting every workspace package
  # into one root node_modules — so a project that imports an internal lib
  # (normally vendored only at build time) can resolve that import at
  # lint/test time too. Portable guard skips cleanly on a workspace with none.
  - script: ${PYTHON_WORKSPACE_INSTALL_GUARD}
    displayName: Install Python project dependencies (editable, workspace-wide)

  # Non-blocking, same reasoning as the npm audit step above. Runs after the
  # workspace-wide install so it scans the workspace's actual dependency set,
  # not just the fixed toolchain.
  - script: ${PIP_AUDIT_GUARD}
    displayName: pip-audit (non-blocking)

  # Go, if the workspace has any: hosted agents ship the toolchain, so only
  # the module cache and the linter need seeding. Both guards skip cleanly on
  # a workspace with no root go.mod.
  - script: ${GO_MODULE_DOWNLOAD_GUARD}
    displayName: Download Go module dependencies

  # golangci-lint is what the generated Go lint target actually runs (the
  # plugin's own default is 'go fmt', which only reformats). 'go install'
  # drops it in GOPATH/bin, which is not on PATH by default on a hosted
  # agent — so prepend it for every later step in the job.
  - script: ${GOLANGCI_LINT_INSTALL_GUARD}
    displayName: Install golangci-lint

  - script: ${GO_TOOL_PATH_AZURE}
    displayName: Add Go tool bin to PATH

  # Flutter, if the workspace has any. Unlike Python and Go, hosted agents do
  # NOT ship the Flutter SDK, so this installs it (shallow git clone at a
  # pinned tag) and puts it on PATH. All three guards skip cleanly on a
  # workspace with no root pubspec.yaml, and the install also skips when an
  # SDK is already on PATH.
  - script: ${FLUTTER_SDK_INSTALL_GUARD}
    displayName: Install the Flutter SDK (${FLUTTER_SDK_VERSION})

  - script: ${FLUTTER_TOOL_PATH_AZURE}
    displayName: Add the Flutter SDK to PATH

  # One command resolves EVERY Dart dependency, internal and external, for the
  # whole workspace: the projects are pub workspace members, so this writes a
  # single root pubspec.lock they all share.
  - script: ${FLUTTER_PUB_GET_GUARD}
    displayName: Resolve Dart dependencies (one pub get for the whole workspace)

  # Fails fast, with an unambiguous message, when a stale TypeScript project
  # reference (or another sync generator's drift) was never synced+committed
  # locally — sync.applyChanges (nx.json) only auto-applies interactively, so
  # CI still needs its own explicit, early check rather than surfacing this as
  # a confusing failure buried inside the build step below.
  - script: npx nx sync:check
    displayName: Verify the workspace is synced (run 'npx nx sync' locally and commit if this fails)

  # One verify for every run (PR and main). Nx cache makes unchanged test/build
  # projects instant.
  - script: npm run lint
    displayName: Lint

  # Prettier owns ALL formatting in this workspace, so it needs a gate of its
  # own: ESLint is configured for correctness only and deliberately reports
  # nothing about formatting. Without this step the entire formatting opinion is
  # advisory, and a workspace drifts out of compliance with no signal anywhere.
  - script: npm run format:check
    displayName: Check formatting (run 'npm run format' locally to fix)
  # \`lint\` here also runs any Nx lint targets \`npm run lint\` does not cover —
  # notably Python's ruff (every Python project owns a hand-authored \`lint\`
  # target). For the eslint stack the JS lint runs twice, but Nx caches the
  # repeat instantly.
  - script: npx nx run-many -t lint,test,build
    displayName: Lint, test and build everything

  # Pack every app into dist/drop/<type>-<name>.zip via each app's 'package'
  # target. Portable guard: skip cleanly when the workspace has no apps yet.
  - script: ${PACK_APPS_GUARD}
    displayName: Pack all apps (one zip per app -> dist/drop)
    condition: ${onMain}

  - task: PublishBuildArtifacts@1
    displayName: Publish the drop (one zip per app)
    condition: ${onMain}
    inputs:
      PathtoPublish: $(Build.SourcesDirectory)/dist/drop
      ArtifactName: drop

  # One build tag per packed app, EXACTLY the zip name (type-name), so the
  # classic release pipeline knows which app to run for. Derived from the zip
  # filenames so the tag can never drift from the artifact.
  - script: node -e "const fs=require('node:fs');const path=require('node:path');for(const f of fs.globSync('dist/drop/*.zip')){console.log('##vso[build.addbuildtag]'+path.basename(f,'.zip'))}"
    displayName: Tag the run per app (type-name)
    condition: ${onMain}

  # Version + tag + publish, in one release, for npm (packages/*) AND Python
  # (python-packages/*) — conventional commits, tag-only push. Portable guard:
  # nx release errors on an empty scope, so skip cleanly when there is nothing
  # to release. When there are Python packages and an Azure feed, twine
  # publish credentials are exported (raw PAT, decoded from the base64 variable).
  - script: ${releaseGuard(pythonPublishEnvFragment(pythonPublishUrl))}
    displayName: Release — version, tag and publish (npm + Python)
    condition: ${onMain}
    env:
      ${npmAuthName}: ${npmAuthValue}

  # nx release's own git push (release.git.push) is deliberately left off: it
  # only runs when a remote GitHub/GitLab Release is configured, which this
  # pipeline never does, so it would never push the tag the step above just
  # created. Pushed explicitly, unconditionally (a no-op when nothing released)
  # once tagging is guaranteed to have already happened.
  - script: git push origin --tags
    displayName: Push release tags (nx release's own push never runs without a remote Release configured)
    condition: ${onMain}
`
}

/**
 * Builds the generated workspace's whole CI as a GitHub Actions workflow —
 * the GitHub-hosted equivalent of {@link azurePipelinesYaml}.
 *
 * @remarks
 * Same pipeline, same shared guard scripts ({@link PYTHON_INSTALL_GUARD},
 * {@link PYTHON_WORKSPACE_INSTALL_GUARD}, {@link PIP_AUDIT_GUARD},
 * {@link NPM_AUDIT_STEP}, {@link PACK_APPS_GUARD}, {@link releaseGuard}) —
 * only the provider syntax differs, so the two YAML files can never drift on
 * what CI actually does.
 * Two steps from the Azure version are dropped, both for reasons already
 * documented there:
 * - **Attach HEAD to a branch**: `actions/checkout` (unlike Azure's
 *   `checkout: self`) already leaves a push-triggered run on the real branch,
 *   not a detached HEAD, so there is nothing to re-attach.
 * - **Tag the run per app**: `##vso[build.addbuildtag]` is an Azure classic
 *   Release-pipeline mechanism with no GitHub Actions equivalent; the `drop`
 *   artifact (one zip per app inside it) is the portable substitute.
 *
 * Auth is a single repository (or environment) secret — `PAT` for an Azure
 * Artifacts feed, or `NPM_TOKEN` (a raw npm automation token) for public npm
 * — GitHub has no "variable group" concept, so unlike the Azure version this
 * needs no CLI-collected name, just a secret the user creates once in the
 * repo settings, read here as `secrets.PAT`/`secrets.NPM_TOKEN`.
 * `permissions: contents: write` is what lets the checkout's own token push
 * the release tag back (no `persistCredentials` step to opt into — GitHub's
 * checkout wires this up from the job's `permissions` automatically).
 *
 * @param agent - The build agent — reused as-is for `runs-on:` (GitHub's
 * hosted runner labels, e.g. `ubuntu-latest`, already match the common Azure
 * vmImage names; anything else is passed through as a self-hosted runner
 * label).
 * @param pythonPublishUrl - The twine upload URL for Python packages, or
 * `undefined` to leave Python publishing unconfigured (public npm).
 * @param registryKind - The workspace's registry kind — selects `PAT` vs
 * `NPM_TOKEN` for the npm-authenticating steps.
 * @returns The full text of `.github/workflows/ci.yml`.
 * @throws Never - performs a pure mapping with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function githubActionsYaml(
  agent: string,
  pythonPublishUrl?: string,
  registryKind: RegistryConfig['kind'] = 'azure-artifacts',
  ci: CiProvider = 'github'
): string {
  const onMain = `github.event_name != 'pull_request' && github.ref_name == 'main'`
  const [npmAuthName, npmAuthValue] = npmAuthEnvVariable(
    registryKind,
    name => `\${{ secrets.${name} }}`
  )
  // Matches releaseConfig(ci)'s own condition exactly — GitHub Release
  // creation (and therefore Nx's own tag push) is only ever on when GitHub
  // Actions is the *only* configured provider; see releaseConfig's remarks.
  const githubReleases = ci === 'github'
  return `name: CI

# Generated by MoNecromanCI. Deliberately thin: Nx builds, 'nx release'
# versions from conventional commits and pushes ONLY a tag to main, and each
# app is packed into dist/drop/<type>-<name>.zip by its own 'package' target.
# The GitHub Actions equivalent of azure-pipelines.yml — see there for the
# fuller rationale; both stay hand-kept in lockstep, there is no shared template.

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  # Lets the release step push the version tag nx release creates back to main,
  # and (github-only provider) create the GitHub Release itself.
  contents: write

jobs:
  ci:
    runs-on: ${agent}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      # Version resolution needs the release tags.
      - run: git fetch --all --prune --tags
        name: Fetch branches and release tags

      - run: git config user.name "github-actions[bot]" && git config user.email "github-actions[bot]@users.noreply.github.com"
        name: Set the git identity used for release tags

      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - run: npm ci
        name: Install dependencies
        env:
          ${npmAuthName}: ${npmAuthValue}

      # Non-blocking: surfaces known-vulnerable dependencies in every CI log
      # without failing the build over an upstream-only advisory nobody here
      # can fix (see NPM_AUDIT_STEP's remarks in overlay.ts for why).
      - run: ${NPM_AUDIT_STEP}
        name: npm audit (non-blocking)

      # Installs the fixed Python toolchain (ruff, pytest, build, twine,
      # pip-audit) — written by 'mnci add' to requirements-dev.txt on the
      # first Python project. Plain pip, no uv/Poetry: portable guard skips
      # cleanly on a workspace with none.
      - run: ${PYTHON_INSTALL_GUARD}
        name: Install Python dependencies (ruff, pytest, build, twine, pip-audit)

      # Editable-installs every Python project into one shared environment, the
      # pip-world counterpart of 'npm install' hoisting every workspace package
      # into one root node_modules — so a project that imports an internal lib
      # (normally vendored only at build time) can resolve that import at
      # lint/test time too. Portable guard skips cleanly on a workspace with none.
      - run: ${PYTHON_WORKSPACE_INSTALL_GUARD}
        name: Install Python project dependencies (editable, workspace-wide)

      # Non-blocking, same reasoning as the npm audit step above. Runs after
      # the workspace-wide install so it scans the workspace's actual
      # dependency set, not just the fixed toolchain.
      - run: ${PIP_AUDIT_GUARD}
        name: pip-audit (non-blocking)

      # Go, if the workspace has any: hosted runners ship the toolchain, so
      # only the module cache and the linter need seeding. Both guards skip
      # cleanly on a workspace with no root go.mod.
      - run: ${GO_MODULE_DOWNLOAD_GUARD}
        name: Download Go module dependencies

      # golangci-lint is what the generated Go lint target actually runs (the
      # plugin's own default is 'go fmt', which only reformats). 'go install'
      # drops it in GOPATH/bin, which is not on PATH by default on a hosted
      # runner — so publish it for every later step in the job.
      - run: ${GOLANGCI_LINT_INSTALL_GUARD}
        name: Install golangci-lint

      - run: ${GO_TOOL_PATH_GITHUB}
        name: Add Go tool bin to PATH

      # Flutter, if the workspace has any. Unlike Python and Go, hosted runners
      # do NOT ship the Flutter SDK, so this installs it (shallow git clone at
      # a pinned tag) and puts it on PATH. All three guards skip cleanly on a
      # workspace with no root pubspec.yaml, and the install also skips when an
      # SDK is already on PATH.
      - run: ${FLUTTER_SDK_INSTALL_GUARD}
        name: Install the Flutter SDK (${FLUTTER_SDK_VERSION})

      - run: ${FLUTTER_TOOL_PATH_GITHUB}
        name: Add the Flutter SDK to PATH

      # One command resolves EVERY Dart dependency, internal and external, for
      # the whole workspace: the projects are pub workspace members, so this
      # writes a single root pubspec.lock they all share.
      - run: ${FLUTTER_PUB_GET_GUARD}
        name: Resolve Dart dependencies (one pub get for the whole workspace)

      # Fails fast, with an unambiguous message, when a stale TypeScript project
      # reference (or another sync generator's drift) was never synced+committed
      # locally — sync.applyChanges (nx.json) only auto-applies interactively, so
      # CI still needs its own explicit, early check rather than surfacing this as
      # a confusing failure buried inside the build step below.
      - run: npx nx sync:check
        name: Verify the workspace is synced (run 'npx nx sync' locally and commit if this fails)

      # One verify for every run (PR and main). Nx cache makes unchanged
      # test/build projects instant.
      - run: npm run lint
        name: Lint

      # Prettier owns ALL formatting in this workspace, so it needs a gate of
      # its own: ESLint is configured for correctness only and deliberately
      # reports nothing about formatting. Without this step the entire
      # formatting opinion is advisory, and a workspace drifts out of
      # compliance with no signal anywhere.
      - run: npm run format:check
        name: Check formatting (run 'npm run format' locally to fix)
      # \`lint\` here also runs any Nx lint targets \`npm run lint\` does not cover —
      # notably Python's ruff (every Python project owns a hand-authored \`lint\`
      # target). For the eslint stack the JS lint runs twice, but Nx caches the
      # repeat instantly.
      - run: npx nx run-many -t lint,test,build
        name: Lint, test and build everything

      # Pack every app into dist/drop/<type>-<name>.zip via each app's 'package'
      # target. Portable guard: skip cleanly when the workspace has no apps yet.
      - run: ${PACK_APPS_GUARD}
        name: Pack all apps (one zip per app -> dist/drop)
        if: \${{ ${onMain} }}

      - uses: actions/upload-artifact@v4
        if: \${{ ${onMain} }}
        with:
          name: drop
          path: dist/drop
          if-no-files-found: ignore

      # Version + tag + publish, in one release, for npm (packages/*) AND Python
      # (python-packages/*) — conventional commits, tag-only push. Portable guard:
      # nx release errors on an empty scope, so skip cleanly when there is nothing
      # to release. When there are Python packages and an Azure feed, twine
      # publish credentials are exported (raw PAT, decoded from the base64 secret).${
        githubReleases
          ? `
      # This provider also creates a per-project GitHub Release (changelog
      # generated from conventional commits since that project's last tag),
      # which is why 'nx release' pushes the tag itself here — see
      # releaseConfig's remarks for why that is safe on this Nx version and
      # why every other provider combination keeps the explicit push step below.`
          : ''
      }
      - run: ${releaseGuard(pythonPublishEnvFragment(pythonPublishUrl))}
        name: Release — version, tag${githubReleases ? ', publish and GitHub Release' : ' and publish'} (npm + Python)
        if: \${{ ${onMain} }}
        env:
          ${npmAuthName}: ${npmAuthValue}${
            githubReleases
              ? `
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}`
              : ''
          }
${
  githubReleases
    ? ''
    : `
      # nx release's own git push (release.git.push) is deliberately left off: it
      # only runs when a remote GitHub/GitLab Release is configured, which this
      # workflow never does, so it would never push the tag the step above just
      # created. Pushed explicitly, unconditionally (a no-op when nothing released)
      # once tagging is guaranteed to have already happened.
      - run: git push origin --tags
        name: Push release tags (nx release's own push never runs without a remote Release configured)
        if: \${{ ${onMain} }}
`
}`
}

/**
 * The `.github/dependabot.yml` written for GitHub-hosted workspaces.
 *
 * @remarks
 * Cheap, high-signal hygiene every generated workspace gets automatically —
 * this very repo shipped without one and GitHub had to flag vulnerabilities
 * after the fact on every push instead of proposing update PRs proactively
 * (see the `fix(deps)` overrides commit). Dependabot is a GitHub-native
 * feature (no app/extension install, unlike Renovate), so it is written only
 * for `github`/`both` workspaces — the same conditional {@link applyOverlay}
 * already uses for `.github/workflows/ci.yml`.
 *
 * Three ecosystems, each on a weekly cadence (batches noise instead of a PR
 * per bump):
 * - `npm` at the workspace root — covers every `packages/*` project, since
 *   `npm ci` installs from the one root lockfile.
 * - `github-actions` at the root — keeps `actions/checkout`, `setup-node`,
 *   etc. patched too (the workflow {@link githubActionsYaml} writes).
 * - `pip`, via `directories` **globs** (`/apps/*`, `/python-packages/*`,
 *   `/libs/*`) rather than one entry per project: Python projects do not
 *   exist yet at `mnci new` time (`add python-*` writes them later), and a
 *   glob that currently matches nothing is not an error — Dependabot simply
 *   finds no manifest there yet. This is written unconditionally (no
 *   Python-project detection here), so it starts covering Python
 *   dependencies automatically the moment the first one is added, with no
 *   `mnci upgrade` needed.
 */
export const DEPENDABOT_CONFIG = `# Generated by MoNecromanCI. Weekly dependency-update PRs so vulnerable or
# stale dependencies surface as a reviewable PR instead of only a push-time
# warning.
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly

  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly

  # Globs, not one entry per project: Python projects are added later via
  # 'mnci add python-*', so this starts covering them automatically the
  # moment the first one exists — a glob matching nothing yet is not an error.
  - package-ecosystem: pip
    directories:
      - "/apps/*"
      - "/python-packages/*"
      - "/libs/*"
    schedule:
      interval: weekly

  # Same glob reasoning as pip above. Dart projects are pub workspace members,
  # so each one declares its own dependencies even though they all resolve
  # through the single root pubspec.lock — hence the per-project directories
  # rather than just "/".
  - package-ecosystem: pub
    directories:
      - "/apps/*"
      - "/packages/*"
      - "/libs/*"
    schedule:
      interval: weekly
`

/**
 * Options for {@link applyOverlay}.
 *
 * @remarks
 * Collected by `mnci new`'s flags or prompts.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface OverlayOptions {
  /** The monorepo workspace name. */
  workspaceName: string
  /** The npm scope for publishable packages (e.g. `@demo`). */
  scope: string
  /** Where publishable packages are released to. */
  registry: RegistryConfig
  /** The CI build agent — a Microsoft-hosted vmImage or a self-hosted pool name. */
  agent: string
  /** The Library variable group holding the base64 npm `PAT` (e.g. `Build`). */
  variableGroup: string
  /** Which CI provider(s) to write a pipeline file for. */
  ci: CiProvider
  /** The stack (TS major, linter, test runner) chosen at `new`. */
  stack: StackConfig
}

/**
 * Files `create-nx-workspace` scaffolds that mnci deliberately replaces.
 *
 * @remarks
 * Each entry duplicates something mnci owns, and leaving it in place is not
 * merely untidy — in the `.prettierrc` case it silently WINS:
 *
 * - **`.prettierrc`** — Nx writes `{ "singleQuote": true }`. Prettier resolves
 *   `.prettierrc` before `.prettierrc.json`, so every option in
 *   {@link PRETTIER_CONFIG} was being ignored in every generated workspace.
 *   Deleting it is what makes mnci's formatting opinion take effect at all.
 * - **`.vscode/`** — `extensions.json` lists the same recommendations the
 *   `<workspace>.code-workspace` file already carries, so VS Code shows the
 *   prompt twice and the two drift apart. mnci owned this file once
 *   (`.vscode/extensions.json`), then moved to the single-file workspace and
 *   never cleaned up the old location.
 *
 * Removal is idempotent and safe on a workspace where they are already gone,
 * which is what makes `mnci upgrade` able to repair an existing workspace.
 */
const NX_SCAFFOLDING_TO_REMOVE = ['.prettierrc', '.vscode'] as const

/**
 * Deletes the `create-nx-workspace` scaffolding mnci replaces.
 *
 * @remarks
 * See {@link NX_SCAFFOLDING_TO_REMOVE} for why each entry has to go. This is
 * the first thing `applyOverlay` deletes rather than overwrites, so
 * `mnci upgrade`'s "review with `git diff`" advice now covers deletions too.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error other than a missing path.
 * @typeParam None - this function has no generic type parameters.
 */
export function removeNxScaffolding(workspaceRoot: string): void {
  for (const entry of NX_SCAFFOLDING_TO_REMOVE) {
    rmSync(join(workspaceRoot, entry), { recursive: true, force: true })
  }
  removeProjectEslintConfigs(workspaceRoot)
}

/**
 * Deletes every per-project ESLint config in the workspace.
 *
 * @remarks
 * An mnci workspace has exactly ONE ESLint config, at the root. `mnci add`
 * already deletes the one its generator just wrote
 * (`removeGeneratedEslintConfig` in `add/shared.ts`), but that only helps
 * projects created from now on.
 *
 * This is the migration path for workspaces generated **before** mnci owned
 * linting, which is the case that matters: they carry a config in every
 * `apps/*`, `libs/*` and `packages/*` directory, and without this an
 * `mnci upgrade` would install the root config while leaving each project
 * still linting itself against its own stale rules — the exact fragmentation
 * the root config exists to end. Verified against a real workspace: an
 * upgrade fixed every root file and left `packages/sdk/eslint.config.mjs`
 * behind until this was added.
 *
 * Only the three conventional project directories are swept, never the whole
 * tree, so a config a user deliberately placed elsewhere is left alone. The
 * root config is never matched — these globs are all one level deep inside a
 * project directory.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error other than a missing path.
 * @typeParam None - this function has no generic type parameters.
 */
export function removeProjectEslintConfigs(workspaceRoot: string): void {
  const matches = globSync('{apps,libs,packages}/*/eslint.config.{js,mjs,cjs,ts,mts,cts}', {
    cwd: workspaceRoot,
  })
  for (const match of matches) {
    rmSync(join(workspaceRoot, match), { force: true })
  }
}

/**
 * Applies MoNecromanCI's opinions on top of a freshly generated workspace.
 *
 * @remarks
 * This is the ONLY file-writing this CLI does — everything else in the
 * workspace is the untouched output of Nx's own generators. Writes: the
 * `nx.json` release patch, `eslint.config.mjs`, `.prettierrc.json`,
 * `.prettierignore`, `.npmrc`, `commitlint.config.mjs`, the husky
 * `commit-msg` hook, the `<workspace>.code-workspace` file and
 * the chosen CI provider's pipeline file(s) — `azure-pipelines.yml` and/or
 * `.github/workflows/ci.yml`, per `options.ci`. It also DELETES the Nx
 * scaffolding it replaces ({@link removeNxScaffolding}). Dependency
 * installation (`husky`, `@commitlint/*`) is the caller's job — it shells out
 * to real `npm install` so versions resolve at generation time instead of
 * being pinned here.
 *
 * @param workspaceRoot - Absolute path to the generated workspace.
 * @param options - The scope, registry, CI agent/variable group and provider chosen.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error raised while reading or writing.
 * @typeParam None - this function has no generic type parameters.
 */
export function applyOverlay(workspaceRoot: string, options: OverlayOptions): void {
  // Patch nx.json with the release opinion, the stack generator defaults, and
  // sync.applyChanges (so a stale TS project reference — e.g. from hand-adding
  // a cross-project import — is fixed automatically on the next build/
  // typecheck, not just flagged with a prompt). Both `nx release` and every
  // later `nx g`/`mnci add` see the generator defaults.
  const nxJsonPath = join(workspaceRoot, 'nx.json')
  const nxJson = readJson<Record<string, unknown>>(nxJsonPath)
  const generators = {
    ...(nxJson.generators as Record<string, unknown> | undefined),
    ...generatorDefaults(options.stack),
  }
  const sync = { ...(nxJson.sync as Record<string, unknown> | undefined), ...SYNC_CONFIG }
  const mnci = { ...(nxJson.mnci as Record<string, unknown> | undefined), ...mnciConfig(options) }
  const patched = withEslintPlugin(withReleaseConfig(nxJson, options.ci))
  writeFileEnsured(nxJsonPath, toJson({ ...patched, generators, sync, mnci }))

  // The preset names the root package a placeholder ('@org/source'); stamp the
  // chosen scope so `add npm-lib` can derive the default import path from it,
  // the curated everyday scripts (each a single cross-platform command, with
  // `lint` bound to the chosen linter), and the dual TS compiler — the alias
  // for `typescript` replaces the plain TS 6 the preset installed, and
  // `@typescript/native` adds the TS 7 `tsc`. The caller's `npm install`
  // materialises them.
  const manifestPath = join(workspaceRoot, 'package.json')
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  const scripts = {
    ...(manifest.scripts as Record<string, string> | undefined),
    ...rootScripts(),
  }
  const existingDevDeps = manifest.devDependencies as Record<string, string> | undefined
  const devDeps = {
    ...existingDevDeps,
    ...TS_COMPILER_DEPENDENCIES,
    // The preset pins `nx` itself; the ESLint plugins must match it exactly.
    ...eslintToolchainDependencies(existingDevDeps?.nx ?? 'latest'),
    prettier: PRETTIER_VERSION,
  }
  writeFileEnsured(
    manifestPath,
    toJson({ ...manifest, name: `${options.scope}/source`, scripts, devDependencies: devDeps })
  )

  writeFileEnsured(join(workspaceRoot, '.npmrc'), npmrcContent(options.registry, options.scope))
  writeFileEnsured(join(workspaceRoot, 'commitlint.config.mjs'), COMMITLINT_CONFIG)
  const hookPath = join(workspaceRoot, '.husky/commit-msg')
  writeFileEnsured(hookPath, COMMIT_MSG_HOOK)
  markExecutable(hookPath)
  // ESLint handles code quality and correctness rules; Prettier handles all
  // formatting (JavaScript Standard Style). ONE ESLint config, at the root —
  // `add` deletes the per-project ones Nx generators write.
  writeFileEnsured(join(workspaceRoot, 'eslint.config.mjs'), ESLINT_CONFIG)
  writeFileEnsured(join(workspaceRoot, '.prettierrc.json'), PRETTIER_CONFIG)
  writeFileEnsured(join(workspaceRoot, '.prettierignore'), PRETTIER_IGNORE)
  removeNxScaffolding(workspaceRoot)
  // VS Code workspace file with folder structure, extensions, and settings. The
  // `tasks` array is read back first and carried through: it is per-project state
  // written by `mnci add`, not overlay-owned, so regenerating it wholesale would
  // wipe every registered build/qa/start task on `mnci upgrade`.
  const codeWorkspacePath = join(workspaceRoot, `${options.workspaceName}.code-workspace`)
  const existing = readCodeWorkspace<{
    tasks?: { version?: string; tasks?: Record<string, unknown>[] }
  }>(codeWorkspacePath)
  writeFileEnsured(codeWorkspacePath, vscodeWorkspace(options.workspaceName, existing?.tasks))
  // Repairs mnci's own past bug rather than tidying: `mnci upgrade` used to pass
  // no `workspaceName` at all, so this write landed on the literal filename
  // `undefined.code-workspace` and the workspace's real one was never refreshed.
  // Any workspace upgraded before that fix still carries the junk file, and only
  // an upgrade can clear it. Guarded on the name so a workspace genuinely called
  // `undefined` does not delete its own file.
  if (options.workspaceName !== 'undefined') {
    rmSync(join(workspaceRoot, 'undefined.code-workspace'), { force: true })
  }
  // Either or both, per the chosen provider — a GitHub-hosted repo can skip
  // the unused Azure file entirely instead of carrying dead CI config.
  const publishUrl = pythonPublishUrl(options.registry)
  if (options.ci === 'azure' || options.ci === 'both') {
    writeFileEnsured(
      join(workspaceRoot, 'azure-pipelines.yml'),
      azurePipelinesYaml(options.agent, options.variableGroup, publishUrl, options.registry.kind)
    )
  }
  if (options.ci === 'github' || options.ci === 'both') {
    writeFileEnsured(
      join(workspaceRoot, '.github/workflows/ci.yml'),
      githubActionsYaml(options.agent, publishUrl, options.registry.kind, options.ci)
    )
    writeFileEnsured(join(workspaceRoot, '.github/dependabot.yml'), DEPENDABOT_CONFIG)
  }
}
