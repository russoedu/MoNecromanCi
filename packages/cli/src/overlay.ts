import { join } from 'node:path'
import { markExecutable, readJson, toJson, writeFileEnsured } from './util/fsx'

/**
 * Where a generated monorepo publishes its npm packages.
 *
 * @remarks
 * Supports Azure Artifacts and the public npm registry. GitHub Packages is
 * out of scope for this cut.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type RegistryConfig
  = | { kind: 'azure-artifacts', organization: string, project: string, artifactsFeed: string }
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
 * native `tsc` for the `typecheck`/`build` tasks. So the two real knobs are the
 * linter and the unit-test runner, persisted as Nx **generator defaults** in
 * `nx.json` (the oxlint case also writes a workspace `oxlint.config.mts` and
 * points the root `lint` script at `oxlint`).
 *
 * @typeParam None - this type has no generic type parameters.
 */
export interface StackConfig {
  /** Linter: Nx-native `eslint`, or workspace-wide `oxlint`. */
  linter:     'eslint' | 'oxlint'
  /** Unit-test runner (both Nx-native for the plugin kinds). */
  testRunner: 'jest' | 'vitest'
}

/**
 * The `--yes` / flagless defaults — the current opinionated stack.
 *
 * @remarks
 * ESLint and Jest: the combination existing generated repos (and the e2e
 * suite) already assume, so defaulting to it keeps behaviour unchanged when
 * the stack is not chosen explicitly.
 */
export const DEFAULT_STACK: StackConfig = { linter: 'eslint', testRunner: 'jest' }

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
  typescript:           'npm:@typescript/typescript6@^6.0.2',
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
export function registryUrl (registry: RegistryConfig): string | undefined {
  if (registry.kind === 'azure-artifacts') {
    return `https://pkgs.dev.azure.com/${registry.organization}/${registry.project}/_packaging/${registry.artifactsFeed}/npm/registry/`
  }
  return undefined
}

/**
 * Builds the `.npmrc` body for a registry configuration.
 *
 * @remarks
 * Scope-to-registry routing is what guarantees packages never land on the
 * public npm registry by accident: every publishable package is named under
 * `scope`, and the scoped registry line routes all of them to the configured
 * feed.
 *
 * Azure Artifacts is authenticated with the **base64-encoded PAT** the feed's
 * "Connect to feed → npm" instructions produce — the classic `_password`
 * block, one pair for the `/npm/registry/` path (install) and one for the feed
 * root (publish). The PAT *value* never lands in the file: `${PAT}` stays
 * literal on disk and is expanded at runtime — in CI from the `Build` variable
 * group's `PAT`, locally from an exported `PAT=<base64 token>`. (No
 * `npmAuthenticate@0` task: it would overwrite this hand-set password.) Public
 * npm keeps the raw `_authToken` an automation token uses.
 *
 * @param registry - The monorepo's resolved registry configuration.
 * @param scope - The npm scope (e.g. `@demo`) the scoped registry applies to.
 * @returns The full text of the generated `.npmrc`.
 * @throws Never - performs a pure mapping with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function npmrcContent (registry: RegistryConfig, scope: string): string {
  const scopeName = scope.replace(/^@/, '')
  const lines = [
    'registry=https://registry.npmjs.org/',
    '; Community Nx plugins (e.g. the Azure Functions one) peer on the previous',
    '; Nx major for a while after each release; accept the resolved tree.',
    'legacy-peer-deps=true',
  ]

  if (registry.kind === 'azure-artifacts') {
    const base = `https://pkgs.dev.azure.com/${registry.organization}/${registry.project}/_packaging/${registry.artifactsFeed}`
    const registryHost = `${base}/npm/registry/`.replace(/^https:\/\//, '')
    const feedHost = `${base}/`.replace(/^https:\/\//, '')
    lines.push(
      `@${scopeName}:registry=${base}/npm/registry/`,
      '; Azure Artifacts auth — the base64 PAT is expanded at runtime from the',
      '; PAT env var (CI: your PAT variable group; locally: export PAT=<base64 token>).',
      `//${registryHost}:username=${registry.organization}`,
      `//${registryHost}:_password=\${PAT}`,
      `//${registryHost}:email=npm@example.com`,
      `//${feedHost}:username=${registry.organization}`,
      `//${feedHost}:_password=\${PAT}`,
      `//${feedHost}:email=npm@example.com`,
    )
  } else {
    lines.push(`//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}`)
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * The `release` block merged into a generated workspace's `nx.json`.
 *
 * @remarks
 * The tag-only model: versions are computed from conventional commits since
 * each package's last release tag, the bump is
 * **never committed** (`git.commit: false`) — only the tag is created and
 * pushed — so a protected `main` never rejects a release, and future runs
 * resolve versions from tag names, not from a committed `package.json`.
 * `fallbackCurrentVersionResolver: 'disk'` keeps a brand-new package (no tag
 * yet) from hard-erroring. Changelog files are disabled because they would be
 * unpushable under the tag-only model.
 *
 * The git options live under a top-level `git` (not `version.git`): the
 * guarded CI release step and the generated `release:preview` script both run
 * the combined `nx release` command (never the bare `nx release version`
 * subcommand), and Nx hard-errors that combined command when git options are
 * granular (`version.git`/`changelog.git`) instead of top-level — the reverse
 * of the bare `version` subcommand's own requirement, which is why the two
 * forms aren't interchangeable (verified empirically).
 *
 * `push: false` here is deliberate, not an oversight: the combined
 * `nx release` command's own final push (`release.js`, after tagging) only
 * runs when a remote GitHub/GitLab Release is being created
 * (`shouldCreateWorkspaceRemoteRelease`), which this config never enables —
 * so that push never fires. The *only* push Nx does run is an internal one
 * buried inside the version step, which happens **before** the tag exists
 * (tagging is deliberately suppressed there and done later, by `release.js`
 * itself) — so even with `pushArgs: '--tags'` that earlier push has no new
 * tag to push yet, and the tag is left local-only (verified empirically
 * against a real CI run: the release step and publish both report success,
 * "Pushing to git remote" logs *before* "Tagging commit with git", and the
 * new tag never reaches `origin`, even though the version it names does
 * reach npm — a silent, permanent mismatch that makes every subsequent
 * release recompute and re-skip the same already-published version forever).
 * Disabling Nx's own push entirely and pushing tags explicitly, once, after
 * tagging is guaranteed to have happened (the CI step below), sidesteps this
 * ordering bug rather than fighting it.
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
 * one group correctly.
 * Internal libraries live in `libs/` and apps in `apps/`, so release scoping
 * still needs no custom tags.
 */
export const RELEASE_CONFIG = {
  projectsRelationship: 'independent',
  projects:             ['packages/*', 'python-packages/*'],
  releaseTag:           { pattern: '{projectName}@{version}' },
  git:                  { commit: false, tag: true, push: false },
  version:              {
    conventionalCommits:            true,
    fallbackCurrentVersionResolver: 'disk',
    // Build only what is being released. Without this, @nx/js:lib's generator
    // defaults the pre-version command to building EVERY project, so a broken
    // (or merely slow) app build would block releasing unrelated packages.
    // Set here at `new` time it wins: the generator only fills this in when
    // absent (it spreads the existing release.version over its default). Both
    // globs are listed; `nx run-many` no-ops cleanly when one matches nothing.
    preVersionCommand:              'npx nx run-many -t build --projects=packages/*,python-packages/*',
  },
  changelog: { workspaceChangelog: false },
} as const

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
 * Returns a copy of an `nx.json` object with the release block applied.
 *
 * @remarks
 * Pure read-modify-write on the object the Nx preset generated — this never
 * templates whole config files, it only patches in the one opinion Nx has no
 * default for.
 *
 * @param nxJson - The parsed `nx.json` produced by `create-nx-workspace`.
 * @returns A new object with `release` (and `defaultBase: 'main'`) set.
 * @throws Never - performs a pure object merge with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function withReleaseConfig (nxJson: Record<string, unknown>): Record<string, unknown> {
  return { ...nxJson, defaultBase: 'main', release: RELEASE_CONFIG }
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
 * The curated npm scripts stamped into a generated workspace's root manifest.
 *
 * @remarks
 * Each one is a single cross-platform Nx (or husky) invocation — the everyday
 * entry points, nothing more. `affected` compares against `main`
 * (`defaultBase` in `nx.json`); `release:preview` shows what `nx release`
 * would do on CI without touching anything.
 */
export const ROOT_SCRIPTS = {
  build:             'nx run-many -t build',
  lint:              'nx run-many -t lint',
  test:              'nx run-many -t test',
  affected:          'nx affected -t lint,test,build',
  graph:             'nx graph',
  'release:preview': 'nx release --dry-run',
  prepare:           'husky',
} as const

/**
 * The curated scripts with `lint` bound to the chosen linter.
 *
 * @remarks
 * ESLint is a per-project Nx target (`nx run-many -t lint`); oxlint is a single
 * workspace-wide binary, so its `lint` is just `oxlint`. Everything downstream
 * (the CI pipeline) calls `npm run lint`, so it never needs to know which
 * linter was chosen.
 *
 * The oxlint stack also gets the oxc-standard formatter as `format` (write) and
 * `format:check` (CI-safe, no writes) — the JavaScript Standard Style *layout*
 * half that oxlint (a linter) does not enforce. The `-c oxfmt.config.mts` flag
 * is explicit because oxfmt (0.48) auto-discovers `.oxfmtrc.json` but not the
 * typed `.mts` config, and the whole stack is committed to typed configs.
 * ESLint workspaces keep Nx's own formatting story, so they get no `format`.
 *
 * @param stack - The chosen stack.
 * @returns The root scripts object to stamp into the manifest.
 * @throws Never - pure mapping.
 * @typeParam None - this function has no generic type parameters.
 */
export function rootScripts (stack: StackConfig): Record<string, string> {
  if (stack.linter === 'oxlint') {
    return {
      ...ROOT_SCRIPTS,
      lint:           'oxlint',
      format:         'oxfmt -c oxfmt.config.mts .',
      'format:check': 'oxfmt -c oxfmt.config.mts --check .',
    }
  }
  return { ...ROOT_SCRIPTS }
}

/**
 * The Nx `generators` defaults patched into `nx.json` from the chosen stack.
 *
 * @remarks
 * Lets a user's own **direct** `nx g @nx/react:app ...` (outside `mnci add`)
 * pick up the workspace's chosen linter/runner automatically. oxlint is not an
 * Nx linter, so it maps to `linter: 'none'` — the workspace `oxlint.config.mts`
 * + the `oxlint` root script cover linting instead.
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
export function generatorDefaults (stack: StackConfig): Record<string, unknown> {
  const shared = { linter: stack.linter === 'oxlint' ? 'none' : 'eslint', unitTestRunner: stack.testRunner }
  return {
    '@nx/react:application': shared,
    '@nx/react:library':     shared,
    '@nx/js:library':        shared,
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
export function mnciConfig (options: OverlayOptions): Record<string, unknown> {
  return {
    scope:         options.scope,
    registry:      options.registry,
    agent:         options.agent,
    variableGroup: options.variableGroup,
    ci:            options.ci,
    stack:         { linter: options.stack.linter, testRunner: options.stack.testRunner },
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
export function readMnciConfig (workspaceRoot: string): Partial<OverlayOptions> {
  const nxJson = readJson<Record<string, unknown>>(join(workspaceRoot, 'nx.json'))
  return (nxJson.mnci as Partial<OverlayOptions> | undefined) ?? {}
}

/**
 * The `oxlint.config.mts` written when oxlint is the chosen linter.
 *
 * @remarks
 * A typed config (`defineConfig` from `oxlint`, auto-detected — needs Node ≥22)
 * rather than JSON. Instead of hand-listing plugins and rules it **extends the
 * [oxc-standard](https://github.com/JohnDeved/ox-standard) preset** — the real
 * JavaScript Standard Style rule set for the oxc toolchain (unicorn + React +
 * react-perf + TypeScript + oxc, `correctness: error`, `suspicious: warn`,
 * `style: off`). A `.mts` config's `extends` must hold **config objects, not
 * paths** (unlike `.oxlintrc.json`, which cannot import from a package), so the
 * preset is imported as JSON and passed in — the pattern oxlint documents for
 * extending a shared package's config.
 *
 * The one local override keeps a freshly generated workspace green: Nx scaffolds
 * with the modern JSX transform, so React need not be in scope and the preset's
 * `react/react-in-jsx-scope` correctness rule is turned off. Add further project
 * overrides in the same `rules` block.
 *
 * Its formatting counterpart is {@link OXFMT_CONFIG} (Standard Style layout).
 */
export const OXLINT_CONFIG = `import { defineConfig } from 'oxlint'
import standard from 'oxc-standard/.oxlintrc.json' with { type: 'json' }

// Generated by MoNecromanCI. JavaScript Standard Style linting via the
// oxc-standard preset (unicorn + React + react-perf + TypeScript + oxc).
// Add project-specific rule overrides in the \`rules\` block below.
export default defineConfig({
  extends: [standard],
  rules: {
    // The modern JSX transform (Nx's default) needs no React import in scope.
    'react/react-in-jsx-scope': 'off',
  },
})
`

/**
 * The `oxfmt.config.mts` written alongside {@link OXLINT_CONFIG} for oxlint.
 *
 * @remarks
 * oxfmt is the oxc toolchain's formatter — the *layout* half oxlint (a linter)
 * does not enforce. These options mirror oxc-standard's own `.oxfmtrc.json` so
 * formatting and linting agree on JavaScript Standard Style: no semicolons,
 * single quotes, 2-space indent, `es5` trailing commas, and parens omitted on
 * single-argument arrows. (oxfmt has no `extends`, so the preset's values are
 * inlined — exactly how oxc-standard itself scaffolds them.)
 *
 * `npm run format` writes; `npm run format:check` verifies without writing
 * ({@link rootScripts}) — both pass `-c oxfmt.config.mts` since oxfmt (0.48)
 * auto-discovers only `.oxfmtrc.json`, not the typed config. Nx generators emit
 * semicolon/double-quote code, so a new workspace is normalised on the first
 * `npm run format`.
 */
export const OXFMT_CONFIG = `import { defineConfig } from 'oxfmt'

// Generated by MoNecromanCI. JavaScript Standard Style formatting, matching the
// oxc-standard lint preset: no semicolons, single quotes, 2-space indent.
export default defineConfig({
  singleQuote: true,
  semi: false,
  printWidth: 100,
  tabWidth: 2,
  trailingComma: 'es5',
  arrowParens: 'avoid',
})
`

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
export function pythonPublishUrl (registry: RegistryConfig): string | undefined {
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
const NPM_AUDIT_STEP = 'npm audit --audit-level=high || echo npm audit found vulnerabilities, see log above - non-blocking, run npm audit locally to inspect'

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
function releaseGuard (pythonPublishEnv: string): string {
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
function pythonPublishEnvFragment (pythonPublishUrl?: string): string {
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
function npmAuthEnvVariable (registryKind: RegistryConfig['kind'], variableReference: (name: string) => string): [string, string] {
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
export function poolBlock (agent: string): string {
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
export function azurePipelinesYaml (agent: string, variableGroup: string, pythonPublishUrl?: string, registryKind: RegistryConfig['kind'] = 'azure-artifacts'): string {
  const onMain = `and(succeeded(), ne(variables['Build.Reason'], 'PullRequest'), eq(variables['Build.SourceBranchName'], 'main'))`
  const [npmAuthName, npmAuthValue] = npmAuthEnvVariable(registryKind, (name) => `$(${name})`)
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

  # Fails fast, with an unambiguous message, when a stale TypeScript project
  # reference (or another sync generator's drift) was never synced+committed
  # locally — sync.applyChanges (nx.json) only auto-applies interactively, so
  # CI still needs its own explicit, early check rather than surfacing this as
  # a confusing failure buried inside the build step below.
  - script: npx nx sync:check
    displayName: Verify the workspace is synced (run 'npx nx sync' locally and commit if this fails)

  # One verify for every run (PR and main). \`npm run lint\` abstracts the chosen
  # linter (eslint via nx, or oxlint), so the pipeline needs no linter branch;
  # Nx cache makes unchanged test/build projects instant.
  - script: npm run lint
    displayName: Lint
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
export function githubActionsYaml (agent: string, pythonPublishUrl?: string, registryKind: RegistryConfig['kind'] = 'azure-artifacts'): string {
  const onMain = `github.event_name != 'pull_request' && github.ref_name == 'main'`
  const [npmAuthName, npmAuthValue] = npmAuthEnvVariable(registryKind, (name) => `\${{ secrets.${name} }}`)
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
  # Lets the release step push the version tag nx release creates back to main.
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

      # Fails fast, with an unambiguous message, when a stale TypeScript project
      # reference (or another sync generator's drift) was never synced+committed
      # locally — sync.applyChanges (nx.json) only auto-applies interactively, so
      # CI still needs its own explicit, early check rather than surfacing this as
      # a confusing failure buried inside the build step below.
      - run: npx nx sync:check
        name: Verify the workspace is synced (run 'npx nx sync' locally and commit if this fails)

      # One verify for every run (PR and main). \`npm run lint\` abstracts the chosen
      # linter (eslint via nx, or oxlint), so the workflow needs no linter branch;
      # Nx cache makes unchanged test/build projects instant.
      - run: npm run lint
        name: Lint
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
      # publish credentials are exported (raw PAT, decoded from the base64 secret).
      - run: ${releaseGuard(pythonPublishEnvFragment(pythonPublishUrl))}
        name: Release — version, tag and publish (npm + Python)
        if: \${{ ${onMain} }}
        env:
          ${npmAuthName}: ${npmAuthValue}

      # nx release's own git push (release.git.push) is deliberately left off: it
      # only runs when a remote GitHub/GitLab Release is configured, which this
      # workflow never does, so it would never push the tag the step above just
      # created. Pushed explicitly, unconditionally (a no-op when nothing released)
      # once tagging is guaranteed to have already happened.
      - run: git push origin --tags
        name: Push release tags (nx release's own push never runs without a remote Release configured)
        if: \${{ ${onMain} }}
`
}

/**
 * Options for {@link applyOverlay}.
 *
 * @remarks
 * Collected by `mnci new`'s flags or prompts.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface OverlayOptions {
  /** The npm scope for publishable packages (e.g. `@demo`). */
  scope:         string
  /** Where publishable packages are released to. */
  registry:      RegistryConfig
  /** The CI build agent — a Microsoft-hosted vmImage or a self-hosted pool name. */
  agent:         string
  /** The Library variable group holding the base64 npm `PAT` (e.g. `Build`). */
  variableGroup: string
  /** Which CI provider(s) to write a pipeline file for. */
  ci:            CiProvider
  /** The stack (TS major, linter, test runner) chosen at `new`. */
  stack:         StackConfig
}

/**
 * Applies MoNecromanCI's opinions on top of a freshly generated workspace.
 *
 * @remarks
 * This is the ONLY file-writing this CLI does — everything else in the
 * workspace is the untouched output of Nx's own generators. Writes: the
 * `nx.json` release patch, `.npmrc`, `commitlint.config.mjs`, the husky
 * `commit-msg` hook and
 * the chosen CI provider's pipeline file(s) — `azure-pipelines.yml` and/or
 * `.github/workflows/ci.yml`, per `options.ci`. Dependency installation
 * (`husky`, `@commitlint/*`) is the caller's job — it shells out to real
 * `npm install` so versions resolve at generation time instead of being
 * pinned here.
 *
 * @param workspaceRoot - Absolute path to the generated workspace.
 * @param options - The scope, registry, CI agent/variable group and provider chosen.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error raised while reading or writing.
 * @typeParam None - this function has no generic type parameters.
 */
export function applyOverlay (workspaceRoot: string, options: OverlayOptions): void {
  // Patch nx.json with the release opinion, the stack generator defaults, and
  // sync.applyChanges (so a stale TS project reference — e.g. from hand-adding
  // a cross-project import — is fixed automatically on the next build/
  // typecheck, not just flagged with a prompt). Both `nx release` and every
  // later `nx g`/`mnci add` see the generator defaults.
  const nxJsonPath = join(workspaceRoot, 'nx.json')
  const nxJson = readJson<Record<string, unknown>>(nxJsonPath)
  const generators = { ...(nxJson.generators as Record<string, unknown> | undefined), ...generatorDefaults(options.stack) }
  const sync = { ...(nxJson.sync as Record<string, unknown> | undefined), ...SYNC_CONFIG }
  const mnci = { ...(nxJson.mnci as Record<string, unknown> | undefined), ...mnciConfig(options) }
  writeFileEnsured(nxJsonPath, toJson({ ...withReleaseConfig(nxJson), generators, sync, mnci }))

  // The preset names the root package a placeholder ('@org/source'); stamp the
  // chosen scope so `add npm-lib` can derive the default import path from it,
  // the curated everyday scripts (each a single cross-platform command, with
  // `lint` bound to the chosen linter), and the dual TS compiler — the alias
  // for `typescript` replaces the plain TS 6 the preset installed, and
  // `@typescript/native` adds the TS 7 `tsc`. The caller's `npm install`
  // materialises them.
  const manifestPath = join(workspaceRoot, 'package.json')
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  const scripts = { ...(manifest.scripts as Record<string, string> | undefined), ...rootScripts(options.stack) }
  const devDependencies = { ...(manifest.devDependencies as Record<string, string> | undefined), ...TS_COMPILER_DEPENDENCIES }
  writeFileEnsured(manifestPath, toJson({ ...manifest, name: `${options.scope}/source`, scripts, devDependencies }))

  writeFileEnsured(join(workspaceRoot, '.npmrc'), npmrcContent(options.registry, options.scope))
  writeFileEnsured(join(workspaceRoot, 'commitlint.config.mjs'), COMMITLINT_CONFIG)
  const hookPath = join(workspaceRoot, '.husky/commit-msg')
  writeFileEnsured(hookPath, COMMIT_MSG_HOOK)
  markExecutable(hookPath)
  // oxlint is workspace-wide: one config, no per-project Nx lint target. It
  // ships with oxfmt (both from the oxc-standard preset) for the Standard Style
  // formatting half — `npm run format` / `npm run format:check`.
  if (options.stack.linter === 'oxlint') {
    writeFileEnsured(join(workspaceRoot, 'oxlint.config.mts'), OXLINT_CONFIG)
    writeFileEnsured(join(workspaceRoot, 'oxfmt.config.mts'), OXFMT_CONFIG)
  }
  // Either or both, per the chosen provider — a GitHub-hosted repo can skip
  // the unused Azure file entirely instead of carrying dead CI config.
  const publishUrl = pythonPublishUrl(options.registry)
  if (options.ci === 'azure' || options.ci === 'both') {
    writeFileEnsured(join(workspaceRoot, 'azure-pipelines.yml'), azurePipelinesYaml(options.agent, options.variableGroup, publishUrl, options.registry.kind))
  }
  if (options.ci === 'github' || options.ci === 'both') {
    writeFileEnsured(join(workspaceRoot, '.github/workflows/ci.yml'), githubActionsYaml(options.agent, publishUrl, options.registry.kind))
  }
}
