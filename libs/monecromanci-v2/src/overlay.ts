import { join } from 'node:path'
import { markExecutable, readJson, toJson, writeFileEnsured } from './util/fsx'

/**
 * Where a generated monorepo publishes its npm packages.
 *
 * @remarks
 * v2 supports Azure Artifacts (the user's daily-job registry) and the public
 * npm registry. Ported from v1's `RegistryConfig`, minus GitHub Packages —
 * out of scope for the box-out experiment.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type RegistryConfig
  = | { kind: 'azure-artifacts', organization: string, project: string, artifactsFeed: string }
    | { kind: 'npm' }

/**
 * The stack chosen at `mnci2 new` — asked up front, honoured by every `add`.
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
 * ESLint and Jest: the combination existing generated repos (and the box-out
 * e2e) already assume, so defaulting to it keeps behaviour unchanged when the
 * stack is not chosen explicitly.
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
 * Public npm needs no scoped registry, so it returns `undefined`. Ported
 * unchanged from v1 `engine/registry.ts`.
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
 * The tag-only model proven by v1's own pipeline: versions are computed from
 * conventional commits since each package's last release tag, the bump is
 * **never committed** (`git.commit: false`) — only the tag is created and
 * pushed — so a protected `main` never rejects a release, and future runs
 * resolve versions from tag names, not from a committed `package.json`.
 * `fallbackCurrentVersionResolver: 'disk'` keeps a brand-new package (no tag
 * yet) from hard-erroring. Changelog files are disabled because they would be
 * unpushable under the tag-only model.
 *
 * The git options live under `version.git` (not a top-level `release.git`):
 * Nx rejects the top-level form for the `nx release version` subcommand,
 * which is exactly what users run for dry-runs. `push: true` pushes the tag
 * (and only the tag — there is no commit to push).
 *
 * Two directories are released: `packages/*` (publishable **npm** libraries)
 * and `python-packages/*` (publishable **Python** packages). Both get the same
 * conventional-commit versioning and `{projectName}@{version}` tag; each
 * project's own `versionActions` (npm's default, or the `@nxlv/python` one the
 * plugin stamps into a Python `project.json`) reads/writes the right manifest
 * (`package.json` vs `pyproject.toml`). Internal libraries live in `libs/` and
 * apps in `apps/`, so release scoping still needs no custom tags.
 */
export const RELEASE_CONFIG = {
  projectsRelationship: 'independent',
  projects:             ['packages/*', 'python-packages/*'],
  releaseTag:           { pattern: '{projectName}@{version}' },
  version:              {
    conventionalCommits:            true,
    fallbackCurrentVersionResolver: 'disk',
    git:                            { commit: false, tag: true, push: true },
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
 * Returns a copy of an `nx.json` object with the v2 release block applied.
 *
 * @remarks
 * Pure read-modify-write on the object the Nx preset generated — v2 never
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
 * devDependency installed by `mnci2 new`.
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
 * This is how the one-time `new` choice reaches every later `mnci2 add`: the
 * `@nx/*` generators read `linter`/`unitTestRunner` from here, and `add`
 * itself reads it back to wire the hand-built function app to the same runner.
 * oxlint is not an Nx linter, so it maps to `linter: 'none'` — the workspace
 * `oxlint.config.mts` + the `oxlint` root script cover linting instead.
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
 * The Python package registry's `uv publish` upload URL for a registry config.
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
 * release step also exports `UV_PUBLISH_*` so `nx release` publishes the Python
 * packages with `uv`, reusing the base64 `PAT` decoded to the raw token
 * uv/pypi basic-auth needs (no second secret; Azure accepts any username). For
 * the public-npm registry that env is omitted, so a Python package there is
 * still versioned + tagged but its publish needs user-provided `UV_PUBLISH_*`.
 *
 * @param agent - The build agent (vmImage or self-hosted pool name).
 * @param variableGroup - The Library variable group holding the base64 `PAT`.
 * @param pythonPublishUrl - The uv publish URL for Python packages, or
 * `undefined` to leave Python publishing unconfigured (public npm).
 * @returns The full text of `azure-pipelines.yml`.
 * @throws Never - performs a pure mapping with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function azurePipelinesYaml (agent: string, variableGroup: string, pythonPublishUrl?: string): string {
  const onMain = `and(succeeded(), ne(variables['Build.Reason'], 'PullRequest'), eq(variables['Build.SourceBranchName'], 'main'))`
  // Injected into the release step's node -e: when there are Python packages and
  // an Azure feed, export uv publish credentials (raw PAT decoded from base64).
  const pythonPublishEnv = pythonPublishUrl
    ? `if(hasPython){env.UV_PUBLISH_URL='${pythonPublishUrl}';env.UV_PUBLISH_USERNAME='AzureArtifacts';env.UV_PUBLISH_PASSWORD=Buffer.from(process.env.PAT,'base64').toString()}`
    : ''
  return `name: monorepo-ci-$(Date:yyyyMMdd)$(Rev:.r)

# Generated by MoNecromanCI v2. Deliberately thin: Nx builds, 'nx release'
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
  # Holds the base64-encoded npm PAT as \`PAT\` (the root .npmrc reads it as
  # \${PAT}). Mark PAT secret in Library. Add app build vars here too if needed.
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
      PAT: $(PAT)

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
  # notably Python's ruff (@nxlv/python projects own a \`lint\` target). For the
  # eslint stack the JS lint runs twice, but Nx caches the repeat instantly.
  - script: npx nx run-many -t lint,test,build
    displayName: Lint, test and build everything

  # Pack every app into dist/drop/<type>-<name>.zip via each app's 'package'
  # target. Portable guard: skip cleanly when the workspace has no apps yet.
  - script: node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});if(fs.globSync('apps/*/project.json').length===0){console.log('No apps to pack - skipping.');process.exit(0)}process.exit(require('node:child_process').spawnSync('npx nx run-many -t package',{stdio:'inherit',shell:true}).status ?? 1)"
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
  # to release. When there are Python packages and an Azure feed, uv publish
  # credentials are exported (raw PAT, decoded from the base64 variable).
  - script: node -e "const fs=require('node:fs'),cp=require('node:child_process');const hasNpm=fs.globSync('packages/*/package.json').length>0;const hasPython=fs.globSync('python-packages/*/pyproject.toml').length>0;if(!hasNpm&&!hasPython){console.log('Nothing to release - skipping.');process.exit(0)}const env={...process.env};${pythonPublishEnv}process.exit(cp.spawnSync('npx nx release --yes',{stdio:'inherit',shell:true,env}).status ?? 1)"
    displayName: Release — version, tag and publish (npm + Python)
    condition: ${onMain}
    env:
      PAT: $(PAT)
`
}

/**
 * Options for {@link applyOverlay}.
 *
 * @remarks
 * Collected by `mnci2 new`'s flags or prompts.
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
  /** The stack (TS major, linter, test runner) chosen at `new`. */
  stack:         StackConfig
}

/**
 * Applies MoNecromanCI v2's opinions on top of a freshly generated workspace.
 *
 * @remarks
 * This is the ONLY file-writing v2 does — everything else in the workspace is
 * the untouched output of Nx's own generators. Writes: the `nx.json` release
 * patch, `.npmrc`, `commitlint.config.mjs`, the husky `commit-msg` hook and
 * `azure-pipelines.yml`. Dependency installation (`husky`, `@commitlint/*`)
 * is the caller's job — it shells out to real `npm install` so versions
 * resolve at generation time instead of being pinned here.
 *
 * @param workspaceRoot - Absolute path to the generated workspace.
 * @param options - The scope, registry, CI agent and variable group chosen.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error raised while reading or writing.
 * @typeParam None - this function has no generic type parameters.
 */
export function applyOverlay (workspaceRoot: string, options: OverlayOptions): void {
  // Patch nx.json with the release opinion, the stack generator defaults, and
  // sync.applyChanges (so a stale TS project reference — e.g. from hand-adding
  // a cross-project import — is fixed automatically on the next build/
  // typecheck, not just flagged with a prompt). Both `nx release` and every
  // later `nx g`/`mnci2 add` see the generator defaults.
  const nxJsonPath = join(workspaceRoot, 'nx.json')
  const nxJson = readJson<Record<string, unknown>>(nxJsonPath)
  const generators = { ...(nxJson.generators as Record<string, unknown> | undefined), ...generatorDefaults(options.stack) }
  const sync = { ...(nxJson.sync as Record<string, unknown> | undefined), ...SYNC_CONFIG }
  writeFileEnsured(nxJsonPath, toJson({ ...withReleaseConfig(nxJson), generators, sync }))

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
  writeFileEnsured(join(workspaceRoot, 'azure-pipelines.yml'), azurePipelinesYaml(options.agent, options.variableGroup, pythonPublishUrl(options.registry)))
}
