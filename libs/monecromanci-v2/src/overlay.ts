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
 * feed. The `${NODE_AUTH_TOKEN}` placeholder stays literal on disk — Azure's
 * `npmAuthenticate@0` task (or a local `NODE_AUTH_TOKEN` env var) fills it in.
 *
 * @param registry - The monorepo's resolved registry configuration.
 * @param scope - The npm scope (e.g. `@demo`) the scoped registry applies to.
 * @returns The full text of the generated `.npmrc`.
 * @throws Never - performs a pure mapping with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function npmrcContent (registry: RegistryConfig, scope: string): string {
  const scopeName = scope.replace(/^@/, '')
  const url = registryUrl(registry)
  const lines = [
    'registry=https://registry.npmjs.org/',
    '; Community Nx plugins (e.g. the Azure Functions one) peer on the previous',
    '; Nx major for a while after each release; accept the resolved tree.',
    'legacy-peer-deps=true',
  ]

  if (url) {
    const host = url.replace(/^https:\/\//, '')
    lines.push(`@${scopeName}:registry=${url}`, `//${host}:_authToken=\${NODE_AUTH_TOKEN}`)
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
 * Only `packages/*` is released: publishable npm libraries live there by
 * convention, while internal libraries live in `libs/` and apps in `apps/`,
 * so release scoping needs no custom tags at all.
 */
export const RELEASE_CONFIG = {
  projectsRelationship: 'independent',
  projects:             ['packages/*'],
  releaseTag:           { pattern: '{projectName}@{version}' },
  version:              {
    conventionalCommits:            true,
    fallbackCurrentVersionResolver: 'disk',
    git:                            { commit: false, tag: true, push: true },
    // Build only what is being released. Without this, @nx/js:lib's generator
    // defaults the pre-version command to building EVERY project, so a broken
    // (or merely slow) app build would block releasing unrelated packages.
    // Set here at `new` time it wins: the generator only fills this in when
    // absent (it spreads the existing release.version over its default).
    preVersionCommand:              'npx nx run-many -t build --projects=packages/*',
  },
  changelog: { workspaceChangelog: false },
} as const

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
 * Builds the generated workspace's whole CI: one short Azure Pipelines file.
 *
 * @remarks
 * Carries over v1's hard-won Azure lessons:
 * - `checkout: self` leaves the agent on a detached HEAD; re-attach with
 *   `git checkout -B $(Build.SourceBranchName)` before anything else, or
 *   `nx release` cannot push tags.
 * - Fetch every ref and tag up front: affected detection needs the base
 *   branch, version resolution needs the release tags.
 * - A git identity is required to create annotated tags on CI.
 * - The release step needs two one-time grants only a project admin can make:
 *   the **Project Collection Build Service** account needs *Contribute* on
 *   the repository (tag push), and the *Contributor* role on the Artifacts
 *   feed (publish).
 *
 * Everything else — affected computation, versioning, tagging, publishing —
 * is Nx's own (`nx affected`, `nx release`), not a custom engine.
 *
 * @param None - this function takes no parameters.
 * @returns The full text of `azure-pipelines.yml`.
 * @throws Never - performs a pure mapping with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function azurePipelinesYaml (): string {
  return `name: monorepo-ci-$(Date:yyyyMMdd)$(Rev:.r)

# Generated by MoNecromanCI v2. The pipeline is deliberately thin: Nx computes
# what is affected, and 'nx release' versions from conventional commits,
# pushes ONLY a tag to main (never a commit), and publishes to the registry
# configured in .npmrc.

trigger:
  branches:
    include: [main]

pr:
  branches:
    include: [main]

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
    # Lets later steps push release tags back to the repo. The Project
    # Collection Build Service account needs Contribute permission on this
    # repo (Project Settings -> Repositories -> Security) — one-time grant.
    persistCredentials: true
    fetchDepth: 0

  - script: |
      # checkout leaves a detached HEAD; nx release needs a real branch, and
      # tag creation needs a git identity.
      git checkout -B $(Build.SourceBranchName)
      git fetch --all --prune --tags
      git config user.name "Azure Pipelines"
      git config user.email "pipeline@dev.azure.com"
    displayName: Attach HEAD and fetch refs

  - task: UseNode@1
    inputs:
      version: 24.x

  - script: npm ci
    displayName: Install dependencies

  - script: npm install -g azure-functions-core-tools@4 --unsafe-perm true
    displayName: Install Azure Functions Core Tools
    # Needed by @nxazure/func executors; harmless when no function app exists.

  - script: |
      if [ "$(Build.Reason)" = "PullRequest" ]; then
        BASE="origin/$(System.PullRequest.TargetBranchName)"
      else
        BASE="HEAD~1"
      fi
      npx nx affected -t lint,test,build --base="$BASE" --head=HEAD
    displayName: Lint, test and build affected projects

  - script: |
      # A deployable function app is dist + host.json + package.json with its
      # production node_modules vendored in — ready for AzureFunctionApp@2 (or
      # any zip deploy). Skipped cleanly when no function app exists.
      shopt -s nullglob
      mkdir -p "$(Build.ArtifactStagingDirectory)/function-apps"
      for host in apps/*/host.json; do
        app_dir=$(dirname "$host"); app=$(basename "$app_dir")
        staging="$(Build.ArtifactStagingDirectory)/function-apps/$app"
        mkdir -p "$staging"
        npx nx build "$app"
        cp -r "$app_dir/dist" "$app_dir/host.json" "$app_dir/package.json" "$staging/"
        (cd "$staging" && npm install --omit=dev --no-audit --no-fund)
      done
    displayName: Package function apps
    condition: and(succeeded(), ne(variables['Build.Reason'], 'PullRequest'), eq(variables['Build.SourceBranchName'], 'main'))

  - task: PublishBuildArtifacts@1
    displayName: Publish function app packages
    condition: and(succeeded(), ne(variables['Build.Reason'], 'PullRequest'), eq(variables['Build.SourceBranchName'], 'main'))
    inputs:
      PathtoPublish: $(Build.ArtifactStagingDirectory)/function-apps
      ArtifactName: function-apps

  - task: npmAuthenticate@0
    displayName: Authenticate npm registry
    condition: and(succeeded(), ne(variables['Build.Reason'], 'PullRequest'), eq(variables['Build.SourceBranchName'], 'main'))
    inputs:
      workingFile: .npmrc

  - script: |
      # Skip cleanly while the workspace has no publishable packages yet.
      if ls packages/*/package.json > /dev/null 2>&1; then
        npx nx release --yes
      else
        echo "No packages/* to release — skipping."
      fi
    displayName: Release (version from commits, tag-only, publish)
    condition: and(succeeded(), ne(variables['Build.Reason'], 'PullRequest'), eq(variables['Build.SourceBranchName'], 'main'))
    env:
      NODE_AUTH_TOKEN: $(NODE_AUTH_TOKEN)
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
  scope:    string
  /** Where publishable packages are released to. */
  registry: RegistryConfig
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
 * @param options - The scope and registry chosen for this workspace.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error raised while reading or writing.
 * @typeParam None - this function has no generic type parameters.
 */
export function applyOverlay (workspaceRoot: string, options: OverlayOptions): void {
  const nxJsonPath = join(workspaceRoot, 'nx.json')
  const nxJson = readJson<Record<string, unknown>>(nxJsonPath)
  writeFileEnsured(nxJsonPath, toJson(withReleaseConfig(nxJson)))

  // The preset names the root package a placeholder ('@org/source'); stamp the
  // chosen scope so `add npm-lib` can derive the default import path from it.
  const manifestPath = join(workspaceRoot, 'package.json')
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  writeFileEnsured(manifestPath, toJson({ ...manifest, name: `${options.scope}/source` }))

  writeFileEnsured(join(workspaceRoot, '.npmrc'), npmrcContent(options.registry, options.scope))
  writeFileEnsured(join(workspaceRoot, 'commitlint.config.mjs'), COMMITLINT_CONFIG)
  const hookPath = join(workspaceRoot, '.husky/commit-msg')
  writeFileEnsured(hookPath, COMMIT_MSG_HOOK)
  markExecutable(hookPath)
  writeFileEnsured(join(workspaceRoot, 'azure-pipelines.yml'), azurePipelinesYaml())
}
