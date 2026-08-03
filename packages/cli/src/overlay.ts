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
/**
 * Which linter (and therefore which formatter) a workspace uses.
 *
 * @remarks
 * `oxlint` is a **hybrid**, not a replacement. oxlint reads JS/TS/JSX/Vue and
 * nothing else, so an oxlint workspace still gets an ESLint config — built from
 * `@mnci/eslint-config`'s `nonJs()` — covering YAML, TOML, Markdown, CSS, HTML,
 * JSON and `@nx/dependency-checks`. Choosing oxlint buys speed on the JS/TS
 * half; it does not buy a workspace where a duplicate key in a CI pipeline goes
 * unreported.
 *
 * The formatter follows the linter rather than being a third choice, because the
 * two are one opinion: `eslint` pairs with Prettier via
 * `@mnci/eslint-config/prettier`, `oxlint` with oxfmt via
 * `@mnci/oxlint-config/oxfmt`. Both are the same seven Standard options, and a
 * test asserts they are equal, so the choice is about speed and toolchain, not
 * about style.
 */
export type LinterChoice = 'eslint' | 'oxlint'

/**
 * The parts of the toolchain a user chooses at `mnci new`.
 *
 * @remarks
 * Two knobs, deliberately. Everything else in an mnci workspace is fixed by the
 * `--preset=ts` premise, and each additional choice multiplies the matrix the
 * e2e has to cover — so a knob earns its place only when neither answer is
 * defensible for everyone. The test runner qualifies (Jest and Vitest are both
 * first-class in Nx) and so does the linter, now that the Rust toolchain is a
 * real alternative rather than an experiment.
 *
 * Persisted into `nx.json`'s `mnci` block, so `mnci upgrade` re-applies the
 * overlay for the stack the workspace actually chose instead of reverting it to
 * the defaults.
 */
export interface StackConfig {
  /** Unit-test runner (both Nx-native for the plugin kinds). */
  testRunner: 'jest' | 'vitest'
  /** Linter and paired formatter. See {@link LinterChoice}. */
  linter: LinterChoice
}

/**
 * The `--yes` / flagless defaults — the current opinionated stack.
 *
 * @remarks
 * Jest: the test runner existing generated repos (and the e2e suite)
 * already assume, so defaulting to it keeps behaviour unchanged when
 * the stack is not chosen explicitly. Linting is always ESLint + Prettier.
 */
export const DEFAULT_STACK: StackConfig = { testRunner: 'jest', linter: 'eslint' }

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
  typescript: 'npm:@typescript/typescript6@^6.0.2'
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
 * The two registry kinds get deliberately **different** files, because the honest
 * answer differs. This replaced a comment-only placeholder that left
 * `npm publish` unable to authenticate in every generated workspace, while the CI
 * dutifully exported a token nothing consumed.
 *
 * **Azure Artifacts: scope routing plus auth.** `@<scope>:registry` sends both
 * resolution *and* `npm publish` of `@<scope>/*` to the feed, because npm prefers
 * a scope's registry over the global one when publishing a scoped package. That
 * makes it real protection — a package named `@<scope>/x` cannot reach npmjs.org
 * by accident. Verified against a real registry rather than read from docs: npm
 * reports `Publishing to <feed>` with only the scope line set.
 *
 * Only the scope is routed, and that is a choice. A global `registry=` would send
 * every install through the feed too, so `npm ci` would need feed auth just to
 * fetch public packages — verified: with only the scope routed, installing a
 * public dependency still succeeds with no token present at all.
 *
 * **Public npm: auth only, no scope routing.** npmjs.org is already the default
 * registry, so a `@<scope>:registry` line pointing there changes nothing — and
 * calling it protection against an accidental public publish would be false,
 * since the public registry *is* the intended target. That specific false claim
 * is why this function is worth reading twice: an earlier version of this file
 * asserted exactly that safety property in the README while emitting no routing
 * line at all, and `overlay.test.ts` asserted the line's absence. Do not
 * reintroduce a protection that the configuration cannot provide.
 *
 * **The one PAT, two encodings.** `_password` takes the base64 value Azure
 * Artifacts' own "Connect to feed" instructions hand you, so it is used as-is.
 * `twine` wants the *raw* token and the release guard decodes it there
 * ({@link releaseGuard}). Easy to get backwards; check before wiring a third
 * protocol.
 *
 * An unset `${PAT}`/`${NODE_AUTH_TOKEN}` does not break anything locally —
 * verified that `npm install` of a public dependency still succeeds with the
 * variable absent, so a developer needs no token to work in the workspace.
 *
 * @param registry - The monorepo's resolved registry configuration.
 * @param scope - The npm scope (e.g. `@demo`), used for the routing line.
 * @returns The full text of the generated `.npmrc`.
 * @throws Never - performs a pure mapping with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function npmrcContent(registry: RegistryConfig, scope: string): string {
  if (registry.kind === 'npm') {
    return `; Publish authentication for the public npm registry.
;
; NODE_AUTH_TOKEN is exported by the generated CI's release step; an unset value
; is harmless locally, so no token is needed for day-to-day work.
//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}

; There is deliberately NO '${scope}:registry' line here. npmjs.org is already
; the default registry, so routing the scope to it would change nothing — and
; presenting that as protection against an accidental public publish would be
; false, because the public registry is the intended target. (An earlier version
; of this file made exactly that claim while emitting no routing line at all.)
; To keep a scoped package off npmjs.org, use a private feed: generate with
; --registry azure-artifacts, which does route the scope.
`
  }

  const feedUrl = registryUrl(registry) as string
  // npm keys per-registry credentials by the URL with the protocol stripped.
  const feedKey = feedUrl.replace(/^https:/, '')
  return `; Publish + resolution routing for this workspace's own scope.
;
; '${scope}:registry' sends BOTH resolution and 'npm publish' of ${scope}/* to the
; feed: npm prefers a scope's registry over the global one when publishing a
; scoped package, so a ${scope}/* package cannot reach npmjs.org by accident.
;
; Only the scope is routed, on purpose. A global 'registry=' would send every
; install through the feed as well, so 'npm ci' would need feed auth just to fetch
; public packages.
${scope}:registry=${feedUrl}

; Feed credentials. PAT is the BASE64 value Azure Artifacts' "Connect to feed"
; instructions give you, which is exactly what _password expects, so it is used
; as-is. (twine wants the RAW token; the CI release step decodes it there.)
; Azure ignores the username, and npm requires an email it never uses.
${feedKey}:username=AzureArtifacts
${feedKey}:_password=\${PAT}
${feedKey}:email=npm-requires-this-and-never-uses-it
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
      preVersionCommand: 'npx nx run-many -t build --projects=packages/*,python-packages/*'
    },
    changelog: githubReleases
      ? {
          workspaceChangelog: false,
          projectChangelogs: { createRelease: 'github', file: false }
        }
      : { workspaceChangelog: false }
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
  options: { targetName: 'lint' }
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
 * The workspace-wide files every project's verification depends on.
 *
 * @remarks
 * `nx affected` walks the project graph, and a root config file is in no
 * project — so without this, changing one marks only the root pseudo-project,
 * which has no `lint`/`typecheck`/`test`/`build` target. Measured on a real
 * workspace before the fix: a PR touching `tsconfig.base.json` alone verified
 * **nothing at all** and reported green.
 *
 * Each entry is a file that can change every project's result:
 * `eslint.config.mjs` is the whole linting opinion, `tsconfig.base.json` is
 * what every project's tsconfig extends, and the root `package.json` holds
 * every devDependency version and the curated scripts.
 *
 * `.prettierrc.json` is deliberately absent: Prettier is not a project target,
 * so the pipeline's `format:check` step runs `prettier --check .` over the whole
 * tree on every run regardless. Listing it would invalidate every project's
 * cache and verify nothing new. `package-lock.json` is absent too — Nx already
 * marks projects affected from lockfile changes through its external-dependency
 * nodes (verified: a lockfile-only edit marks every project).
 */
export const SHARED_GLOBAL_INPUTS = [
  '{workspaceRoot}/eslint.config.mjs',
  '{workspaceRoot}/tsconfig.base.json',
  '{workspaceRoot}/package.json'
] as const

/**
 * Returns a copy of an `nx.json` object whose `sharedGlobals` named input
 * covers the mnci-owned root config files.
 *
 * @remarks
 * Idempotent and additive: entries a workspace already has are kept in place
 * and never duplicated, so `mnci upgrade` can run repeatedly and a workspace
 * that added its own shared globals does not lose them. `sharedGlobals` is
 * referenced by the preset's `default` input, which `production` extends, so
 * one list reaches every target.
 *
 * @param nxJson - The parsed `nx.json`.
 * @returns A new object whose `namedInputs.sharedGlobals` includes every entry
 * of {@link SHARED_GLOBAL_INPUTS}.
 * @throws Never - performs a pure object merge with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function withSharedGlobals(nxJson: Record<string, unknown>): Record<string, unknown> {
  const namedInputs = (nxJson.namedInputs as Record<string, unknown> | undefined) ?? {}
  const existing = (namedInputs.sharedGlobals as unknown[] | undefined) ?? []
  const missing = SHARED_GLOBAL_INPUTS.filter(entry => !existing.includes(entry))
  return {
    ...nxJson,
    namedInputs: { ...namedInputs, sharedGlobals: [...existing, ...missing] }
  }
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
 * The options themselves no longer live here — they live in
 * `@mnci/eslint-config/prettier`, and this file only re-exports them. Lint and
 * format are one opinion, so shipping them as one package means they cannot
 * drift into disagreeing, and a formatting fix reaches an existing workspace
 * through `npm update` rather than needing `mnci upgrade`. The file keeps
 * comments explaining the override path, which is why it is `.mjs` and not JSON.
 *
 * **Written as `.prettierrc.mjs`, and both other candidates are deleted.**
 * Prettier's precedence is `.prettierrc` → `.prettierrc.json` → … →
 * `.prettierrc.mjs`, so a leftover file of either earlier kind wins outright and
 * silently reinstates the old opinion. {@link removeNxScaffolding} therefore
 * removes `.prettierrc` (which `create-nx-workspace` writes as
 * `{ "singleQuote": true }`) **and** `.prettierrc.json` (which mnci itself wrote
 * before this change, so an `mnci upgrade` must clear it). Getting that wrong is
 * not hypothetical: it is exactly the bug that made every option in this file
 * silently ignored in every generated workspace until it was found with
 * `prettier.resolveConfig`.
 *
 * Prettier owns all formatting. The three JavaScript Standard rules Prettier
 * never touches (`spaced-comment`, `lines-between-class-members`,
 * `unicode-bom`) live in `@mnci/eslint-config`'s stylistic block instead.
 * `space-before-function-paren` is deliberately NOT among them: Prettier
 * actively reverses it, so enabling it would make `lint` and `format:check`
 * mutually unsatisfiable.
 */
export const PRETTIER_CONFIG = `// The formatting half of @mnci/eslint-config.
//
// Prettier's options live in the same package as the ESLint rules on purpose:
// linting and formatting are one decision. \`eslint-config-prettier\` is composed
// last inside that package so every formatting rule defers to these settings, and
// splitting the two across packages means a version pair that can drift until
// \`npm run lint\` and \`npm run format:check\` disagree with each other.
//
// Consuming it as a shareable config also means a formatting fix reaches this
// workspace through \`npm update\`, the same way a rule change does, instead of
// waiting for \`mnci upgrade\` to rewrite a file.
//
// TO OVERRIDE an option, spread it rather than re-exporting:
//
//   import mnci from '@mnci/eslint-config/prettier'
//   export default { ...mnci, printWidth: 120 }
//
// TO SEE the resolved options for a file:  npx prettier --find-config-path <file>
export { default } from '@mnci/eslint-config/prettier'
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
 *
 * ESLint **10**. What held the stack at 9 was never ESLint — it was
 * `eslint-plugin-react`, which has no 10 release at all and has since been
 * replaced by `@eslint-react/eslint-plugin`. See
 * {@link ESLINT_PEER_OVERRIDES} for the one holdout that remains.
 */
export const ESLINT_VERSION = '^10.8.0'

/**
 * The `.devcontainer/devcontainer.json` written into generated workspaces.
 *
 * @remarks
 * mnci's toolchain matrix is Node + Python + Go + Flutter, and until this existed
 * only **CI** had all four: the pipeline installs the Flutter SDK itself and
 * assumes CPython and Go are on the agent, while locally a contributor was on
 * their own. A devcontainer is what makes the local environment the same one CI
 * verifies, which is the whole "just works" promise applied to development rather
 * than to the build.
 *
 * Four decisions worth keeping:
 *
 * - **The Node major comes from {@link NODE_VERSION}**, the same constant the
 *   workflow's `setup-node` step reads. Hardcoding it twice is exactly the drift
 *   this file is supposed to remove.
 * - **`postCreateCommand` reuses the pipeline's own guards** rather than
 *   reimplementing them — {@link PYTHON_INSTALL_GUARD} and friends via the
 *   `python:install` root script, plus the same `golangci-lint` and Flutter SDK
 *   one-liners the pipelines run. Each is already idempotent and already
 *   no-ops when the workspace has no project of that kind (no `go.mod`, no
 *   `pubspec.yaml`), so a JS-only workspace pays almost nothing and a polyglot
 *   one gets exactly what CI gets. Reimplementing them would create a third
 *   copy to keep in sync.
 * - **Go and Python arrive as devcontainer *features*, not as a custom image.**
 *   A Dockerfile would be a second thing to maintain against upstream, and
 *   features are the mechanism the ecosystem maintains for precisely this.
 * - **Flutter is NOT a feature**, because no maintained one exists — the same
 *   reason `@mnci/nx-flutter` had to be written. The SDK guard clones a pinned
 *   tag into the home directory, which is what CI does, so the version matches
 *   by construction.
 *
 * @param workspaceName - The workspace name, used as the container's label.
 * @returns The JSON string for `.devcontainer/devcontainer.json`.
 * @throws Never - performs pure string formatting with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function devcontainerJson(workspaceName: string, linter: LinterChoice): string {
  return `${toJson({
    name: workspaceName,
    image: `mcr.microsoft.com/devcontainers/typescript-node:${NODE_VERSION}-bookworm`,
    features: {
      'ghcr.io/devcontainers/features/python:1': { version: '3.12' },
      'ghcr.io/devcontainers/features/go:1': { version: 'latest' }
    },
    // `npm ci` first: every guard after it runs through the workspace's own
    // scripts and Nx, which do not exist until the install completes.
    postCreateCommand: [
      'npm ci',
      'npm run python:install',
      GOLANGCI_LINT_INSTALL_GUARD,
      FLUTTER_SDK_INSTALL_GUARD
    ].join(' && '),
    // The same recommendations the `.code-workspace` file carries, so opening
    // the folder in a container suggests the identical toolset.
    customizations: {
      vscode: { extensions: vscodeExtensions(linter) }
    }
  })}\n`
}

/**
 * The `lint` target mnci puts on a generated workspace's ROOT project.
 *
 * @remarks
 * Without it, root-level files are linted by **nothing**. `npm run lint` is
 * `nx run-many -t lint`, and every other `lint` target belongs to a project and
 * runs `eslint .` with that project as its cwd — so `.github/workflows/*.yml`,
 * `azure-pipelines.yml`, the root JSON and Markdown, `eslint.config.mjs` and
 * `commitlint.config.mjs` were covered by no target at all.
 *
 * **The ignore patterns are CLI flags on purpose, not config `ignores`.** In flat
 * config, `ignores` are relative to the config file, and every project's `lint`
 * resolves this same root `eslint.config.mjs` — so ignoring `packages/**` there
 * would switch linting off *inside* the packages too. A CLI flag applies to this
 * invocation alone. Each project already lints its own tree, so this target adds
 * coverage rather than duplicating it.
 *
 * `includedScripts: []` goes alongside it, and is load-bearing: the root manifest's
 * scripts are the `nx run-many` aggregators, so letting Nx infer targets from them
 * would make `lint` invoke `nx run-many -t lint` — itself.
 */
export const ROOT_LINT_TARGET = {
  executor: 'nx:run-commands',
  cache: true,
  options: {
    command: [
      'eslint .',
      '--ignore-pattern "apps/**"',
      '--ignore-pattern "libs/**"',
      '--ignore-pattern "packages/**"',
      '--ignore-pattern "python-packages/**"',
      '--ignore-pattern package-lock.json'
    ].join(' '),
    cwd: '.'
  }
} as const

/**
 * npm `overrides` a generated workspace needs for its ESLint toolchain to install.
 *
 * @remarks
 * `eslint-plugin-jsx-a11y@6.10.2` — the latest release — peers on
 * `eslint: ^3 … ^9`, so `npm install` fails outright with `ERESOLVE` on ESLint
 * 10. That cap is **stale rather than real**, and this was measured, not
 * assumed: with this override in place on `eslint@10.8.0`, the plugin installs
 * and its rules work — a missing `alt` reports `jsx-a11y/alt-text`, and
 * `alt="a picture"` reports `img-redundant-alt`.
 *
 * `overrides` has to live in the **root** manifest; npm ignores it anywhere
 * else, which is why a config package cannot carry its own fix and mnci writes
 * this instead. `$eslint` resolves to the workspace's own `eslint` spec, so the
 * override never pins a version of its own.
 *
 * The trade, stated rather than glossed: mnci deleted `legacy-peer-deps` from
 * the generated `.npmrc` precisely for weakening dependency resolution. This is
 * far narrower — one named package, one peer, with evidence that the real
 * constraint is satisfied — but it is the same kind of decision, so it should
 * be removed the moment `jsx-a11y` ships a release declaring ESLint 10.
 */
export const ESLINT_PEER_OVERRIDES = {
  'eslint-plugin-jsx-a11y': { eslint: '$eslint' }
} as const

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
    // Declared rather than left to hoisting. `@mnci/eslint-config` depends on
    // prettier, so `npx prettier` works either way — but the VS Code extension
    // resolves prettier from the PROJECT's dependencies and silently falls back
    // to its own bundled copy when it finds none. A workspace should declare the
    // formatter it formats with instead of relying on npm flattening someone
    // else's transitive dependency to the root.
    prettier: PRETTIER_VERSION
  }
}

/**
 * The root `lint` target for one linter choice.
 *
 * @remarks
 * **This is what actually runs oxlint.** Nothing else does, and that gap is worth
 * spelling out because it is invisible: an oxlint workspace can have a valid
 * `oxlint.config.ts`, a green `npm run lint`, and never invoke oxlint once —
 * every per-project `lint` target comes from `@nx/eslint/plugin` and runs ESLint
 * alone. A first pass shipped exactly that, and the e2e assertion "lint runs
 * green" passed while verifying nothing about the JS/TS half.
 *
 * So under oxlint the root target runs both, in the order they matter:
 *
 * 1. `oxlint .` over the **whole** workspace. Unlike ESLint's root invocation
 *    this is deliberately not scoped away from `apps/`, `libs/` and `packages/`:
 *    oxlint is designed to sweep a repo in one pass, and no per-project target
 *    covers it, so scoping here would leave JS/TS linted by nothing.
 * 2. `eslint .` on root files only, exactly as the eslint path does — the
 *    per-project ESLint targets already cover the project trees.
 *
 * `parallel: false` so a failure names which linter failed rather than
 * interleaving two outputs.
 *
 * @param linter - The workspace's linter choice.
 * @returns The `lint` target for the root project.
 * @throws Never - performs pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
export function rootLintTarget(linter: LinterChoice): Record<string, unknown> {
  if (linter !== 'oxlint') return ROOT_LINT_TARGET
  return {
    executor: 'nx:run-commands',
    cache: true,
    options: {
      commands: ['oxlint .', ROOT_LINT_TARGET.options.command],
      parallel: false,
      cwd: '.'
    }
  }
}

/**
 * The `oxlint` version generated workspaces declare.
 *
 * @remarks
 * Declared by the workspace because `@mnci/oxlint-config` peers on it, the same
 * arrangement `eslint` has — the config cannot pick the binary's version for you.
 */
export const OXLINT_VERSION = '^1.76.0'

/**
 * The `oxfmt` version generated workspaces declare.
 *
 * @remarks
 * Pre-1.0, and pinned by caret deliberately: it is the one part of the oxlint
 * stack whose output could change between minors, and a test diffs it against
 * Prettier so a drift is reported rather than silently reformatting a repo.
 */
export const OXFMT_VERSION = '^0.61.0'

/**
 * The extra dependencies an **oxlint** workspace needs on top of the ESLint set.
 *
 * @remarks
 * On top of, not instead of: the hybrid keeps ESLint for the file types oxlint
 * cannot parse, so `eslintToolchainDependencies` still applies in full.
 *
 * `oxlint` is a peer of `@mnci/oxlint-config` rather than a dependency, so the
 * workspace has to declare it — the same reason `eslint` is declared. `oxfmt` is
 * declared for the reason `prettier` is: the editor extension resolves the
 * formatter from the project, not from a transitive dependency.
 *
 * @returns The oxlint-specific devDependencies.
 * @throws Never - returns a literal.
 * @typeParam None - this function has no generic type parameters.
 */
export function oxlintToolchainDependencies(): Record<string, string> {
  return {
    '@mnci/oxlint-config': oxlintConfigSpec(),
    oxlint: OXLINT_VERSION,
    oxfmt: OXFMT_VERSION
  }
}

/**
 * The `@mnci/oxlint-config` version generated workspaces depend on.
 *
 * @remarks
 * A caret range, so `npm update` carries rule fixes into existing workspaces
 * without an `mnci upgrade` — the same reason the ESLint config ships as a
 * package rather than as a template string.
 */
export const OXLINT_CONFIG_VERSION = '^0.1.0'

/**
 * The `@mnci/oxlint-config` spec to write into a generated workspace's manifest.
 *
 * @remarks
 * Reads `MNCI_OXLINT_CONFIG_SPEC` so the e2e can point this at a locally packed
 * tarball instead of the registry, the same escape hatch
 * {@link eslintConfigSpec} uses — without it, `npm install` in a freshly
 * generated oxlint workspace 404s until the package has been published once.
 *
 * @returns The dependency spec (a semver range, or a path/URL when overridden).
 * @throws Never - reads an environment variable.
 * @typeParam None - this function has no generic type parameters.
 */
export function oxlintConfigSpec(): string {
  return process.env.MNCI_OXLINT_CONFIG_SPEC ?? OXLINT_CONFIG_VERSION
}

/**
 * The block-by-block inventory written into the generated `eslint.config.mjs`.
 *
 * @remarks
 * Moving every rule into `@mnci/eslint-config` bought a generated workspace one
 * root config and cost it discoverability: a three-line file gives no hint that
 * twenty tools are behind it, and someone looking at a rule they disagree with
 * has nothing to grep. This names each block, what supplies it, and what it
 * covers — keyed by the `name` every block carries, which is what
 * `eslint --inspect-config` reports and what an override targets.
 *
 * **It is not free text.** A test in `overlay.test.ts` resolves the real config
 * and fails if a name here is missing from it, or if a block in it is missing
 * here. A stale inventory is worse than none, since it sends the reader to a
 * block that no longer exists — and nothing about generating a workspace would
 * notice.
 *
 * A separate constant from {@link ESLINT_CONFIG} so that test can pull the
 * `mnci/…` names out of it without also matching the override example further
 * down, which names a `local/…` block that deliberately does not exist.
 *
 * Some entries end in `*`, and that is deliberate rather than lazy:
 * `mnci/yaml/recommended` and `mnci/toml/base` are multi-block upstream presets,
 * and `mnci/typescript`/`mnci/type-aware` each carry a `/declarations` sibling.
 * How many blocks those split into is not a user-facing fact, so enumerating
 * them here would make the table fail on an upstream release that changes
 * nothing anyone cares about.
 */
export const ESLINT_BLOCK_INVENTORY = `// WHAT IS IN HERE. Each line is one config block, by the \`name\` it carries.
//
//   mnci/ignores                  paths never linted (dist, coverage, .venv, …)
//   mnci/base                     JS/TS correctness — @eslint/js, eslint-plugin-unicorn,
//                                 -promise, -n, -unused-imports
//   typescript-eslint/*           typescript-eslint's own recommended blocks
//   mnci/typescript*              TS rules on top of them, no type information needed
//   mnci/type-aware*              the rules that DO read types (no-floating-promises and
//                                 friends), scoped to {apps,libs,packages}/*/src
//   mnci/import-graph             import cycles — eslint-plugin-import-x
//   mnci/react                    JSX/TSX — @eslint-react/eslint-plugin,
//                                 eslint-plugin-react-hooks, -react-refresh, -jsx-a11y
//   mnci/regexp*                  regex correctness — eslint-plugin-regexp
//   mnci/json  mnci/jsonc  mnci/json5
//                                 eslint-plugin-jsonc — comments are allowed in .jsonc
//                                 and tsconfig.json, forbidden in plain .json
//   mnci/yaml*                    eslint-plugin-yml — your CI pipeline files
//   mnci/toml/base*               eslint-plugin-toml, PARSER ONLY: a malformed
//                                 pyproject.toml is a syntax error, nothing is styled
//   mnci/markdown                 @eslint/markdown
//   mnci/css                      @eslint/css
//   mnci/html                     @html-eslint/eslint-plugin
//   mnci/tests                    *.spec/*.test relaxations — eslint-plugin-jest
//                                 (Vitest's globals too; the two stacks share them)
//   mnci/nx-dependency-checks     @nx/eslint-plugin, on publishable packages' manifests
//   mnci/prettier-compat          eslint-config-prettier — switches off every rule
//                                 Prettier owns. Composed LAST, on purpose.
//   mnci/stylistic                the 3 Standard rules Prettier does not touch
//
// To list them as ESLint actually resolves them:  npx eslint --inspect-config
`

/**
 * The root `eslint.config.mjs` written into generated workspaces.
 *
 * @remarks
 * ESLint config is an mnci-owned file as of this change; it previously was not
 * owned at all, so workspaces silently kept `create-nx-workspace`'s bare
 * `@nx/eslint-plugin` default while the richer rules lived only in mnci's own
 * repo.
 *
 * Deliberately one import: every rule lives in `@mnci/eslint-config`, so the
 * twenty-odd plugins are that package's dependencies instead of twenty-odd
 * devDependencies in every generated workspace.
 *
 * `workspaceRoot` enables the `@nx/dependency-checks` block for `packages/*`
 * and `libs/*` — it has to scan for `private: true` manifests, which is why it
 * needs the path rather than deriving one.
 *
 * Everything else in the file is comment: {@link ESLINT_BLOCK_INVENTORY}, then
 * the override recipe. Both are there because the alternative to documenting a
 * three-line config is a user editing `node_modules`.
 */
export const ESLINT_CONFIG = `import mnci from '@mnci/eslint-config'

${ESLINT_BLOCK_INVENTORY}//
// TO OVERRIDE a rule, append a block AFTER the spread — later blocks win, so one
// of your own beats anything above it. Give it a name, so the inspector shows
// where the change came from:
//
//   export default [
//     ...mnci({ workspaceRoot: import.meta.dirname }),
//     {
//       name: 'local/legacy-app-allows-any',
//       files: ['apps/legacy/**/*.ts'],
//       rules: { '@typescript-eslint/no-explicit-any': 'off' }
//     }
//   ]
//
// Do NOT edit @mnci/eslint-config inside node_modules, and do not fork it: it is
// a dependency, so \`npm update\` brings rule fixes in the way it brings any
// other. An override here survives that; an edit to the package does not.
//
// One override cannot work, and it is the one people reach for first:
// \`space-before-function-paren\`. Prettier rewrites \`f (a)\` to \`f(a)\` on every
// run, so switching that rule on makes \`npm run lint\` and \`npm run format:check\`
// impossible to satisfy at the same time. Formatting lives in .prettierrc.mjs.
export default mnci({ workspaceRoot: import.meta.dirname })
`

/**
 * The root `eslint.config.mjs` for an **oxlint** workspace.
 *
 * @remarks
 * The hybrid's ESLint half. oxlint reads JS/TS/JSX/Vue and nothing else, so
 * without this a workspace that chose oxlint would lint its CI YAML, its
 * `pyproject.toml`, its Markdown, CSS, HTML and JSON with nothing at all — and
 * would lose `@nx/dependency-checks`, the only thing stopping a publishable
 * package's manifest from declaring the wrong dependencies.
 *
 * `nonJs()` composes exactly those blocks from the same modules the full config
 * uses, so a rule added to `configs/yaml.js` reaches both modes.
 */
export const ESLINT_CONFIG_NON_JS = `import { nonJs } from '@mnci/eslint-config'

// This workspace lints JS/TS with oxlint (see oxlint.config.ts). ESLint keeps
// the file types oxlint cannot parse at all — YAML, TOML, Markdown, CSS, HTML,
// JSON — plus @nx/dependency-checks on publishable manifests.
//
// The JS/TS rule blocks are deliberately NOT composed here. Running both linters
// over the same file would report one defect twice under two different names.
//
// TO OVERRIDE, append a named block after the spread, exactly as the full config
// documents. To change a JS/TS rule, edit oxlint.config.ts instead — this file
// does not lint JS/TS.
export default [...nonJs({ workspaceRoot: import.meta.dirname })]
`

/**
 * The root `oxlint.config.ts` written into oxlint workspaces.
 *
 * @remarks
 * `oxlint.config.ts`, not `.oxlintrc.json`, and that is forced rather than
 * preferred: `.oxlintrc`'s `extends` takes **paths** resolved relative to the
 * config file, so `extends: ["@mnci/oxlint-config"]` fails with
 * `No such file or directory`. `defineConfig` is the only shareable-config route
 * oxlint offers. Verified both ways.
 */
export const OXLINT_CONFIG = `import { defineConfig } from 'oxlint'
import mnci from '@mnci/oxlint-config'

// oxlint owns JS/TS/JSX here; eslint.config.mjs keeps everything oxlint cannot
// parse. The contract @mnci/oxlint-config holds itself to: anything
// @mnci/eslint-config accepts must pass oxlint, so switching linters never turns
// a green codebase red.
//
// oxlint.config.ts, not .oxlintrc.json, and that is not a preference: .oxlintrc's
// \`extends\` takes PATHS relative to the config file, so
// \`extends: ["@mnci/oxlint-config"]\` fails with "No such file or directory".
// defineConfig is the only shareable-config route oxlint offers.
//
// Type-aware rules (no-floating-promises and friends) are opt-in — pass
// { typeAware: true } AND run oxlint with --type-aware. They report findings the
// ESLint stack accepts, so they are off by default to keep the contract above.
export default defineConfig({ extends: [mnci()] })
`

/**
 * The `.oxfmtrc.json` written into oxlint workspaces.
 *
 * @remarks
 * Inlined rather than re-exported from `@mnci/oxlint-config/oxfmt`, unlike the
 * Prettier config's `.prettierrc.mjs`. oxfmt's config is JSON only — it has no
 * `.mjs` form to import a package from — so the options are duplicated here and
 * `tests/oxfmt.spec.ts` asserts the package's option set equals the ESLint
 * package's, which is what keeps all three in step.
 *
 * The `$schema` entry is what gives an editor completion and validation on the
 * file, and costs nothing.
 */
export const OXFMT_CONFIG = `${JSON.stringify(
  {
    $schema: './node_modules/oxfmt/configuration_schema.json',
    semi: false,
    singleQuote: true,
    trailingComma: 'none',
    arrowParens: 'avoid',
    printWidth: 100,
    tabWidth: 2,
    useTabs: false
  },
  null,
  2
)}\n`

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
 * The editor extensions both the `.code-workspace` file and the devcontainer
 * recommend.
 *
 * @remarks
 * Shared so the two cannot drift: opening the workspace in a container should
 * suggest the same toolset as opening it directly.
 */
export const VSCODE_RECOMMENDED_EXTENSIONS = [
  'dbaeumer.vscode-eslint',
  'esbenp.prettier-vscode',
  'nrwl.angular-console',
  'firsttris.vscode-jest-runner'
] as const

/**
 * The editor extensions that depend on which linter the workspace chose.
 *
 * @remarks
 * **`oxc.oxc-vscode` is one extension covering both halves of the Rust
 * toolchain** — it provides oxlint *and* oxfmt integration, verified on the
 * Marketplace rather than assumed, so an oxlint workspace needs no separate
 * formatter extension and `esbenp.prettier-vscode` is correctly absent.
 *
 * **`dbaeumer.vscode-eslint` stays in BOTH lists, and that is the hybrid
 * showing through.** Choosing oxlint does not remove ESLint from the workspace:
 * oxlint cannot parse YAML, TOML, Markdown, CSS, HTML or JSON, so
 * `@mnci/eslint-config`'s `nonJs()` keeps covering those (plus
 * `@nx/dependency-checks` on publishable manifests). Dropping the ESLint
 * extension would leave a contributor editing `azure-pipelines.yml` with no
 * in-editor feedback from a linter that *is* running in CI — the worst kind of
 * gap, because the file still fails the build.
 */
export const LINTER_EXTENSIONS = {
  eslint: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'],
  oxlint: ['oxc.oxc-vscode', 'dbaeumer.vscode-eslint']
} as const

/**
 * Extensions every workspace gets, whichever linter it chose.
 *
 * @remarks
 * Nx's console and a test-runner integration: neither depends on the lint
 * toolchain, so they are factored out rather than repeated in both lists, where
 * one of the two copies would eventually be the stale one.
 */
export const SHARED_VSCODE_EXTENSIONS = [
  'nrwl.angular-console',
  'firsttris.vscode-jest-runner'
] as const

/**
 * Every language whose formatter mnci pins explicitly.
 *
 * @remarks
 * Not a convenience list — see {@link vscodeSettings} for why the general
 * `editor.defaultFormatter` cannot be relied on. The set is "everything the
 * chosen formatter actually handles": both Prettier and oxfmt format all of
 * these, verified byte-identical on JSON/YAML/Markdown/CSS/TS samples when
 * oxfmt was adopted.
 *
 * `typescript` and `typescriptreact` are the two that matter most and were the
 * two missing.
 */
export const FORMATTED_LANGUAGES = [
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
  'json',
  'jsonc',
  'yaml',
  'markdown',
  'css'
] as const

/**
 * The extension list for one linter choice.
 *
 * @remarks
 * The single source both the `.code-workspace` file and the devcontainer read,
 * so opening the workspace in a container cannot suggest a different toolset
 * from opening it directly — the reason the list was shared in the first place,
 * now that there are two of them to keep straight.
 *
 * @param linter - The workspace's linter choice.
 * @returns The recommended extension IDs, linter-specific ones first.
 * @throws Never - performs a pure lookup.
 * @typeParam None - this function has no generic type parameters.
 */
export function vscodeExtensions(linter: LinterChoice): string[] {
  return [...LINTER_EXTENSIONS[linter], ...SHARED_VSCODE_EXTENSIONS]
}

/**
 * The editor settings that depend on the linter choice.
 *
 * @remarks
 * Two things change together, and they have to: which extension formats, and
 * which languages ESLint is asked to validate.
 *
 * `eslint.validate` is narrowed for oxlint to exactly the languages ESLint still
 * owns there. Leaving JS/TS in that list would ask the ESLint extension to
 * validate files whose config has no rules for them — reporting nothing, but
 * spending a language-server round trip per keystroke to do it, and telling the
 * reader that ESLint covers JS when it does not.
 *
 * @param linter - The workspace's linter choice.
 * @returns The `settings` block for the `.code-workspace` file.
 * @throws Never - performs pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
export function vscodeSettings(linter: LinterChoice): Record<string, unknown> {
  const formatter = linter === 'oxlint' ? 'oxc.oxc-vscode' : 'esbenp.prettier-vscode'
  const eslintLanguages =
    linter === 'oxlint'
      ? ['json', 'jsonc', 'markdown', 'yaml', 'html', 'css']
      : [
          'javascript',
          'javascriptreact',
          'typescript',
          'typescriptreact',
          'json',
          'jsonc',
          'markdown',
          'yaml'
        ]

  return {
    'eslint.validate': eslintLanguages,
    'editor.codeActionsOnSave': {
      'source.fixAll.eslint': 'explicit'
    },
    'editor.defaultFormatter': formatter,
    'editor.formatOnSave': true,
    // Every language spelled out, and the global default above is NOT enough on
    // its own — which is the bug this fixes rather than a belt-and-braces habit.
    //
    // VS Code resolves a language-specific setting ahead of a general one, and it
    // does that comparison BEFORE scope. So a `[typescript]` block in someone's
    // USER settings — left over from any other project — outranks this file's
    // workspace-level `editor.defaultFormatter`, and format-on-save quietly uses
    // that other formatter instead. Nothing reports it: Prettier is installed,
    // the config resolves, `npm run format:check` still finds the 68 unformatted
    // files, and the editor simply never applies it.
    //
    // Reported from a real workspace where `.ts` files were not being formatted
    // while `.json`/`.jsonc`/`.yaml` were — exactly the three that had explicit
    // entries here and nothing else did.
    ...Object.fromEntries(
      FORMATTED_LANGUAGES.map(language => [
        `[${language}]`,
        { 'editor.defaultFormatter': formatter }
      ])
    )
  }
}

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
  linter: LinterChoice,
  existingTasks?: { version?: string; tasks?: Record<string, unknown>[] }
): string {
  return JSON.stringify(
    {
      folders: [{ path: '.', name: workspaceName }],
      settings: vscodeSettings(linter),
      extensions: { recommendations: vscodeExtensions(linter) },
      tasks: {
        version: existingTasks?.version ?? '2.0.0',
        tasks: existingTasks?.tasks ?? []
      }
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
 *
 * `typecheck` is its own script because nothing else type-checks. Under
 * `--preset=ts` the `@nx/js/typescript` plugin infers a `typecheck` target for
 * every project, but a bundler-built project's `build` does not type-check at
 * all — esbuild and swc strip types without reading them. So a workspace can
 * build, test and lint green while carrying real type errors, which is exactly
 * what happened in mnci's own repo: `mnci upgrade` shipped a bug that
 * TypeScript had already flagged, because CI never ran this.
 */
export const ROOT_SCRIPTS = {
  build: 'nx run-many -t build',
  lint: 'nx run-many -t lint',
  test: 'nx run-many -t test',
  typecheck: 'nx run-many -t typecheck',
  affected: 'nx affected -t lint,typecheck,test,build',
  graph: 'nx graph',
  'release:preview': 'nx release --dry-run',
  prepare: 'husky'
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
export function rootScripts(linter: LinterChoice = 'eslint'): Record<string, string> {
  // oxfmt reads `.gitignore` and `.prettierignore` by default, so the same
  // `.prettierignore` mnci already writes governs both formatters and there is no
  // second ignore file to keep in sync. Verified against oxfmt's own CLI docs.
  const formatter = linter === 'oxlint' ? 'oxfmt' : 'prettier'
  return {
    ...ROOT_SCRIPTS,
    format: linter === 'oxlint' ? 'oxfmt .' : 'prettier --write .',
    'format:check': `${formatter} --check .`,
    'python:install': `${PYTHON_INSTALL_GUARD} && ${PYTHON_WORKSPACE_INSTALL_GUARD}`
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
    unitTestRunner: stack.testRunner
  }
  return {
    '@nx/react:application': shared,
    '@nx/react:library': shared,
    '@nx/js:library': shared
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
    stack: { testRunner: options.stack.testRunner, linter: options.stack.linter }
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
 * The Node major a generated workspace is built and tested against.
 *
 * @remarks
 * Read by both the GitHub workflow's `setup-node` step and the devcontainer's
 * base image, so the environment a contributor develops in cannot silently
 * diverge from the one CI verifies. That drift is the whole reason
 * {@link devcontainerJson} exists, so it must not be reintroduced by hardcoding
 * the number twice.
 *
 * Azure deliberately does not pin it: its pipeline uses whatever Node the agent
 * image ships, which is the existing behaviour and outside this change's scope.
 */
export const NODE_VERSION = '24'

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
 * The Nx targets every CI run verifies.
 *
 * @remarks
 * `typecheck` is not covered by `build`: a bundler-built project (esbuild, swc)
 * strips types without reading them, so a workspace can be green on
 * lint+test+build while carrying real type errors.
 */
const VERIFY_TARGETS = 'lint,typecheck,test,build'

/**
 * The portable `node -e` one-liner that verifies the workspace: only the
 * **affected** projects on a pull request, **every** project otherwise.
 *
 * @remarks
 * Shared bit-for-bit by {@link azurePipelinesYaml} and {@link githubActionsYaml},
 * which matters more here than for the other guards: the two providers detect a
 * pull request through different environment variables, and a mechanism that
 * drifted would change *what CI verifies* rather than merely how it is spelled.
 *
 * **Every failure path falls back to `run-many`, never to nothing.** That is the
 * whole safety design, and it is deliberate rather than defensive habit. Getting
 * the base *too wide* costs a few minutes; getting it *too narrow* means CI runs
 * almost nothing, passes green, and has verified nothing — a silently weakened
 * gate, which is far worse than a slow one. So a missing target ref, an
 * unresolvable merge-base (a shallow clone, a missing remote branch) and a
 * non-PR run all take the full path.
 *
 * `main` needs no special case for the same reason: neither provider sets a
 * pull-request target branch on a push, so a release run always verifies
 * everything before publishing. That falls out of the fallback rather than being
 * a second condition to keep in step.
 *
 * The base is a real `git merge-base`, not the provider's "base SHA" field. Both
 * providers expose something base-ish, but those drift once the target branch
 * moves ahead of where the PR started, and a merge-base is correct in both by
 * construction — one mechanism instead of two.
 *
 * It resolves the merge-base against `origin/<target>` first and, only if that
 * ref is absent, **fetches the target branch once** and retries against
 * `FETCH_HEAD`. Both providers are configured for a full-depth clone, so
 * `origin/<target>` is normally there — but if it ever is not, the bare fallback
 * would make every run take the full path while still reporting success, so this
 * step would look like it worked and verify nothing selectively, forever. One
 * fetch is a cheap way to not depend on that.
 *
 * Uses a plain string `replace` rather than a regex for the `refs/heads/` prefix
 * (Azure sends the full ref, GitHub the bare branch name): this whole command
 * has to survive quoting under both `cmd.exe` and POSIX `sh`, and a regex
 * literal would drag backslashes into that.
 */
const AFFECTED_OR_ALL_GUARD = `node -e "const cp=require('node:child_process');const T='${VERIFY_TARGETS}';const all=()=>process.exit(cp.spawnSync('npx nx run-many -t '+T,{stdio:'inherit',shell:true}).status ?? 1);const ref=process.env.GITHUB_BASE_REF||process.env.SYSTEM_PULLREQUEST_TARGETBRANCH||'';if(!ref){console.log('Not a pull request - verifying EVERY project.');all()}const target=ref.replace('refs/heads/','');const mergeBase=r=>{const o=cp.spawnSync('git',['merge-base',r,'HEAD'],{encoding:'utf8'});return o.status===0?o.stdout.trim():''};let base=mergeBase('origin/'+target);if(!base){console.log('No origin/'+target+' ref - fetching it to resolve a merge-base.');cp.spawnSync('git',['fetch','--no-tags','origin',target],{stdio:'inherit'});base=mergeBase('FETCH_HEAD')}if(!base){console.log('Could not resolve a merge-base with '+target+' - verifying EVERY project.');all()}console.log('Pull request against '+target+' - verifying projects affected since '+base);process.exit(cp.spawnSync('npx nx affected -t '+T+' --base='+base,{stdio:'inherit',shell:true}).status ?? 1)"`

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
  return /^(?:ubuntu|windows|macos)-/i.test(agent) ? `  vmImage: ${agent}` : `  name: ${agent}`
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
  # While a run is in progress, queue further pushes and run them together rather
  # than concurrently. This is the closest thing Azure Pipelines YAML has to
  # GitHub's concurrency group, and it is load-bearing on main for the same
  # reason: two concurrent 'nx release' runs would race to create the same tag.
  batch: true
  branches:
    include: [main]

# Note: cancelling a superseded PR validation run is NOT a YAML setting on Azure
# — it lives in the branch policy ("Build validation -> automatically cancel").
# Nothing here can express it, so it is left to whoever configures the policy
# rather than faked with a batch setting that would only delay PR runs.
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
  # Relocates npm's cache inside the pipeline workspace so Cache@2 can restore it
  # (the default ~/.npm is outside the cacheable area on hosted agents). npm reads
  # this as an ordinary env var, so it needs no config file and works on every
  # agent OS.
  - name: npm_config_cache
    value: $(Pipeline.Workspace)/.npm

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

  # The Azure counterpart of \`cache: npm\` on actions/setup-node: restores npm's
  # download cache so \`npm ci\` does not re-fetch every tarball on every run.
  # Keyed on the lockfile, so a dependency change misses and anything else hits;
  # restoreKeys falls back to the newest cache for this OS on a miss, which still
  # avoids a fully cold install. Agent.OS is in the key because a cached native
  # module built for one OS is not reusable on another.
  - task: Cache@2
    displayName: Cache npm packages
    inputs:
      key: 'npm | "$(Agent.OS)" | package-lock.json'
      restoreKeys: |
        npm | "$(Agent.OS)"
      path: $(npm_config_cache)

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

  # Prettier owns ALL formatting in this workspace, so it needs a gate of its
  # own: ESLint is configured for correctness only and deliberately reports
  # nothing about formatting. Without this step the entire formatting opinion is
  # advisory, and a workspace drifts out of compliance with no signal anywhere.
  #
  # Stays workspace-wide even on a PR, unlike the verify step below: it is one
  # Prettier invocation over the whole tree, not a per-project Nx target, so
  # there is nothing to scope down and formatting is never partially checked.
  - script: npm run format:check
    displayName: Check formatting (run 'npm run format' locally to fix)

  # The one verify step, and deliberately the only one: affected projects on a
  # pull request, EVERY project on anything else (a push to main included, so a
  # release is always verified in full). Every fallback — no target branch, an
  # unresolvable merge-base — takes the full path, because a run that verifies
  # too little still reports green.
  #
  # 'npm run lint' is 'nx run-many -t lint', a strict subset of the targets
  # below, so adding it back as its own step would only duplicate work — and on
  # a pull request it would re-lint every project, discarding the point of this.
  - script: ${AFFECTED_OR_ALL_GUARD}
    displayName: Verify (affected on a PR, every project on main)

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
  // `== 'push'`, not `!= 'pull_request'`. Identical today — the generated workflow
  // has exactly two triggers, `push` and `pull_request` — but the negative form
  // says "anything that is not a PR", which quietly means "and any trigger anyone
  // adds later". Add a `workflow_dispatch` or a `schedule` to a workflow written
  // the negative way and clicking *Run workflow* starts publishing packages and
  // pushing release tags, with nothing in the file hinting that it would.
  //
  // Not hypothetical: mnci's own workflow hand-added `workflow_dispatch` for its
  // Windows e2e job and inherited exactly that hazard. The positive form states
  // the actual intent — release on a push to main — and cannot be widened by
  // accident.
  const onMain = `github.event_name == 'push' && github.ref_name == 'main'`
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

concurrency:
  # One run at a time per ref, but \`cancel-in-progress\` is an **expression** on
  # purpose rather than a flat \`true\`.
  #
  # A superseded PR run is pure waste, so cancel it. A run on \`main\` must never
  # be cancelled: it publishes packages and pushes release tags, and killing it
  # part-way can leave a tag pushed with the publish only half done — a state no
  # rerun repairs cleanly, because the version is then already tagged. Those runs
  # queue instead, which also stops two \`nx release\` invocations racing to create
  # the same tag when two commits land close together.
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

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
          node-version: ${NODE_VERSION}
          # Caches ~/.npm keyed on package-lock.json, so \`npm ci\` restores from
          # the local cache instead of re-downloading every tarball on every run.
          # Nothing to invalidate by hand: the action keys on the lockfile, so a
          # dependency change misses the cache and a no-op change hits it.
          cache: npm

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

      # Prettier owns ALL formatting in this workspace, so it needs a gate of
      # its own: ESLint is configured for correctness only and deliberately
      # reports nothing about formatting. Without this step the entire
      # formatting opinion is advisory, and a workspace drifts out of
      # compliance with no signal anywhere.
      #
      # Stays workspace-wide even on a PR, unlike the verify step below: it is
      # one Prettier invocation over the whole tree, not a per-project Nx
      # target, so there is nothing to scope down and formatting is never
      # partially checked.
      - run: npm run format:check
        name: Check formatting (run 'npm run format' locally to fix)

      # The one verify step, and deliberately the only one: affected projects on
      # a pull request, EVERY project on anything else (a push to main included,
      # so a release is always verified in full). Every fallback — no target
      # branch, an unresolvable merge-base — takes the full path, because a run
      # that verifies too little still reports green.
      #
      # 'npm run lint' is 'nx run-many -t lint', a strict subset of the targets
      # below, so adding it back as its own step would only duplicate work — and
      # on a pull request it would re-lint every project, discarding the point
      # of this.
      - run: ${AFFECTED_OR_ALL_GUARD}
        name: Verify (affected on a PR, every project on main)

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
const NX_SCAFFOLDING_TO_REMOVE = ['.prettierrc', '.prettierrc.json', '.vscode'] as const

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
 * Deletes one path if it exists, quietly.
 *
 * @remarks
 * For the config files that belong to the linter mode the workspace did **not**
 * choose. Leaving them behind is not cosmetic: two formatter configs means the
 * editor and CI can disagree about which one applies, which is the same class of
 * silent failure as the `.prettierrc` precedence bug — a config that is present,
 * valid, and ignored.
 *
 * `force: true` makes a missing path a no-op, which is the common case: a fresh
 * `mnci new` has neither mode's files yet.
 *
 * @param path - Absolute path to remove.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error other than a missing path.
 * @typeParam None - this function has no generic type parameters.
 */
export function removeIfPresent(path: string): void {
  rmSync(path, { recursive: true, force: true })
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
    cwd: workspaceRoot
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
 * `nx.json` release patch, `eslint.config.mjs`, `.prettierrc.mjs`,
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
  // Patch nx.json with the release opinion, the stack generator defaults, the
  // shared global inputs (so `nx affected` on a PR is not blind to the root
  // config files — see SHARED_GLOBAL_INPUTS) and sync.applyChanges (so a stale
  // TS project reference — e.g. from hand-adding a cross-project import — is
  // fixed automatically on the next build/typecheck, not just flagged with a
  // prompt). Both `nx release` and every later `nx g`/`mnci add` see the
  // generator defaults.
  const nxJsonPath = join(workspaceRoot, 'nx.json')
  const nxJson = readJson<Record<string, unknown>>(nxJsonPath)
  const generators = {
    ...(nxJson.generators as Record<string, unknown> | undefined),
    ...generatorDefaults(options.stack)
  }
  const sync = { ...(nxJson.sync as Record<string, unknown> | undefined), ...SYNC_CONFIG }
  const mnci = { ...(nxJson.mnci as Record<string, unknown> | undefined), ...mnciConfig(options) }
  const patched = withSharedGlobals(withEslintPlugin(withReleaseConfig(nxJson, options.ci)))
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
    ...rootScripts(options.stack.linter)
  }
  const existingDevDeps = manifest.devDependencies as Record<string, string> | undefined
  const devDeps = {
    ...existingDevDeps,
    ...TS_COMPILER_DEPENDENCIES,
    // The preset pins `nx` itself; the ESLint plugins must match it exactly.
    ...eslintToolchainDependencies(existingDevDeps?.nx ?? 'latest'),
    // Additive, not a replacement: the hybrid keeps the whole ESLint toolchain
    // for the file types oxlint cannot parse.
    ...(options.stack.linter === 'oxlint' && oxlintToolchainDependencies()),
    prettier: PRETTIER_VERSION
  }
  // Merged, never replaced: a workspace's own overrides must survive an upgrade.
  const overrides = {
    ...(manifest.overrides as Record<string, unknown> | undefined),
    ...ESLINT_PEER_OVERRIDES
  }
  // The root project's own Nx config. Merged the same way, so a workspace that
  // added root targets of its own keeps them — see ROOT_LINT_TARGET for why
  // `includedScripts` must stay empty.
  const existingNx = manifest.nx as Record<string, unknown> | undefined
  const nx = {
    ...existingNx,
    includedScripts: (existingNx?.includedScripts as unknown[] | undefined) ?? [],
    targets: {
      ...(existingNx?.targets as Record<string, unknown> | undefined),
      lint: rootLintTarget(options.stack.linter)
    }
  }
  writeFileEnsured(
    manifestPath,
    toJson({
      ...manifest,
      name: `${options.scope}/source`,
      scripts,
      devDependencies: devDeps,
      overrides,
      nx
    })
  )

  writeFileEnsured(join(workspaceRoot, '.npmrc'), npmrcContent(options.registry, options.scope))
  writeFileEnsured(join(workspaceRoot, 'commitlint.config.mjs'), COMMITLINT_CONFIG)
  const hookPath = join(workspaceRoot, '.husky/commit-msg')
  writeFileEnsured(hookPath, COMMIT_MSG_HOOK)
  markExecutable(hookPath)
  // ESLint handles code quality and correctness rules; Prettier handles all
  // formatting (JavaScript Standard Style). ONE ESLint config, at the root —
  // `add` deletes the per-project ones Nx generators write.
  // The linter choice decides which config files exist, and just as importantly
  // which do NOT: switching a workspace between modes has to remove the previous
  // mode's files, or both formatters end up configured and whichever the editor
  // picks wins. `mnci upgrade` runs this same code path, so a switch is a
  // one-command operation rather than a manual cleanup.
  if (options.stack.linter === 'oxlint') {
    writeFileEnsured(join(workspaceRoot, 'oxlint.config.ts'), OXLINT_CONFIG)
    writeFileEnsured(join(workspaceRoot, '.oxfmtrc.json'), OXFMT_CONFIG)
    // ESLint stays, trimmed to what oxlint cannot parse. See ESLINT_CONFIG_NON_JS.
    writeFileEnsured(join(workspaceRoot, 'eslint.config.mjs'), ESLINT_CONFIG_NON_JS)
    removeIfPresent(join(workspaceRoot, '.prettierrc.mjs'))
  } else {
    writeFileEnsured(join(workspaceRoot, 'eslint.config.mjs'), ESLINT_CONFIG)
    writeFileEnsured(join(workspaceRoot, '.prettierrc.mjs'), PRETTIER_CONFIG)
    removeIfPresent(join(workspaceRoot, 'oxlint.config.ts'))
    removeIfPresent(join(workspaceRoot, '.oxfmtrc.json'))
  }
  // Makes a local environment match the one CI verifies — see devcontainerJson.
  writeFileEnsured(
    join(workspaceRoot, '.devcontainer/devcontainer.json'),
    devcontainerJson(options.workspaceName, options.stack.linter)
  )
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
  writeFileEnsured(
    codeWorkspacePath,
    vscodeWorkspace(options.workspaceName, options.stack.linter, existing?.tasks)
  )
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
