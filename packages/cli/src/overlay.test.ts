import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  applyOverlay,
  azurePipelinesYaml,
  DEFAULT_STACK,
  FLUTTER_SDK_VERSION,
  generatorDefaults,
  githubActionsYaml,
  mnciConfig,
  npmrcContent,
  poolBlock,
  pythonPublishUrl,
  readMnciConfig,
  registryUrl,
  rootScripts,
  type StackConfig,
  withEslintPlugin,
  withReleaseConfig,
} from './overlay'

describe('registryUrl', () => {
  it('builds the Azure Artifacts feed URL', () => {
    expect(
      registryUrl({
        kind: 'azure-artifacts',
        organization: 'org',
        project: 'proj',
        artifactsFeed: 'feed',
      })
    ).toBe('https://pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/')
  })

  it('returns undefined for public npm', () => {
    expect(registryUrl({ kind: 'npm' })).toBeUndefined()
  })
})

describe('pythonPublishUrl', () => {
  it('derives the pypi upload URL from the same Azure Artifacts feed (multi-protocol)', () => {
    expect(
      pythonPublishUrl({
        kind: 'azure-artifacts',
        organization: 'org',
        project: 'proj',
        artifactsFeed: 'feed',
      })
    ).toBe('https://pkgs.dev.azure.com/org/proj/_packaging/feed/pypi/upload/')
  })

  it('returns undefined for public npm (no PyPI publish wired in this cut)', () => {
    expect(pythonPublishUrl({ kind: 'npm' })).toBeUndefined()
  })
})

/** Everything in an .npmrc that is not a comment or blank — i.e. actual config. */
function directives(npmrc: string): string[] {
  return npmrc
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith(';') && !line.startsWith('#'))
}

describe('npmrcContent', () => {
  const azure = {
    kind: 'azure-artifacts',
    organization: 'org',
    project: 'proj',
    artifactsFeed: 'feed',
  } as const

  it('emits no configuration at all — publish auth is deliberately deferred', () => {
    expect(directives(npmrcContent({ kind: 'npm' }, '@demo'))).toEqual([])
    expect(directives(npmrcContent(azure, '@demo'))).toEqual([])
  })

  it('says why it is empty, so the deferral is visible in the generated workspace', () => {
    // An absent file would be an absence nobody notices; the comments are the
    // whole point of still writing it.
    const npmrc = npmrcContent({ kind: 'npm' }, '@demo')

    expect(npmrc).toContain('Intentionally empty')
    expect(npmrc).toContain('will not\n; authenticate')
  })

  it('drops legacy-peer-deps, added for a plugin removed long ago', () => {
    // @nxazure/func is gone; the flag stayed behind and quietly weakened
    // dependency resolution in every generated workspace.
    expect(npmrcContent({ kind: 'npm' }, '@demo')).not.toContain('legacy-peer-deps')
    expect(npmrcContent(azure, '@demo')).not.toContain('legacy-peer-deps')
  })

  it('no longer claims a scope-routing guarantee it never actually provided', () => {
    // The npm variant never emitted an @scope:registry line, while the README
    // claimed scope routing made accidental public publishes impossible. The
    // old test asserted the line's ABSENCE, encoding the contradiction.
    for (const npmrc of [npmrcContent({ kind: 'npm' }, '@demo'), npmrcContent(azure, '@demo')]) {
      expect(npmrc).not.toContain('@demo:registry')
      expect(npmrc).not.toContain('_authToken')
      expect(npmrc).not.toContain('_password')
    }
  })
})

describe('withReleaseConfig', () => {
  it('patches release and defaultBase while preserving what the preset generated, for azure', () => {
    const patched = withReleaseConfig(
      {
        $schema: './node_modules/nx/schemas/nx-schema.json',
        namedInputs: { default: [] },
      },
      'azure'
    )

    expect(patched.$schema).toBe('./node_modules/nx/schemas/nx-schema.json')
    expect(patched.namedInputs).toEqual({ default: [] })
    expect(patched.defaultBase).toBe('main')
    expect(patched.release).toMatchObject({
      projectsRelationship: 'independent',
      // Both publishable dirs, in one flat list — not two named release
      // groups: Nx hard-errors the whole release when any explicit group
      // matches zero projects, which a Python-only (or npm-only) workspace
      // would hit immediately. Each project's own versionActions (npm's
      // default, or the hand-written PythonVersionActions stamped onto every
      // python-lib by add/python.ts) wins over this shared config anyway.
      // `!tag:type:go-lib` is a bug fix, not tuning: a go-lib also lands in
      // packages/ but has no per-project manifest (one root go.mod), so Nx's
      // default versionActions looks for a package.json that is not there and
      // aborts the release for the WHOLE workspace. Verified: without this,
      // one `mnci add go-lib` made `nx release` exit 1 for every project.
      projects: ['packages/*', 'python-packages/*', '!tag:type:go-lib'],
      releaseTag: { pattern: '{projectName}@{version}' },
      // Tag-only model: nothing is ever committed to main; the tag is pushed.
      // Top-level (not version.git) — Nx rejects granular git config for the
      // combined `nx release` command, which is what CI and release:preview
      // both run (never the bare `nx release version` subcommand).
      // push: false for azure/both: GitHub Release creation (which requires
      // push: true) is scoped to the github-only provider — see releaseConfig's
      // remarks for why azure/both keep the pipeline's own explicit tag push.
      git: { commit: false, tag: true, push: false },
      version: {
        conventionalCommits: true,
        fallbackCurrentVersionResolver: 'disk',
        // Releasing packages must not require building apps; both globs listed
        // (nx run-many no-ops on an empty one).
        preVersionCommand: 'npx nx run-many -t build --projects=packages/*,python-packages/*',
      },
      changelog: { workspaceChangelog: false },
    })
  })

  it('does the same for both (GitHub Releases are not safe to assume when Azure Pipelines might be the one that runs)', () => {
    const patched = withReleaseConfig({ $schema: 'x' }, 'both')
    expect(patched.release).toMatchObject({
      git: { commit: false, tag: true, push: false },
      changelog: { workspaceChangelog: false },
    })
  })

  it('turns on GitHub Release creation for the github-only provider', () => {
    const patched = withReleaseConfig({ $schema: 'x' }, 'github')

    expect(patched.release).toMatchObject({
      // Nx hard-errors createRelease when push is disabled — push: true is
      // required here, not optional, and Nx's own push now runs after
      // tagging on this Nx version (verified empirically), so this is safe.
      git: { commit: false, tag: true, push: true },
      changelog: {
        workspaceChangelog: false,
        // file: false: the changelog content still flows into the GitHub
        // Release body, but no CHANGELOG.md is written — one would never get
        // committed under this tag-only model (git.commit stays false).
        projectChangelogs: { createRelease: 'github', file: false },
      },
    })
  })
})

describe('poolBlock', () => {
  it('maps a Microsoft-hosted image to vmImage', () => {
    expect(poolBlock('ubuntu-latest')).toBe('  vmImage: ubuntu-latest')
    expect(poolBlock('windows-2022')).toBe('  vmImage: windows-2022')
    expect(poolBlock('macos-13')).toBe('  vmImage: macos-13')
  })

  it('maps anything else to a self-hosted pool name', () => {
    expect(poolBlock('MyLinuxPool')).toBe('  name: MyLinuxPool')
    expect(poolBlock('AzurePipelineManagedPool-Windows')).toBe(
      '  name: AzurePipelineManagedPool-Windows'
    )
  })
})

describe('azurePipelinesYaml', () => {
  it('stamps the chosen agent and variable group', () => {
    expect(azurePipelinesYaml('ubuntu-latest', 'Build')).toContain('  vmImage: ubuntu-latest')
    const selfHosted = azurePipelinesYaml('MyPool', 'CiSecrets')
    expect(selfHosted).toContain('  name: MyPool')
    expect(selfHosted).toContain('- group: CiSecrets')
  })

  it('is valid YAML for both hosted and self-hosted agents', () => {
    for (const agent of ['ubuntu-latest', 'MyPool']) {
      const document_ = yaml.load(azurePipelinesYaml(agent, 'Build')) as {
        steps?: unknown
        pool?: unknown
        variables?: unknown
      }
      expect(Array.isArray(document_.steps)).toBe(true)
      expect(document_.pool).toBeTruthy()
      expect(Array.isArray(document_.variables)).toBe(true)
    }
  })

  it('re-attaches the detached HEAD before fetching refs or releasing', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    const checkoutIndex = pipeline.indexOf('checkout: self')
    const attachIndex = pipeline.indexOf('git checkout -B $(Build.SourceBranchName)')
    const fetchIndex = pipeline.indexOf('git fetch --all --prune --tags')
    const verifyIndex = pipeline.indexOf('npm run lint')
    const releaseIndex = pipeline.indexOf('nx release --yes')

    expect(checkoutIndex).toBeGreaterThan(-1)
    expect(attachIndex).toBeGreaterThan(checkoutIndex)
    expect(fetchIndex).toBeGreaterThan(attachIndex)
    expect(verifyIndex).toBeGreaterThan(fetchIndex)
    expect(releaseIndex).toBeGreaterThan(verifyIndex)
  })

  it('authenticates npm via the base64 PAT env, not npmAuthenticate', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    expect(pipeline).toContain('persistCredentials: true')
    expect(pipeline).toContain('git config user.name')
    expect(pipeline).toContain('PAT: $(PAT)')
    expect(pipeline).not.toContain('npmAuthenticate')
    expect(pipeline).not.toContain('NODE_AUTH_TOKEN')
    expect(pipeline).toContain("ne(variables['Build.Reason'], 'PullRequest')")
    expect(pipeline).toContain("eq(variables['Build.SourceBranchName'], 'main')")
  })

  it('authenticates npm via NODE_AUTH_TOKEN (an NPM_TOKEN variable), not PAT, for the public npm registry', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build', undefined, 'npm')

    expect(pipeline).toContain('NODE_AUTH_TOKEN: $(NPM_TOKEN)')
    expect(pipeline).not.toContain('PAT: $(PAT)')
    // Still reads secrets from the same Library variable group — only the
    // variable name inside it differs, so no new CLI-collected value is needed.
    expect(pipeline).toContain('- group: Build')
  })

  it('does not reference any custom CI engine — the pipeline is plain Nx', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    expect(pipeline).not.toContain('build-templates')
    expect(pipeline).not.toContain('monecromanci-toolchain')
    expect(pipeline).not.toContain('.mjs')
  })

  it('is cross-platform: no multi-line shell blocks, no bash-isms, no PowerShell', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // Every script step must be a single-line command (cmd.exe and sh both
    // run it); a block scalar would mean OS-specific shell scripting.
    expect(pipeline).not.toContain('script: |')
    expect(pipeline).not.toContain('shopt')
    expect(pipeline).not.toContain('for host in')
    expect(pipeline).not.toContain('if [')
    expect(pipeline).not.toContain('powershell')
    expect(pipeline).not.toContain('pwsh')
  })

  it('folds twine publish credentials (base64 PAT decoded) into the release step for an Azure feed', () => {
    const url = 'https://pkgs.dev.azure.com/org/proj/_packaging/feed/pypi/upload/'
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build', url)

    // One unified release step (npm + Python), not a separate publish step.
    expect(pipeline).toContain('Release — version, tag and publish (npm + Python)')
    expect(pipeline).not.toContain('nx run-many -t publish')
    // The release step exports twine publish creds when there are Python packages.
    expect(pipeline).toContain(`TWINE_REPOSITORY_URL='${url}'`)
    // Reuses the base64 PAT from the group, decoded to the raw token twine needs.
    expect(pipeline).toContain(`Buffer.from(process.env.PAT,'base64')`)
    // Guarded on either publishable dir.
    expect(pipeline).toContain(`globSync('python-packages/*/pyproject.toml')`)
    expect(pipeline).toContain(`globSync('packages/*/package.json')`)
    // A guarded step installs the fixed pip toolchain before any Python target runs.
    expect(pipeline).toContain('-m pip install -r requirements-dev.txt')
    // Resolves python vs python3 by platform, not hard-coded (Windows agents
    // have no python3.exe).
    expect(pipeline).toContain(`process.platform==='win32'?'python':'python3'`)
    // A second guarded step editable-installs every Python project so
    // cross-project imports (internal libs included) resolve at test time.
    expect(pipeline).toContain('Install Python project dependencies (editable, workspace-wide)')
  })

  it('still versions/tags Python on public npm, but exports no twine publish creds', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')
    // Python packages are always in the release scope (versioning + tags)…
    expect(pipeline).toContain(`globSync('python-packages/*/pyproject.toml')`)
    // …but without an Azure feed the release step sets no TWINE_* env.
    expect(pipeline).not.toContain('TWINE_REPOSITORY_URL')
  })

  it('verifies every run with npm run lint then test+build, no affected branching', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // The run-many also carries `lint` so Nx-native lint targets `npm run lint`
    // misses (Python's ruff) still run in CI.
    expect(pipeline).toContain('npm run lint')
    expect(pipeline).toContain('npx nx run-many -t lint,test,build')
    expect(pipeline).not.toContain('nx affected')
  })

  it('gates formatting with its own format:check step, after lint', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // Load-bearing, and easy to drop as redundant-looking: ESLint here is
    // configured for correctness ONLY (eslint-config-prettier is composed last
    // in @mnci/eslint-config), so it reports nothing whatsoever about
    // formatting. Without this step Prettier is advisory — mnci deletes Nx's
    // .prettierrc precisely so its own config takes effect, then nothing would
    // ever check that it holds.
    expect(pipeline).toContain('npm run format:check')
    expect(pipeline.indexOf('npm run format:check')).toBeGreaterThan(
      pipeline.indexOf('npm run lint')
    )
  })

  it('checks the workspace is synced early, before lint/test/build (fails fast on a stale TS reference)', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    const installIndex = pipeline.indexOf('npm ci')
    const syncCheckIndex = pipeline.indexOf('nx sync:check')
    const lintIndex = pipeline.indexOf('npm run lint')

    expect(syncCheckIndex).toBeGreaterThan(installIndex)
    expect(lintIndex).toBeGreaterThan(syncCheckIndex)
  })

  it('installs every Python project editably after the fixed toolchain, before sync:check', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    const toolchainIndex = pipeline.indexOf(
      'Install Python dependencies (ruff, pytest, build, twine, pip-audit)'
    )
    const workspaceInstallIndex = pipeline.indexOf(
      'Install Python project dependencies (editable, workspace-wide)'
    )
    const syncCheckIndex = pipeline.indexOf('nx sync:check')

    expect(workspaceInstallIndex).toBeGreaterThan(toolchainIndex)
    expect(syncCheckIndex).toBeGreaterThan(workspaceInstallIndex)
    // One pip invocation covers every project kind: editable-installs apps,
    // publishable libs and internal libs (all have a pyproject.toml), and
    // installs function apps' requirements.txt (no pyproject.toml to editable-install).
    expect(pipeline).toContain(`globSync('apps/*/pyproject.toml')`)
    expect(pipeline).toContain(`globSync('python-packages/*/pyproject.toml')`)
    expect(pipeline).toContain(`globSync('libs/*/pyproject.toml')`)
    expect(pipeline).toContain(`globSync('apps/*/requirements.txt')`)
    expect(pipeline).toContain(`'-m','pip','install','--quiet'`)
  })

  it('runs npm audit right after npm ci, and pip-audit right after the workspace-wide Python install, both non-blocking', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    const npmInstallIndex = pipeline.indexOf('npm ci')
    const npmAuditIndex = pipeline.indexOf('npm audit --audit-level=high')
    const pythonWorkspaceInstallIndex = pipeline.indexOf(
      'Install Python project dependencies (editable, workspace-wide)'
    )
    const pipAuditIndex = pipeline.indexOf(`'-m','pip_audit'`)
    const syncCheckIndex = pipeline.indexOf('nx sync:check')

    expect(npmAuditIndex).toBeGreaterThan(npmInstallIndex)
    expect(pipAuditIndex).toBeGreaterThan(pythonWorkspaceInstallIndex)
    expect(syncCheckIndex).toBeGreaterThan(pipAuditIndex)
    // Non-blocking: neither step's failure can fail the pipeline.
    expect(pipeline).toContain('npm audit --audit-level=high || echo')
    expect(pipeline).toContain('displayName: npm audit (non-blocking)')
    expect(pipeline).toContain('displayName: pip-audit (non-blocking)')
  })

  it('seeds the Go toolchain before the build, and skips cleanly without a root go.mod', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    const goDownloadIndex = pipeline.indexOf('Download Go module dependencies')
    const golangciIndex = pipeline.indexOf('Install golangci-lint')
    const pathIndex = pipeline.indexOf('Add Go tool bin to PATH')
    const syncCheckIndex = pipeline.indexOf('nx sync:check')

    expect(goDownloadIndex).toBeGreaterThan(-1)
    // PATH must be published after the install that populates GOPATH/bin,
    // and all of it before anything that runs the lint target.
    expect(pathIndex).toBeGreaterThan(golangciIndex)
    expect(syncCheckIndex).toBeGreaterThan(pathIndex)

    // Every Go step is gated on the root go.mod, so a JS-only workspace pays
    // nothing — the same shape as the Python guards' requirements-dev.txt check.
    expect(pipeline).toContain("existsSync('go.mod')")
    expect(pipeline).toContain('No Go projects - skipping.')
    // Azure's own mechanism for a step to extend PATH for later steps.
    expect(pipeline).toContain('##vso[task.prependpath]')
  })

  it('pins golangci-lint as the Go linter rather than the plugin default of go fmt', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    expect(pipeline).toContain('golangci-lint')
    // Skips the install when the agent already provides the binary.
    expect(pipeline).toContain('golangci-lint already installed - skipping.')
  })

  it('installs the Flutter SDK itself, unlike Python and Go which ship on the agent', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    const installIndex = pipeline.indexOf('Install the Flutter SDK')
    const pathIndex = pipeline.indexOf('Add the Flutter SDK to PATH')
    const pubGetIndex = pipeline.indexOf('Resolve Dart dependencies')
    const syncCheckIndex = pipeline.indexOf('nx sync:check')

    expect(installIndex).toBeGreaterThan(-1)
    // PATH must be published after the clone, and pub get needs both — then
    // everything must precede anything that runs a Flutter target.
    expect(pathIndex).toBeGreaterThan(installIndex)
    expect(pubGetIndex).toBeGreaterThan(pathIndex)
    expect(syncCheckIndex).toBeGreaterThan(pubGetIndex)

    // Every Flutter step is gated on the root pubspec.yaml that the plugin's
    // generators write, so a JS-only workspace pays nothing.
    expect(pipeline).toContain("existsSync('pubspec.yaml')")
    expect(pipeline).toContain('No Flutter projects - skipping.')
  })

  it('pins the Flutter SDK version, because it determines the Dart version', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // Pub workspaces need Dart 3.6+, so a floating `stable` could move the
    // toolchain under a workspace. Cloned at an explicit tag instead.
    expect(pipeline).toContain(FLUTTER_SDK_VERSION)
    expect(pipeline).toContain(`'--branch','${FLUTTER_SDK_VERSION}'`)
    expect(pipeline).toContain('https://github.com/flutter/flutter.git')
    // Skips entirely when an SDK is already available.
    expect(pipeline).toContain('Flutter SDK already on PATH - skipping.')
  })

  it('installs the Flutter SDK outside the workspace, so its own pubspecs cannot leak in', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // The SDK ships dozens of its own pubspec.yaml files; cloning it inside the
    // workspace would drop them into the pub workspace tree and give Nx
    // thousands of extra files to glob. Version-keyed so a bump re-provisions.
    expect(pipeline).toContain("require('node:os').homedir()")
    expect(pipeline).toContain(`.mnci-flutter-${FLUTTER_SDK_VERSION}`)
    expect(pipeline).not.toContain("'.flutter-sdk'")
  })

  it('resolves every Dart dependency with a single root pub get', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // Dart has a real workspace protocol, so unlike Python there is no second
    // per-project install step: one pub get covers internal AND external deps.
    expect(pipeline).toContain("'pub','get'")
    expect(pipeline).toContain('one pub get for the whole workspace')
  })

  it('packs all apps into one drop artifact, tags per app, then releases — in order', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    const packIndex = pipeline.indexOf('nx run-many -t package')
    const publishDropIndex = pipeline.indexOf('ArtifactName: drop')
    const tagIndex = pipeline.indexOf('##vso[build.addbuildtag]')
    const releaseIndex = pipeline.indexOf('nx release --yes')

    expect(packIndex).toBeGreaterThan(-1)
    expect(publishDropIndex).toBeGreaterThan(packIndex)
    expect(tagIndex).toBeGreaterThan(publishDropIndex)
    expect(releaseIndex).toBeGreaterThan(tagIndex)
    expect(pipeline).toContain('PathtoPublish: $(Build.SourcesDirectory)/dist/drop')
    // The build tag is derived from the zip filenames, so it is exactly the
    // zip's <type>-<name> basename.
    expect(pipeline).toContain(`path.basename(f,'.zip')`)
  })

  it('guards pack and release with portable node one-liners while apps/packages are empty', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    expect(pipeline).toContain(`globSync('apps/*/project.json')`)
    expect(pipeline).toContain(`globSync('packages/*/package.json')`)
    expect(pipeline).toContain('nx release --yes')
  })
})

describe('githubActionsYaml', () => {
  it('stamps the chosen agent as runs-on', () => {
    expect(githubActionsYaml('ubuntu-latest')).toContain('runs-on: ubuntu-latest')
    expect(githubActionsYaml('MyRunnerLabel')).toContain('runs-on: MyRunnerLabel')
  })

  it('is valid YAML with the expected top-level shape', () => {
    const document_ = yaml.load(githubActionsYaml('ubuntu-latest')) as {
      on?: { push?: unknown; pull_request?: unknown }
      permissions?: { contents?: string }
      jobs?: { ci?: { steps?: unknown[] } }
    }
    expect(document_.on?.push).toBeTruthy()
    expect(document_.on?.pull_request).toBeTruthy()
    expect(document_.permissions?.contents).toBe('write')
    expect(Array.isArray(document_.jobs?.ci?.steps)).toBe(true)
  })

  it('does not attach HEAD to a branch (actions/checkout is never detached on a push-triggered run)', () => {
    const workflow = githubActionsYaml('ubuntu-latest')
    expect(workflow).toContain('actions/checkout@v4')
    expect(workflow).not.toContain('checkout -B')
  })

  it('authenticates npm via a PAT repository secret, not a variable group', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    expect(workflow).toContain('secrets.PAT')
    expect(workflow).not.toContain('npmAuthenticate')
    expect(workflow).not.toContain('- group:')
    expect(workflow).not.toContain('NODE_AUTH_TOKEN')
  })

  it('authenticates npm via NODE_AUTH_TOKEN (an NPM_TOKEN secret), not PAT, for the public npm registry', () => {
    const workflow = githubActionsYaml('ubuntu-latest', undefined, 'npm')

    expect(workflow).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}')
    expect(workflow).not.toContain('secrets.PAT')
  })

  it('does not reference any custom CI engine — the workflow is plain Nx', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    expect(workflow).not.toContain('build-templates')
    expect(workflow).not.toContain('monecromanci-toolchain')
    expect(workflow).not.toContain('.mjs')
  })

  it('folds twine publish credentials (base64 PAT decoded) into the release step for an Azure feed', () => {
    const url = 'https://pkgs.dev.azure.com/org/proj/_packaging/feed/pypi/upload/'
    const workflow = githubActionsYaml('ubuntu-latest', url)

    expect(workflow).toContain('Release — version, tag, publish and GitHub Release (npm + Python)')
    expect(workflow).not.toContain('nx run-many -t publish')
    expect(workflow).toContain(`TWINE_REPOSITORY_URL='${url}'`)
    expect(workflow).toContain(`Buffer.from(process.env.PAT,'base64')`)
    expect(workflow).toContain(`globSync('python-packages/*/pyproject.toml')`)
    expect(workflow).toContain(`globSync('packages/*/package.json')`)
    expect(workflow).toContain('-m pip install -r requirements-dev.txt')
    expect(workflow).toContain(`process.platform==='win32'?'python':'python3'`)
    expect(workflow).toContain('Install Python project dependencies (editable, workspace-wide)')
  })

  it('still versions/tags Python on public npm, but exports no twine publish creds', () => {
    const workflow = githubActionsYaml('ubuntu-latest')
    expect(workflow).toContain(`globSync('python-packages/*/pyproject.toml')`)
    expect(workflow).not.toContain('TWINE_REPOSITORY_URL')
  })

  it('verifies every run linter-agnostically (npm run lint) then test+build, no affected branching', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    expect(workflow).toContain('npm run lint')
    expect(workflow).toContain('npx nx run-many -t lint,test,build')
    expect(workflow).not.toContain('nx affected')
  })

  it('checks the workspace is synced early, before lint/test/build (fails fast on a stale TS reference)', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    const installIndex = workflow.indexOf('npm ci')
    const syncCheckIndex = workflow.indexOf('nx sync:check')
    const lintIndex = workflow.indexOf('npm run lint')

    expect(syncCheckIndex).toBeGreaterThan(installIndex)
    expect(lintIndex).toBeGreaterThan(syncCheckIndex)
  })

  it('installs every Python project editably after the fixed toolchain, before sync:check', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    const toolchainIndex = workflow.indexOf(
      'Install Python dependencies (ruff, pytest, build, twine, pip-audit)'
    )
    const workspaceInstallIndex = workflow.indexOf(
      'Install Python project dependencies (editable, workspace-wide)'
    )
    const syncCheckIndex = workflow.indexOf('nx sync:check')

    expect(workspaceInstallIndex).toBeGreaterThan(toolchainIndex)
    expect(syncCheckIndex).toBeGreaterThan(workspaceInstallIndex)
    expect(workflow).toContain(`globSync('apps/*/pyproject.toml')`)
    expect(workflow).toContain(`globSync('python-packages/*/pyproject.toml')`)
    expect(workflow).toContain(`globSync('libs/*/pyproject.toml')`)
    expect(workflow).toContain(`globSync('apps/*/requirements.txt')`)
    expect(workflow).toContain(`'-m','pip','install','--quiet'`)
  })

  it('runs npm audit right after npm ci, and pip-audit right after the workspace-wide Python install, both non-blocking', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    const npmInstallIndex = workflow.indexOf('npm ci')
    const npmAuditIndex = workflow.indexOf('npm audit --audit-level=high')
    const pythonWorkspaceInstallIndex = workflow.indexOf(
      'Install Python project dependencies (editable, workspace-wide)'
    )
    const pipAuditIndex = workflow.indexOf(`'-m','pip_audit'`)
    const syncCheckIndex = workflow.indexOf('nx sync:check')

    expect(npmAuditIndex).toBeGreaterThan(npmInstallIndex)
    expect(pipAuditIndex).toBeGreaterThan(pythonWorkspaceInstallIndex)
    expect(syncCheckIndex).toBeGreaterThan(pipAuditIndex)
    expect(workflow).toContain('npm audit --audit-level=high || echo')
    expect(workflow).toContain('name: npm audit (non-blocking)')
    expect(workflow).toContain('name: pip-audit (non-blocking)')
  })

  it('seeds the Go toolchain before the build, using GITHUB_PATH rather than the Azure logging command', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    const goDownloadIndex = workflow.indexOf('Download Go module dependencies')
    const golangciIndex = workflow.indexOf('Install golangci-lint')
    const pathIndex = workflow.indexOf('Add Go tool bin to PATH')
    const syncCheckIndex = workflow.indexOf('nx sync:check')

    expect(goDownloadIndex).toBeGreaterThan(-1)
    expect(pathIndex).toBeGreaterThan(golangciIndex)
    expect(syncCheckIndex).toBeGreaterThan(pathIndex)

    expect(workflow).toContain("existsSync('go.mod')")
    expect(workflow).toContain('No Go projects - skipping.')
    // The two providers publish PATH differently; this one appends to a file.
    expect(workflow).toContain('GITHUB_PATH')
    expect(workflow).not.toContain('##vso[task.prependpath]')
  })

  it('installs the Flutter SDK and publishes it via GITHUB_PATH, not the Azure logging command', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    const installIndex = workflow.indexOf('Install the Flutter SDK')
    const pathIndex = workflow.indexOf('Add the Flutter SDK to PATH')
    const pubGetIndex = workflow.indexOf('Resolve Dart dependencies')

    expect(installIndex).toBeGreaterThan(-1)
    expect(pathIndex).toBeGreaterThan(installIndex)
    expect(pubGetIndex).toBeGreaterThan(pathIndex)

    expect(workflow).toContain("existsSync('pubspec.yaml')")
    expect(workflow).toContain('No Flutter projects - skipping.')
    expect(workflow).toContain(FLUTTER_SDK_VERSION)
    // Same PATH-publishing split as the Go pair.
    expect(workflow).toContain('GITHUB_PATH')
    expect(workflow).not.toContain('##vso[task.prependpath]')
  })

  it('packs all apps into one drop artifact, then releases — in order, gated to main-only', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    const packIndex = workflow.indexOf('nx run-many -t package')
    const uploadIndex = workflow.indexOf('actions/upload-artifact@v4')
    const releaseIndex = workflow.indexOf('nx release --yes')

    expect(packIndex).toBeGreaterThan(-1)
    expect(uploadIndex).toBeGreaterThan(packIndex)
    expect(releaseIndex).toBeGreaterThan(uploadIndex)
    expect(workflow).toContain('path: dist/drop')
    // No Azure classic-Release-pipeline build-tag mechanism — no equivalent on GitHub.
    expect(workflow).not.toContain('addbuildtag')
  })

  it('creates GitHub Releases and lets nx push its own tag when github is the only provider', () => {
    const workflow = githubActionsYaml('ubuntu-latest', undefined, 'azure-artifacts', 'github')

    expect(workflow).toContain('GITHUB_TOKEN')
    expect(workflow).toContain('secrets.GITHUB_TOKEN')
    // Nx pushes the tag itself now (release.git.push: true) — the pipeline's
    // own explicit push step would be redundant, so it must be gone.
    expect(workflow).not.toContain('git push origin --tags')
  })

  it('defaults to the github-only behaviour when ci is omitted', () => {
    const withDefault = githubActionsYaml('ubuntu-latest')
    const withExplicit = githubActionsYaml('ubuntu-latest', undefined, 'azure-artifacts', 'github')
    expect(withDefault).toBe(withExplicit)
  })

  it('keeps the explicit tag push and skips GitHub Release creation when both providers are configured', () => {
    const workflow = githubActionsYaml('ubuntu-latest', undefined, 'azure-artifacts', 'both')
    expect(() => yaml.load(workflow)).not.toThrow()

    expect(workflow).not.toContain('GITHUB_TOKEN')
    expect(workflow).toContain('git push origin --tags')
    expect(workflow).toContain(
      "Push release tags (nx release's own push never runs without a remote Release configured)"
    )
  })

  it('runs the same guard scripts as azure-pipelines.yml (both providers can never drift)', () => {
    const azure = azurePipelinesYaml(
      'ubuntu-latest',
      'Build',
      'https://example.invalid/pypi/upload/'
    )
    const github = githubActionsYaml('ubuntu-latest', 'https://example.invalid/pypi/upload/')

    expect(github).toContain('-m pip install -r requirements-dev.txt')
    expect(azure).toContain('-m pip install -r requirements-dev.txt')
    expect(github).toContain(`process.platform==='win32'?'python':'python3'`)
    expect(azure).toContain(`process.platform==='win32'?'python':'python3'`)
    expect(github).toContain(`globSync('apps/*/pyproject.toml')`)
    expect(azure).toContain(`globSync('apps/*/pyproject.toml')`)
    expect(github).toContain(`globSync('apps/*/project.json')`)
    expect(azure).toContain(`globSync('apps/*/project.json')`)
    expect(github).toContain(`Buffer.from(process.env.PAT,'base64')`)
    expect(azure).toContain(`Buffer.from(process.env.PAT,'base64')`)

    // The Flutter SDK install and the root pub get are byte-identical in both.
    // Only the PATH step legitimately differs, because the two providers have
    // genuinely different mechanisms for extending PATH — asserted separately
    // in each provider's own test above.
    const flutterInstall = `'--branch','${FLUTTER_SDK_VERSION}','https://github.com/flutter/flutter.git'`
    expect(github).toContain(flutterInstall)
    expect(azure).toContain(flutterInstall)
    expect(github).toContain(`'pub','get'`)
    expect(azure).toContain(`'pub','get'`)
    expect(github).toContain('No Flutter projects - skipping.')
    expect(azure).toContain('No Flutter projects - skipping.')

    // Both providers gate formatting, not just one — the whole point of this
    // test is that a step added to one provider cannot be forgotten in the
    // other.
    expect(github).toContain('npm run format:check')
    expect(azure).toContain('npm run format:check')
  })
})

describe('withEslintPlugin', () => {
  it('registers @nx/eslint/plugin, which is what gives every project a lint target', () => {
    // create-nx-workspace does not add this; Nx used to, as an invisible side
    // effect of the first `nx g … --linter=eslint`. mnci passes `--linter=none`
    // now, so without this registration no project would get a lint target at
    // all — and `npm run lint` in a fresh workspace would silently do nothing.
    const patched = withEslintPlugin({ plugins: [{ plugin: '@nx/js/typescript' }] })

    expect(patched.plugins).toEqual([
      { plugin: '@nx/js/typescript' },
      { plugin: '@nx/eslint/plugin', options: { targetName: 'lint' } },
    ])
  })

  it('is idempotent, so `mnci upgrade` cannot accumulate duplicates', () => {
    const once = withEslintPlugin({ plugins: [] })

    expect(withEslintPlugin(once).plugins).toEqual(once.plugins)
  })

  it("leaves an existing registration's own options alone", () => {
    // A workspace generated before this existed has Nx's entry already. Its
    // targetName may have been customised; overwriting it would rename every
    // project's lint target out from under the user's scripts.
    const existing = { plugin: '@nx/eslint/plugin', options: { targetName: 'eslint-check' } }

    expect(withEslintPlugin({ plugins: [existing] }).plugins).toEqual([existing])
  })

  it('handles the bare-string plugin form Nx also accepts', () => {
    expect(withEslintPlugin({ plugins: ['@nx/eslint/plugin'] }).plugins).toEqual([
      '@nx/eslint/plugin',
    ])
  })

  it('copes with an nx.json that has no plugins key at all', () => {
    expect(withEslintPlugin({}).plugins).toEqual([
      { plugin: '@nx/eslint/plugin', options: { targetName: 'lint' } },
    ])
  })
})

describe('generatorDefaults', () => {
  it("sets linter 'none' — the root config lints everything — and carries the testRunner", () => {
    // Not a regression: `none` stops a direct `nx g` from scaffolding a
    // per-project config that would compete with the workspace's single root
    // one. `@nx/eslint/plugin` still gives the project its `lint` target.
    const defaults = generatorDefaults({ testRunner: 'jest' }) as Record<
      string,
      { linter: string; unitTestRunner: string }
    >
    expect(defaults['@nx/js:library']).toEqual({ linter: 'none', unitTestRunner: 'jest' })
    expect(defaults['@nx/react:application']).toEqual({ linter: 'none', unitTestRunner: 'jest' })
  })
})

describe('mnciConfig', () => {
  it('persists the full resolved overlay options — what `add` and `upgrade` each read back a slice of', () => {
    const options = {
      scope: '@demo',
      registry: { kind: 'npm' } as const,
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'github' as const,
      stack: { testRunner: 'vitest' as const },
    }
    expect(mnciConfig(options)).toEqual({
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'github',
      stack: { testRunner: 'vitest' },
    })
  })
})

describe('readMnciConfig', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-read-config-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('reads back exactly what applyOverlay persisted', () => {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ $schema: 's', namedInputs: {} }))
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: '@org/source', private: true, devDependencies: { nx: '23.0.0' } })
    )
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'github',
      stack: DEFAULT_STACK,
    })

    expect(readMnciConfig(workspaceRoot)).toEqual({
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'github',
      stack: DEFAULT_STACK,
    })
  })

  it('returns an empty object for a workspace with no mnci block at all (predates persistence)', () => {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ $schema: 's' }))

    expect(readMnciConfig(workspaceRoot)).toEqual({})
  })
})

describe('rootScripts', () => {
  it('uses nx lint and prettier format scripts', () => {
    const scripts = rootScripts({ testRunner: 'jest' })
    expect(scripts.lint).toBe('nx run-many -t lint')
    expect(scripts.format).toBe('prettier --write .')
    expect(scripts['format:check']).toBe('prettier --check .')
  })

  it('adds python:install chaining the same two guards CI runs (for local-dev convenience)', () => {
    const scripts = rootScripts({ testRunner: 'jest' })

    // Fixed dev toolchain (ruff/pytest/build/twine from requirements-dev.txt) ...
    expect(scripts['python:install']).toContain('-m pip install -r requirements-dev.txt')
    // ... then the workspace-wide editable install of every Python project.
    expect(scripts['python:install']).toContain(`globSync('apps/*/pyproject.toml')`)
    expect(scripts['python:install']).toContain(`globSync('python-packages/*/pyproject.toml')`)
    expect(scripts['python:install']).toContain(`globSync('libs/*/pyproject.toml')`)
    // Chained (not parallel), toolchain install first.
    const toolchainIndex = scripts['python:install'].indexOf(
      '-m pip install -r requirements-dev.txt'
    )
    const workspaceIndex = scripts['python:install'].indexOf(`globSync('apps/*/pyproject.toml')`)
    expect(toolchainIndex).toBeGreaterThan(-1)
    expect(workspaceIndex).toBeGreaterThan(toolchainIndex)
  })

  it('stamps python:install in all stacks (both guards already no-op on a workspace with no Python projects)', () => {
    expect(rootScripts({ testRunner: 'jest' })['python:install']).toBeDefined()
    expect(rootScripts({ testRunner: 'vitest' })['python:install']).toBeDefined()
  })
})

describe('applyOverlay', () => {
  let workspaceRoot: string

  const overlayWith = (stack: StackConfig): void =>
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'azure',
      stack,
    })

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-overlay-'))
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ $schema: 's', namedInputs: {} }))
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: '@org/source', private: true, devDependencies: { nx: '23.0.0' } })
    )
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('writes the five overlay files and leaves the rest of nx.json intact', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'azure',
      stack: DEFAULT_STACK,
    })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(nxJson.$schema).toBe('s')
    expect(nxJson.release).toBeDefined()

    expect(existsSync(join(workspaceRoot, '.npmrc'))).toBe(true)
    expect(readFileSync(join(workspaceRoot, 'commitlint.config.mjs'), 'utf8')).toContain(
      '@commitlint/config-conventional'
    )
    expect(readFileSync(join(workspaceRoot, '.husky/commit-msg'), 'utf8')).toContain(
      'commitlint --edit'
    )
    const pipeline = readFileSync(join(workspaceRoot, 'azure-pipelines.yml'), 'utf8')
    expect(pipeline).toContain('  vmImage: ubuntu-latest')
    expect(pipeline).toContain('- group: Build')
  })

  it('writes only azure-pipelines.yml when ci: "azure" (the default)', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'azure',
      stack: DEFAULT_STACK,
    })

    expect(existsSync(join(workspaceRoot, 'azure-pipelines.yml'))).toBe(true)
    expect(existsSync(join(workspaceRoot, '.github/workflows/ci.yml'))).toBe(false)
  })

  it('writes only .github/workflows/ci.yml when ci: "github"', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'github',
      stack: DEFAULT_STACK,
    })

    expect(existsSync(join(workspaceRoot, 'azure-pipelines.yml'))).toBe(false)
    const workflow = readFileSync(join(workspaceRoot, '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toContain('runs-on: ubuntu-latest')
    // Public npm: the CI must actually be able to authenticate a publish —
    // NODE_AUTH_TOKEN (matching .npmrc), not the Azure-Artifacts-only PAT.
    expect(workflow).toContain('NODE_AUTH_TOKEN')
    expect(workflow).not.toContain('secrets.PAT')
  })

  it('threads the registry kind through to azure-pipelines.yml too, when both providers are chosen for a public npm registry', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'both',
      stack: DEFAULT_STACK,
    })

    const pipeline = readFileSync(join(workspaceRoot, 'azure-pipelines.yml'), 'utf8')
    expect(pipeline).toContain('NODE_AUTH_TOKEN: $(NPM_TOKEN)')
    expect(pipeline).not.toContain('PAT: $(PAT)')
  })

  it('writes both pipeline files when ci: "both"', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'both',
      stack: DEFAULT_STACK,
    })

    expect(existsSync(join(workspaceRoot, 'azure-pipelines.yml'))).toBe(true)
    expect(existsSync(join(workspaceRoot, '.github/workflows/ci.yml'))).toBe(true)
  })

  it('never writes .github/dependabot.yml when ci: "azure" (the default) — Dependabot is GitHub-native', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'azure',
      stack: DEFAULT_STACK,
    })

    expect(existsSync(join(workspaceRoot, '.github/dependabot.yml'))).toBe(false)
  })

  it('writes .github/dependabot.yml alongside the workflow for ci: "github"', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'github',
      stack: DEFAULT_STACK,
    })

    const dependabot = readFileSync(join(workspaceRoot, '.github/dependabot.yml'), 'utf8')
    const parsed = yaml.load(dependabot) as {
      updates: Array<{ 'package-ecosystem': string; directory?: string; directories?: string[] }>
    }
    expect(parsed.updates.map(update => update['package-ecosystem'])).toEqual([
      'npm',
      'github-actions',
      'pip',
      'pub',
    ])
    // pip covers wherever a Python project might later land (add python-*),
    // via directories that currently match nothing — not an error for Dependabot.
    expect(
      parsed.updates.find(update => update['package-ecosystem'] === 'pip')?.directories
    ).toEqual(['/apps/*', '/python-packages/*', '/libs/*'])
    // pub, same reasoning, for the three directories Flutter projects land in.
    // Per-project rather than just "/" because each pub workspace member
    // declares its own dependencies even though they all resolve through the
    // single root pubspec.lock.
    expect(
      parsed.updates.find(update => update['package-ecosystem'] === 'pub')?.directories
    ).toEqual(['/apps/*', '/packages/*', '/libs/*'])
  })

  it('writes .github/dependabot.yml for ci: "both" too', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'both',
      stack: DEFAULT_STACK,
    })

    expect(existsSync(join(workspaceRoot, '.github/dependabot.yml'))).toBe(true)
  })

  it('turns on sync.applyChanges so a stale TS project reference is fixed automatically, not just prompted', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'azure',
      stack: DEFAULT_STACK,
    })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as {
      sync?: { applyChanges?: boolean }
    }
    expect(nxJson.sync?.applyChanges).toBe(true)
  })

  it("writes the stack as nx.json generator defaults (for a user's own direct `nx g`)", () => {
    overlayWith({ testRunner: 'vitest' })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as {
      generators: Record<string, { linter: string; unitTestRunner: string }>
    }
    expect(nxJson.generators['@nx/js:library']).toEqual({
      linter: 'none',
      unitTestRunner: 'vitest',
    })
  })

  it('writes mnci.stack — the single source of truth `add` reads back, not the generator defaults', () => {
    overlayWith({ testRunner: 'vitest' })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as {
      mnci: { stack: { testRunner: string } }
    }
    expect(nxJson.mnci.stack).toEqual({ testRunner: 'vitest' })
  })

  it('writes the whole mnci block — scope/registry/agent/variableGroup/ci — so `mnci upgrade` can reconstruct the exact options a later run resolved', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: {
        kind: 'azure-artifacts',
        organization: 'org',
        project: 'proj',
        artifactsFeed: 'feed',
      },
      agent: 'windows-latest',
      variableGroup: 'CiSecrets',
      ci: 'both',
      stack: DEFAULT_STACK,
    })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as {
      mnci: Record<string, unknown>
    }
    expect(nxJson.mnci).toEqual({
      scope: '@demo',
      registry: {
        kind: 'azure-artifacts',
        organization: 'org',
        project: 'proj',
        artifactsFeed: 'feed',
      },
      agent: 'windows-latest',
      variableGroup: 'CiSecrets',
      ci: 'both',
      stack: DEFAULT_STACK,
    })
  })

  it('writes Prettier config and VS Code extensions when eslint is used', () => {
    overlayWith(DEFAULT_STACK)
    expect(existsSync(join(workspaceRoot, '.prettierrc.json'))).toBe(true)
    expect(existsSync(join(workspaceRoot, '.prettierignore'))).toBe(true)
    expect(existsSync(join(workspaceRoot, 'demo.code-workspace'))).toBe(true)
    const scripts = (
      JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    expect(scripts.lint).toBe('nx run-many -t lint')
    expect(scripts.format).toBe('prettier --write .')
    expect(scripts['format:check']).toBe('prettier --check .')
    // Check VS Code workspace file
    const workspace = JSON.parse(
      readFileSync(join(workspaceRoot, 'demo.code-workspace'), 'utf8')
    ) as {
      folders: { path: string; name: string }[]
      extensions: { recommendations: string[] }
      tasks: { version: string; tasks: unknown[] }
    }
    expect(workspace.extensions.recommendations).toContain('dbaeumer.vscode-eslint')
    expect(workspace.extensions.recommendations).toContain('esbenp.prettier-vscode')
    // Generic across every generated workspace — no hardcoded package names
    // from this repo's own dogfooded root leaking into the template.
    expect(workspace.folders).toEqual([{ path: '.', name: 'demo' }])
    // Starts empty; `add/*.ts`'s registerProjectCommands appends a task per
    // project as it's added (see commands/add/shared.test.ts).
    expect(workspace.tasks).toEqual({ version: '2.0.0', tasks: [] })
  })

  it('writes a root eslint config that delegates to @mnci/eslint-config', () => {
    overlayWith(DEFAULT_STACK)

    // ESLint config is an mnci-owned file as of this change. Before it, a
    // generated workspace kept create-nx-workspace's bare @nx/eslint-plugin
    // default while the rich rules lived only in mnci's own repo.
    const config = readFileSync(join(workspaceRoot, 'eslint.config.mjs'), 'utf8')
    expect(config).toContain("import mnci from '@mnci/eslint-config'")
    // workspaceRoot is what enables the @nx/dependency-checks block, which has
    // to scan for private manifests.
    expect(config).toContain('workspaceRoot: import.meta.dirname')

    const devDependencies = (
      JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
        devDependencies: Record<string, string>
      }
    ).devDependencies
    expect(devDependencies['@mnci/eslint-config']).toBeDefined()
  })

  it('deletes the .prettierrc that create-nx-workspace leaves behind', () => {
    // Load-bearing, not tidying: .prettierrc resolves BEFORE .prettierrc.json,
    // so while both existed every option in PRETTIER_CONFIG was ignored and the
    // effective config in every generated workspace was Nx's {singleQuote:true}.
    writeFileSync(join(workspaceRoot, '.prettierrc'), '{ "singleQuote": true }\n')

    overlayWith(DEFAULT_STACK)

    expect(existsSync(join(workspaceRoot, '.prettierrc'))).toBe(false)
    expect(existsSync(join(workspaceRoot, '.prettierrc.json'))).toBe(true)
  })

  it('deletes the .vscode directory, whose content the .code-workspace file already carries', () => {
    mkdirSync(join(workspaceRoot, '.vscode'), { recursive: true })
    writeFileSync(join(workspaceRoot, '.vscode/extensions.json'), '{}')

    overlayWith(DEFAULT_STACK)

    expect(existsSync(join(workspaceRoot, '.vscode'))).toBe(false)
    expect(existsSync(join(workspaceRoot, 'demo.code-workspace'))).toBe(true)
  })

  it('sweeps per-project eslint configs, so `mnci upgrade` de-fragments an old workspace', () => {
    // This is the migration path that matters. `mnci add` deletes the config
    // its own generator writes, but that only helps projects created from now
    // on — a workspace generated before mnci owned linting carries one in every
    // project directory, and without this an upgrade would install the root
    // config while leaving each project linting against its own stale rules.
    for (const projectRoot of ['apps/web', 'libs/utils', 'packages/sdk']) {
      mkdirSync(join(workspaceRoot, projectRoot), { recursive: true })
      writeFileSync(join(workspaceRoot, projectRoot, 'eslint.config.mjs'), 'export default []')
    }
    // A non-default extension, and a path outside the three project dirs.
    writeFileSync(join(workspaceRoot, 'apps/web/eslint.config.cjs'), 'module.exports = []')
    mkdirSync(join(workspaceRoot, 'tools/gen'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'tools/gen/eslint.config.mjs'), 'export default []')

    overlayWith(DEFAULT_STACK)

    for (const projectRoot of ['apps/web', 'libs/utils', 'packages/sdk']) {
      expect(existsSync(join(workspaceRoot, projectRoot, 'eslint.config.mjs'))).toBe(false)
    }
    expect(existsSync(join(workspaceRoot, 'apps/web/eslint.config.cjs'))).toBe(false)
    // The root config is the one that must survive.
    expect(existsSync(join(workspaceRoot, 'eslint.config.mjs'))).toBe(true)
    // Only the three conventional project directories are swept — a config a
    // user put somewhere else is theirs, not mnci's to delete.
    expect(existsSync(join(workspaceRoot, 'tools/gen/eslint.config.mjs'))).toBe(true)
  })

  it('is idempotent when the Nx scaffolding it removes is already gone', () => {
    // This is what lets `mnci upgrade` repair an existing workspace.
    expect(() => overlayWith(DEFAULT_STACK)).not.toThrow()
    expect(() => overlayWith(DEFAULT_STACK)).not.toThrow()
  })

  it('formats to JavaScript Standard Style, which forbids trailing commas', () => {
    overlayWith(DEFAULT_STACK)

    const prettier = JSON.parse(
      readFileSync(join(workspaceRoot, '.prettierrc.json'), 'utf8')
    ) as Record<string, unknown>
    expect(prettier.semi).toBe(false)
    expect(prettier.singleQuote).toBe(true)
    // Was 'es5', which contradicts Standard.
    expect(prettier.trailingComma).toBe('none')
  })

  it('writes an empty .npmrc — publish auth is a deliberate deferral', () => {
    overlayWith(DEFAULT_STACK)

    const npmrc = readFileSync(join(workspaceRoot, '.npmrc'), 'utf8')
    const directives = npmrc
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith(';'))
    expect(directives).toEqual([])
    expect(npmrc).toContain('Intentionally empty')
  })

  it('marks the commit-msg hook executable (git refuses to run it otherwise)', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'azure',
      stack: DEFAULT_STACK,
    })

    const mode = statSync(join(workspaceRoot, '.husky/commit-msg')).mode
    expect(mode & 0o111).not.toBe(0)
  })

  it('stamps the dual TypeScript compiler into devDependencies (TS6 API + TS7 tsc)', () => {
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({
        name: '@org/source',
        devDependencies: { typescript: '~6.0.3', nx: '23.0.0' },
      })
    )

    overlayWith(DEFAULT_STACK)

    const devDependencies = (
      JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
        devDependencies: Record<string, string>
      }
    ).devDependencies
    // typescript is aliased to the TS6 package (API intact; its bin is tsc6, not tsc)…
    expect(devDependencies.typescript).toBe('npm:@typescript/typescript6@^6.0.2')
    // …and @typescript/native provides the TS7 `tsc`.
    expect(devDependencies['@typescript/native']).toBe('npm:typescript@^7.0.2')
    // Unrelated devDeps are preserved.
    expect(devDependencies.nx).toBe('23.0.0')
  })

  it('stamps the chosen scope into the root package name, preserving the rest', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'azure',
      stack: DEFAULT_STACK,
    })

    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'package.json'), 'utf8')
    ) as Record<string, unknown>
    expect(manifest.name).toBe('@demo/source')
    expect(manifest.private).toBe(true)
    // Existing devDeps preserved (the dual TS compiler is added on top).
    expect(manifest.devDependencies).toMatchObject({ nx: '23.0.0' })
  })

  it('stamps the curated root scripts — single cross-platform commands only', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'azure',
      stack: DEFAULT_STACK,
    })

    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const {
      'python:install': pythonInstall,
      format,
      'format:check': formatCheck,
      ...rest
    } = manifest.scripts
    expect(rest).toEqual({
      build: 'nx run-many -t build',
      lint: 'nx run-many -t lint',
      test: 'nx run-many -t test',
      affected: 'nx affected -t lint,test,build',
      graph: 'nx graph',
      'release:preview': 'nx release --dry-run',
      prepare: 'husky',
    })
    expect(format).toBe('prettier --write .')
    expect(formatCheck).toBe('prettier --check .')
    // The local-dev counterpart of the CI Python-install guards — see the
    // dedicated `python:install` describe block below for the full assertions.
    expect(pythonInstall).toContain('-m pip install -r requirements-dev.txt')
    expect(pythonInstall).toContain(`globSync('apps/*/pyproject.toml')`)
  })

  it('keeps any scripts the preset generated that the curated set does not own', () => {
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: '@org/source', scripts: { postinstall: 'echo hi' } })
    )

    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'azure',
      stack: DEFAULT_STACK,
    })

    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts.postinstall).toBe('echo hi')
    expect(manifest.scripts.build).toBe('nx run-many -t build')
  })
})
