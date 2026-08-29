import yaml from 'js-yaml'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  applyOverlay,
  azurePipelinesYaml,
  DEFAULT_STACK,
  devcontainerJson,
  ESLINT_BLOCK_INVENTORY,
  ESLINT_PEER_OVERRIDES,
  ESLINT_VERSION,
  FLUTTER_SDK_VERSION,
  FORMATTED_LANGUAGES,
  generatorDefaults,
  githubActionsYaml,
  mnciConfig,
  NODE_VERSION,
  NPM_VERSION,
  npmrcContent,
  poolBlock,
  pythonPublishUrl,
  readMnciConfig,
  registryUrl,
  RETIRED_FORMATTER_FILES,
  reactExpressPeerOverride,
  ROOT_LINT_TARGET,
  rootScripts,
  SHARED_GLOBAL_INPUTS,
  type StackConfig,
  VSCODE_RECOMMENDED_EXTENSIONS,
  LAUNCH_CONFIGURATIONS,
  vscodeSettings,
  vscodeWorkspace,
  withEslintPlugin,
  withReleaseConfig,
  withSharedGlobals
} from './overlay'

/**
 * Pulls a whole `node -e "…"` guard out of a generated pipeline, so two
 * providers' copies can be compared byte-for-byte rather than by sampling
 * fragments of them.
 *
 * @param pipeline - A generated `azure-pipelines.yml` or `ci.yml`.
 * @param marker - Any substring unique to the wanted guard.
 * @returns The full command including `node -e` and both quotes, or `''` if no
 * guard in `pipeline` contains `marker`.
 */
function extractGuard (pipeline: string, marker: string): string {
  const guards = pipeline.match(/node -e "[^"]*"/g) ?? []

  return guards.find(guard => guard.includes(marker)) ?? ''
}

describe('registryUrl', () => {
  it('builds the Azure Artifacts feed URL', () => {
    expect(
      registryUrl({
        kind: 'azure-artifacts',
        organization: 'org',
        project: 'proj',
        artifactsFeed: 'feed'
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
        artifactsFeed: 'feed'
      })
    ).toBe('https://pkgs.dev.azure.com/org/proj/_packaging/feed/pypi/upload/')
  })

  it('returns undefined for public npm (no PyPI publish wired in this cut)', () => {
    expect(pythonPublishUrl({ kind: 'npm' })).toBeUndefined()
  })
})

/** Everything in an .npmrc that is not a comment or blank — i.e. actual config. */
function directives (npmrc: string): string[] {
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
    artifactsFeed: 'feed'
  } as const

  it('authenticates the public npm registry, and routes nothing', () => {
    const npmrc = npmrcContent({ kind: 'npm' }, '@demo')

    expect(directives(npmrc)).toEqual(['//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}'])
  })

  it('deliberately omits scope routing for public npm, and says why', () => {
    // The historical bug this guards: the README claimed scope routing made an
    // accidental public publish impossible while no routing line was ever
    // emitted. Routing @demo to npmjs.org would ALSO not provide that, because
    // npmjs.org is the intended target — so the honest answer is no line plus an
    // explanation, not a line that looks protective.
    const npmrc = npmrcContent({ kind: 'npm' }, '@demo')

    expect(npmrc).not.toContain('@demo:registry=')
    expect(npmrc).toContain('deliberately NO')
  })

  it('routes the scope to the Azure feed — the one case where that IS protection', () => {
    const npmrc = npmrcContent(azure, '@demo')
    const feed = 'https://pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/'

    // npm prefers a scope's registry over the global one when publishing a scoped
    // package, so this genuinely stops @demo/* reaching npmjs.org. Verified
    // against a real registry: npm reports "Publishing to <feed>".
    expect(directives(npmrc)).toContain(`@demo:registry=${feed}`)
  })

  it('routes ONLY the scope, so installing public packages needs no feed auth', () => {
    // A global `registry=` would send every install through the feed, making
    // `npm ci` require feed credentials just to fetch public dependencies.
    const npmrc = npmrcContent(azure, '@demo')

    expect(directives(npmrc).some(line => line.startsWith('registry='))).toBe(false)
  })

  it('supplies feed credentials keyed by the protocol-stripped feed URL', () => {
    const npmrc = npmrcContent(azure, '@demo')
    const key = '//pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/'

    expect(directives(npmrc)).toContain(`${key}:_password=\${PAT}`)
    expect(directives(npmrc)).toContain(`${key}:username=AzureArtifacts`)
    // npm refuses to authenticate without an email field, and never uses it.
    expect(npmrc).toContain(`${key}:email=`)
  })

  it('uses the base64 PAT as-is for npm, unlike twine which needs it decoded', () => {
    // The trap: the same PAT is consumed in two encodings. npm's _password wants
    // the pre-encoded value Azure hands out; twine wants the raw token, which the
    // CI release step decodes. Getting these backwards fails at publish time only.
    const npmrc = npmrcContent(azure, '@demo')

    expect(npmrc).toContain('_password=${PAT}')
    expect(npmrc).not.toContain('Buffer.from')
  })

  it('keys BOTH path forms, because npm walks only up a URL when matching', () => {
    // npm resolves credentials by URL prefix and strips one segment at a time, so
    // an entry on '/npm/registry/' is never found for a request to '/npm/'.
    const npmrc = npmrcContent(azure, '@demo')
    const short = '//pkgs.dev.azure.com/org/proj/_packaging/feed/npm/'

    expect(directives(npmrc)).toContain(`${short}:_password=\${PAT}`)
    expect(directives(npmrc)).toContain(`${short}:username=AzureArtifacts`)
  })

  it('uses Basic auth, never _authToken, because Bearer here wants an Entra token', () => {
    // Measured against the real feed. An unauthenticated PUT to the publish
    // endpoint answers with:
    //   www-authenticate: Bearer authorization_uri=https://login.windows.net/<tenant>,
    //                     Basic realm="...", TFS-Federated
    // so Bearer wants an Entra ID access token, not a PAT. npm sends _authToken
    // verbatim as a Bearer header, and Azure rejects a PAT there with "Unable to
    // authenticate, your authentication token seems to be invalid". A PAT goes
    // through Basic, which is username/_password. This was shipped the wrong way
    // round once; the Packaging REST API accepts a PAT as Bearer, which is what
    // made the wrong generalisation look verified.
    const npmrc = npmrcContent(azure, '@demo')

    // Asserted on directives, not raw text: the comment above them names
    // _authToken precisely so nobody reintroduces it.
    expect(directives(npmrc).some((line) => line.includes('_authToken'))).toBe(false)
    expect(directives(npmrc).some((line) => line.includes('_password'))).toBe(true)
  })

  it('drops legacy-peer-deps, added for a plugin removed long ago', () => {
    // @nxazure/func is gone; the flag stayed behind and quietly weakened
    // dependency resolution in every generated workspace.
    expect(npmrcContent({ kind: 'npm' }, '@demo')).not.toContain('legacy-peer-deps')
    expect(npmrcContent(azure, '@demo')).not.toContain('legacy-peer-deps')
  })
})

describe('withReleaseConfig', () => {
  it('patches release and defaultBase while preserving what the preset generated, for azure', () => {
    const patched = withReleaseConfig(
      {
        $schema: './node_modules/nx/schemas/nx-schema.json',
        namedInputs: { default: [] }
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
        preVersionCommand: 'npx nx run-many -t build --projects=packages/*,python-packages/*'
      },
      changelog: { workspaceChangelog: false }
    })
  })

  it('does the same for both (GitHub Releases are not safe to assume when Azure Pipelines might be the one that runs)', () => {
    const patched = withReleaseConfig({ $schema: 'x' }, 'both')
    expect(patched.release).toMatchObject({
      git: { commit: false, tag: true, push: false },
      changelog: { workspaceChangelog: false }
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
        projectChangelogs: { createRelease: 'github', file: false }
      }
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
    expect(pipeline).toContain("in(variables['Build.Reason'], 'IndividualCI', 'BatchedCI')")
    expect(pipeline).toContain("eq(variables['Build.SourceBranchName'], 'main')")
  })

  it('overrides @nx/react\'s express peer ONLY when the workspace has express', () => {
    // @nx/react@23.1.2 added `express: ^4.21.2` as an optional peer in a PATCH
    // release; 23.1.1 declares none. mnci's own `node-app --framework express`
    // installs express 5, so `npm install` fails outright with ERESOLVE. The
    // generated manifest pins `@nx/react: ^23.1.1`, which ADMITS 23.1.2 — so the
    // same manifest resolves differently depending on when npm runs, which is
    // why CI hit it and a local install with a warm cache did not.
    expect(reactExpressPeerOverride({ dependencies: { express: '^5.1.0' } })).toEqual({
      '@nx/react': { express: '$express' }
    })
    expect(reactExpressPeerOverride({ devDependencies: { express: '^4.21.2' } })).toEqual({
      '@nx/react': { express: '$express' }
    })
  })

  it('writes NOTHING for a workspace with no express, which is the load-bearing half', () => {
    // Measured, not assumed: an unconditional `$express` override is WORSE than
    // the bug. npm reports `Unable to resolve reference $express` when the root
    // declares no express, so it would turn a conflict that only affects
    // express+react workspaces into a hard install failure in every react-only
    // one. The other two candidate values each break a different shape —
    // `'*'` fails on express 5, `'^5.1.0'` fails on express 4.
    expect(reactExpressPeerOverride({})).toEqual({})
    expect(reactExpressPeerOverride({ dependencies: { react: '^19.0.0' } })).toEqual({})
    expect(reactExpressPeerOverride({ devDependencies: { '@nx/react': '^23.1.2' } })).toEqual({})
  })

  it('gates every release-only step on a CI push to main, never merely "not a PR"', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // The Azure half of #22, and the more exposed of the two. GitHub's
    // `!= 'pull_request'` needed someone to add a trigger before it could
    // misfire; Azure's `ne(Build.Reason, 'PullRequest')` was wrong on the day it
    // was written, because Azure documents EIGHT non-PR reasons — Manual,
    // Schedule, IndividualCI, BatchedCI, BuildCompletion, ResourceTrigger,
    // ValidateShelveset, CheckInShelveset. Clicking *Run pipeline* on `main` is
    // an ordinary Azure workflow, and it would have published.
    expect(pipeline).toContain("in(variables['Build.Reason'], 'IndividualCI', 'BatchedCI')")
    expect(pipeline).not.toContain("ne(variables['Build.Reason'], 'PullRequest')")
  })

  it('lists BOTH CI reasons, because dropping either stops releases silently', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // The failure mode in the other direction, and the reason this item waited
    // for evidence rather than a careful guess: narrowing to one reason does not
    // fail loudly, it just never releases again while the pipeline stays green.
    //
    // `BatchedCI` is coupled to the trigger below — Azure documents it as the
    // reason for "a Git push ... and the Batch changes was selected", which is
    // exactly what `batch: true` selects. `IndividualCI` stays because batching
    // only applies once a run is already in progress, so an unbatched push is
    // still the ordinary case. Asserted together so the coupling cannot be
    // broken by editing one of them.
    expect(pipeline).toContain("'IndividualCI'")
    expect(pipeline).toContain("'BatchedCI'")
    expect(pipeline).toContain('batch: true')
  })

  it('gates exactly the five release-only steps, the same set as GitHub', () => {
    // Both providers share one condition across pack, publish, tag, release and
    // tag-push. Asserting the COUNT is what stops the narrowing from silently
    // reaching a step it was never meant to gate — or missing one it was.
    const document_ = yaml.load(azurePipelinesYaml('ubuntu-latest', 'Build')) as {
      steps: { condition?: string; displayName?: string }[]
    }
    const gated = document_.steps.filter(step => step.condition !== undefined)

    expect(gated).toHaveLength(5)
    for (const step of gated) {
      expect(step.condition).toBe(
        "and(succeeded(), in(variables['Build.Reason'], 'IndividualCI', 'BatchedCI'), " +
          "eq(variables['Build.SourceBranchName'], 'main'))"
      )
    }
  })

  it('authenticates npm via NODE_AUTH_TOKEN (an NPM_TOKEN variable), not PAT, for the public npm registry', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build', undefined, 'npm')

    expect(pipeline).toContain('NODE_AUTH_TOKEN: $(NPM_TOKEN)')
    expect(pipeline).not.toContain('PAT: $(PAT)')
    // Still reads secrets from the same Library variable group — only the
    // variable name inside it differs, so no new CLI-collected value is needed.
    expect(pipeline).toContain('- group: Build')
  })

  it('never writes a pr: branch filter, which Azure Repos Git ignores outright', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')
    const document_ = yaml.load(pipeline) as { pr?: unknown }

    // The whole point: a `pr:` block with branch filters is NOT an error on
    // Azure Repos, it is silently ignored — so writing one documents a gate
    // that never runs. `pr: none` states the same truth without the lie.
    expect(document_.pr).toBe('none')
    expect(pipeline).not.toContain('pr:\n  branches:')
    // The remedy has to be named where someone will look for it, or removing
    // the block just leaves an unexplained hole.
    expect(pipeline).toContain('Build Validation')
    expect(pipeline).toContain('System.PullRequest.TargetBranch')
  })

  it('triggers CI on every branch, since pr: cannot cover them on Azure Repos', () => {
    const document_ = yaml.load(azurePipelinesYaml('ubuntu-latest', 'Build')) as {
      trigger?: { batch?: boolean; branches?: { include?: string[] } }
    }

    // main alone would mean a topic branch is verified by nothing at all,
    // because the `pr:` block that used to sit next to it never ran.
    expect(document_.trigger?.branches?.include).toContain('*')
    expect(document_.trigger?.branches?.include).toContain('main')
    expect(document_.trigger?.batch).toBe(true)
  })

  it('gates every release step on main, so a topic-branch run publishes nothing', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // Pairs with the all-branches trigger above: CI everywhere is only safe
    // while the publishing half stays pinned to main.
    for (const releaseStep of [
      'Pack all apps',
      'Publish the drop',
      'Release — version, tag and publish',
      'Push release tags'
    ]) {
      const at = pipeline.indexOf(releaseStep)
      expect(at).toBeGreaterThan(-1)
      expect(pipeline.slice(at, at + 400)).toContain(
        "eq(variables['Build.SourceBranchName'], 'main')"
      )
    }
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
    expect(pipeline).toContain('Buffer.from(process.env.PAT,\'base64\')')
    // Guarded on either publishable dir.
    expect(pipeline).toContain('globSync(\'python-packages/*/pyproject.toml\')')
    expect(pipeline).toContain('globSync(\'packages/*/package.json\')')
    // A guarded step installs the fixed pip toolchain before any Python target runs.
    expect(pipeline).toContain('-m pip install -r requirements-dev.txt')
    // Resolves python vs python3 by platform, not hard-coded (Windows agents
    // have no python3.exe).
    expect(pipeline).toContain('process.platform===\'win32\'?\'python\':\'python3\'')
    // A second guarded step editable-installs every Python project so
    // cross-project imports (internal libs included) resolve at test time.
    expect(pipeline).toContain('Install Python project dependencies (editable, workspace-wide)')
  })

  it('still versions/tags Python on public npm, but exports no twine publish creds', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')
    // Python packages are always in the release scope (versioning + tags)…
    expect(pipeline).toContain('globSync(\'python-packages/*/pyproject.toml\')')
    // …but without an Azure feed the release step sets no TWINE_* env.
    expect(pipeline).not.toContain('TWINE_REPOSITORY_URL')
  })

  it('verifies affected projects on a PR and every project otherwise, in one step', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    expect(pipeline).toContain('SYSTEM_PULLREQUEST_TARGETBRANCH')
    expect(pipeline).toContain('npx nx affected -t ')
    expect(pipeline).toContain('npx nx run-many -t ')
    expect(pipeline).toContain('Verify (affected on a PR, every project on main)')
  })

  it('has no standalone lint step, a strict subset of the verify target list', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // `npm run lint` is `nx run-many -t lint`. Keeping it alongside a verify step
    // that already runs `lint` only duplicates work — and worse, on an
    // affected-scoped PR it would re-lint EVERY project, discarding most of what
    // the affected selection buys.
    expect(pipeline).not.toContain('script: npm run lint')
  })

  it('batches pushes to main, so two nx release runs cannot race for the same tag', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // Azure's nearest YAML equivalent to a concurrency group. PR-run cancellation
    // is a branch-policy setting with no YAML expression, so it is deliberately
    // not faked here — see the comment in the generated file.
    expect(pipeline).toContain('batch: true')
  })

  it('caches npm downloads, keyed on the lockfile and the agent OS', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // Azure has no `cache: npm` equivalent, so this is the documented Cache@2
    // pattern: npm's cache is relocated into the pipeline workspace (the default
    // ~/.npm is outside the cacheable area) and keyed on package-lock.json.
    expect(pipeline).toContain('- name: npm_config_cache')
    expect(pipeline).toContain('value: $(Pipeline.Workspace)/.npm')
    expect(pipeline).toContain('task: Cache@2')
    expect(pipeline).toContain('npm | "$(Agent.OS)" | package-lock.json')
    // A cached native module built for one OS is not reusable on another.
    expect(pipeline).toContain('"$(Agent.OS)"')
  })

  it('restores the cache before npm ci, or it would install cold anyway', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    expect(pipeline.indexOf('task: Cache@2')).toBeLessThan(pipeline.indexOf('script: npm ci'))
  })

  it('typechecks in the verify step — build alone does not, since bundlers strip types', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // The gate that would have caught the `mnci upgrade` workspaceName bug.
    // esbuild/swc strip types without reading them, so `build` passing proves
    // nothing about type correctness — a workspace can be green on
    // lint+test+build and still carry real errors. Asserted on the shared target
    // list, so it holds on both the affected and the run-many path.
    expect(pipeline).toContain('const T=\'lint,typecheck,test,build\'')
  })

  it('has NO separate formatting step, because lint already reports formatting', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // Inverted deliberately. The step this replaces existed because ESLint was
    // configured for correctness ONLY — `eslint-config-prettier` switched every
    // stylistic rule off — so without a second Prettier invocation the entire
    // formatting opinion was advisory.
    //
    // ESLint now owns formatting, so the verify step's `lint` reports it as
    // ordinary errors. A `format:check` step would run the same binary a second
    // time over the same tree for no additional coverage.
    expect(pipeline).not.toContain('format:check')
    expect(pipeline).toContain('nx affected -t ')
  })

  it('checks the workspace is synced early, before verification (fails fast on a stale TS reference)', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    const installIndex = pipeline.indexOf('npm ci')
    const syncCheckIndex = pipeline.indexOf('nx sync:check')
    const verifyIndex = pipeline.indexOf('Verify (affected on a PR')

    expect(syncCheckIndex).toBeGreaterThan(installIndex)
    expect(verifyIndex).toBeGreaterThan(syncCheckIndex)
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
    expect(pipeline).toContain('globSync(\'apps/*/pyproject.toml\')')
    expect(pipeline).toContain('globSync(\'python-packages/*/pyproject.toml\')')
    expect(pipeline).toContain('globSync(\'libs/*/pyproject.toml\')')
    expect(pipeline).toContain('globSync(\'apps/*/requirements.txt\')')
    expect(pipeline).toContain('\'-m\',\'pip\',\'install\',\'--quiet\'')
  })

  it('runs npm audit right after npm ci, and pip-audit after the workspace-wide Python install', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    const npmInstallIndex = pipeline.indexOf('npm ci')
    const npmAuditIndex = pipeline.indexOf('\'audit\',\'--json\'')
    const pythonWorkspaceInstallIndex = pipeline.indexOf(
      'Install Python project dependencies (editable, workspace-wide)'
    )
    const pipAuditIndex = pipeline.indexOf('\'-m\',\'pip_audit\'')
    const syncCheckIndex = pipeline.indexOf('nx sync:check')

    expect(npmAuditIndex).toBeGreaterThan(npmInstallIndex)
    expect(pipAuditIndex).toBeGreaterThan(pythonWorkspaceInstallIndex)
    expect(syncCheckIndex).toBeGreaterThan(pipAuditIndex)
    // The two audits deliberately DIFFER now, and the asymmetry is the point:
    // `npm audit --json` reports `fixAvailable` per advisory so the actionable
    // ones can block, while pip-audit's output carries no equivalent field, so
    // making it blocking would go red on findings nobody can act on.
    expect(pipeline).toContain('displayName: npm audit (fails on an actionable advisory)')
    expect(pipeline).toContain('displayName: pip-audit (non-blocking)')
    // The warn-only form must not come back — it exited 0 on all nine of this
    // repo's own fixable advisories, and its `--audit-level=high` also skipped
    // the moderate one entirely.
    expect(pipeline).not.toContain('npm audit --audit-level=high || echo')
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
    expect(pipeline).toContain('path.basename(f,\'.zip\')')
  })

  it('guards pack and release with portable node one-liners while apps/packages are empty', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    expect(pipeline).toContain('globSync(\'apps/*/project.json\')')
    expect(pipeline).toContain('globSync(\'packages/*/package.json\')')
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

  it('cancels superseded PR runs but never a release run on main', () => {
    const document_ = yaml.load(githubActionsYaml('ubuntu-latest')) as {
      concurrency?: { group?: string; 'cancel-in-progress'?: string }
    }

    expect(document_.concurrency?.group).toBe('${{ github.workflow }}-${{ github.ref }}')
    // An expression, deliberately, not a flat `true`. A cancelled run on main can
    // leave a release tag pushed with the publish only half done — a state no
    // rerun repairs, because the version is already tagged. Those runs queue.
    expect(document_.concurrency?.['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}"
    )
  })

  it('gates every release-only step on a PUSH to main, never merely "not a PR"', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    // The positive form is load-bearing even though it is equivalent today: the
    // generated workflow has exactly two triggers, so `!= 'pull_request'` means
    // `== 'push'` right now. It stops meaning that the moment anyone adds a
    // `workflow_dispatch` or a `schedule`, at which point clicking *Run workflow*
    // would publish packages and push release tags with nothing in the file
    // suggesting it could. mnci's own workflow hit exactly that, having hand-added
    // `workflow_dispatch` for its Windows e2e job.
    expect(workflow).toContain("github.event_name == 'push' && github.ref_name == 'main'")
    expect(workflow).not.toContain("github.event_name != 'pull_request'")
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
    expect(workflow).toContain('Buffer.from(process.env.PAT,\'base64\')')
    expect(workflow).toContain('globSync(\'python-packages/*/pyproject.toml\')')
    expect(workflow).toContain('globSync(\'packages/*/package.json\')')
    expect(workflow).toContain('-m pip install -r requirements-dev.txt')
    expect(workflow).toContain('process.platform===\'win32\'?\'python\':\'python3\'')
    expect(workflow).toContain('Install Python project dependencies (editable, workspace-wide)')
  })

  it('still versions/tags Python on public npm, but exports no twine publish creds', () => {
    const workflow = githubActionsYaml('ubuntu-latest')
    expect(workflow).toContain('globSync(\'python-packages/*/pyproject.toml\')')
    expect(workflow).not.toContain('TWINE_REPOSITORY_URL')
  })

  it('verifies affected projects on a PR and every project otherwise, in one step', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    expect(workflow).toContain('GITHUB_BASE_REF')
    expect(workflow).toContain('npx nx affected -t ')
    expect(workflow).toContain('npx nx run-many -t ')
    expect(workflow).toContain('Verify (affected on a PR, every project on main)')
  })

  it('has no standalone lint step, a strict subset of the verify target list', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    expect(workflow).not.toContain('run: npm run lint')
  })

  it('checks the workspace is synced early, before verification (fails fast on a stale TS reference)', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    const installIndex = workflow.indexOf('npm ci')
    const syncCheckIndex = workflow.indexOf('nx sync:check')
    const verifyIndex = workflow.indexOf('Verify (affected on a PR')

    expect(syncCheckIndex).toBeGreaterThan(installIndex)
    expect(verifyIndex).toBeGreaterThan(syncCheckIndex)
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
    expect(workflow).toContain('globSync(\'apps/*/pyproject.toml\')')
    expect(workflow).toContain('globSync(\'python-packages/*/pyproject.toml\')')
    expect(workflow).toContain('globSync(\'libs/*/pyproject.toml\')')
    expect(workflow).toContain('globSync(\'apps/*/requirements.txt\')')
    expect(workflow).toContain('\'-m\',\'pip\',\'install\',\'--quiet\'')
  })

  it('runs npm audit right after npm ci, and pip-audit after the workspace-wide Python install', () => {
    const workflow = githubActionsYaml('ubuntu-latest')

    const npmInstallIndex = workflow.indexOf('npm ci')
    const npmAuditIndex = workflow.indexOf('\'audit\',\'--json\'')
    const pythonWorkspaceInstallIndex = workflow.indexOf(
      'Install Python project dependencies (editable, workspace-wide)'
    )
    const pipAuditIndex = workflow.indexOf('\'-m\',\'pip_audit\'')
    const syncCheckIndex = workflow.indexOf('nx sync:check')

    expect(npmAuditIndex).toBeGreaterThan(npmInstallIndex)
    expect(pipAuditIndex).toBeGreaterThan(pythonWorkspaceInstallIndex)
    expect(syncCheckIndex).toBeGreaterThan(pipAuditIndex)
    expect(workflow).toContain('name: npm audit (fails on an actionable advisory)')
    expect(workflow).toContain('name: pip-audit (non-blocking)')
    expect(workflow).not.toContain('npm audit --audit-level=high || echo')
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
    expect(github).toContain('process.platform===\'win32\'?\'python\':\'python3\'')
    expect(azure).toContain('process.platform===\'win32\'?\'python\':\'python3\'')
    expect(github).toContain('globSync(\'apps/*/pyproject.toml\')')
    expect(azure).toContain('globSync(\'apps/*/pyproject.toml\')')
    expect(github).toContain('globSync(\'apps/*/project.json\')')
    expect(azure).toContain('globSync(\'apps/*/project.json\')')
    expect(github).toContain('Buffer.from(process.env.PAT,\'base64\')')
    expect(azure).toContain('Buffer.from(process.env.PAT,\'base64\')')

    // The Flutter SDK install and the root pub get are byte-identical in both.
    // Only the PATH step legitimately differs, because the two providers have
    // genuinely different mechanisms for extending PATH — asserted separately
    // in each provider's own test above.
    const flutterInstall = `'--branch','${FLUTTER_SDK_VERSION}','https://github.com/flutter/flutter.git'`
    expect(github).toContain(flutterInstall)
    expect(azure).toContain(flutterInstall)
    expect(github).toContain('\'pub\',\'get\'')
    expect(azure).toContain('\'pub\',\'get\'')
    expect(github).toContain('No Flutter projects - skipping.')
    expect(azure).toContain('No Flutter projects - skipping.')

    // NEITHER provider has a formatting step, and asserting the absence in both
    // is the same anti-drift property as asserting the presence used to be: a
    // step removed from one provider must not survive in the other. ESLint owns
    // formatting now, so `lint` inside the verify target reports it.
    expect(github).not.toContain('format:check')
    expect(azure).not.toContain('format:check')

    // Same for the typecheck target, for the same reason.
    expect(github).toContain('const T=\'lint,typecheck,test,build\'')
    expect(azure).toContain('const T=\'lint,typecheck,test,build\'')

    // The verify guard, byte-for-byte. This one matters more than the others:
    // the two providers detect a pull request through DIFFERENT environment
    // variables, so the guard reads both and the shared body is what keeps
    // "what CI verifies" from diverging between them. A provider-specific copy
    // would change the gate itself, not just its spelling.
    const guard = extractGuard(github, 'npx nx affected')
    expect(guard).not.toBe('')
    expect(azure).toContain(guard)

    // Both cache npm downloads, though the mechanisms genuinely differ: GitHub's
    // setup-node takes a `cache` input, Azure needs a separate Cache@2 task and a
    // relocated cache directory. Asserted here so neither provider silently loses
    // caching while the other keeps it.
    expect(github).toContain('cache: npm')
    expect(azure).toContain('task: Cache@2')
  })
})

// The verify guard decides WHAT CI checks, so asserting on its source text only
// proves the branches were typed, not that they are reachable — and every bug this
// project has shipped passed its unit tests. These tests therefore run the real
// command against a real git repository, with a stub `npx` recording which Nx
// invocation it chose.
//
// Skipped on Windows: the guard itself is portable (that is why it is a `node -e`
// one-liner and not a shell script), but a PATH stub for `npx` under cmd.exe needs
// a `.cmd` shim, and the harness is not worth duplicating for a platform whose
// only job here runs e2e rather than unit tests.
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

describeOnPosix('the verify guard, executed', () => {
  const guard = extractGuard(githubActionsYaml('ubuntu-latest'), 'npx nx affected')

  let repo: string
  let log: string

  /** Runs the guard in the fixture repo. @param env - Extra environment.
   * @returns The stub's recorded Nx command, plus the guard's exit status. */
  function run (env: Record<string, string> = {}): { command: string; status: number | null } {
    const result = spawnSync(guard, {
      cwd: repo,
      shell: true,
      encoding: 'utf8',
      env: {
        ...process.env,
        // Emptied so the host CI's own PR variables cannot leak in and decide the
        // branch for us — this suite runs inside exactly such a run.
        GITHUB_BASE_REF: '',
        SYSTEM_PULLREQUEST_TARGETBRANCH: '',
        PATH: `${join(repo, 'stub-bin')}${delimiter}${process.env.PATH ?? ''}`,
        ...env
      }
    })

    return {
      command: existsSync(log) ? readFileSync(log, 'utf8').trim() : '',
      status: result.status
    }
  }

  const git = (...args: string[]): string =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim()

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'mnci-verify-'))
    log = join(repo, 'nx-command.log')

    // A stub `npx` on PATH: records the command, then exits with STUB_EXIT so the
    // guard's status propagation can be checked too.
    mkdirSync(join(repo, 'stub-bin'))
    writeFileSync(
      join(repo, 'stub-bin/npx'),
      `#!/bin/sh\necho "$@" > "${log}"\nexit \${STUB_EXIT:-0}\n`,
      { mode: 0o755 }
    )

    git('init', '--initial-branch=main')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Test')
    writeFileSync(join(repo, 'file.txt'), 'base\n')
    git('add', '-A')
    git('commit', '-m', 'base')
    // The repo is its own remote, which is all `origin/main` needs to exist.
    git('remote', 'add', 'origin', repo)
    git('fetch', '--quiet', 'origin')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('verifies EVERY project when the run is not a pull request', () => {
    expect(run().command).toBe('nx run-many -t lint,typecheck,test,build')
  })

  it('verifies only affected projects on a GitHub pull request', () => {
    const base = git('rev-parse', 'HEAD')
    writeFileSync(join(repo, 'file.txt'), 'changed\n')
    git('commit', '-am', 'change')

    expect(run({ GITHUB_BASE_REF: 'main' }).command).toBe(
      `nx affected -t lint,typecheck,test,build --base=${base}`
    )
  })

  it('reads Azure’s full ref too, resolving to the same base as GitHub’s bare name', () => {
    const base = git('rev-parse', 'HEAD')
    writeFileSync(join(repo, 'file.txt'), 'changed\n')
    git('commit', '-am', 'change')

    // The one place the two providers genuinely differ: Azure sends
    // `refs/heads/main`, GitHub sends `main`. Both must land on the same base, or
    // Azure would silently take the fallback path on every single PR.
    expect(run({ SYSTEM_PULLREQUEST_TARGETBRANCH: 'refs/heads/main' }).command).toBe(
      `nx affected -t lint,typecheck,test,build --base=${base}`
    )
  })

  it('falls back to EVERY project when the target branch cannot be resolved', () => {
    // The critical direction. Guessing the base too WIDE costs minutes; guessing
    // it too narrow means CI runs almost nothing, reports green, and has verified
    // nothing.
    expect(run({ GITHUB_BASE_REF: 'no-such-branch' }).command).toBe(
      'nx run-many -t lint,typecheck,test,build'
    )
  })

  it('propagates a failing exit status, on both paths', () => {
    // A verify step that swallows failures is worse than no verify step at all.
    expect(run({ STUB_EXIT: '7' }).status).toBe(7)
    expect(run({ GITHUB_BASE_REF: 'main', STUB_EXIT: '7' }).status).toBe(7)
  })

  it('survives YAML parsing unchanged in both providers', () => {
    // The guard is a `node -e "…"` command sitting inside a YAML scalar, so it
    // carries double quotes into a format that also uses them. The tests above
    // run the string as generated; this one checks the string a CI runner would
    // actually receive is the same one, in both providers — the step is useless
    // if YAML re-quoting mangles it on the way through.
    const azure = yaml.load(azurePipelinesYaml('ubuntu-latest', 'Build')) as {
      steps: { script?: string; displayName?: string }[]
    }
    const github = yaml.load(githubActionsYaml('ubuntu-latest')) as {
      jobs: { ci: { steps: { run?: string; name?: string }[] } }
    }

    const azureStep = azure.steps.find(step => step.displayName?.startsWith('Verify (affected'))
    const githubStep = github.jobs.ci.steps.find(step => step.name?.startsWith('Verify (affected'))

    expect(azureStep?.script).toBe(guard)
    expect(githubStep?.run).toBe(guard)
  })
})

/**
 * One advisory, in the shape `npm audit --json` emits.
 *
 * @param name - Package name.
 * @param severity - Advisory severity.
 * @param fixAvailable - Whether a published fix exists; an object when the fix
 * needs a semver-major bump, which is how npm reports it.
 * @returns A `vulnerabilities` entry.
 */
const advisory = (
  name: string,
  severity: string,
  fixAvailable: boolean | { isSemVerMajor: boolean }
): Record<string, unknown> => ({ name, severity, fixAvailable })

/**
 * Wraps advisories in a full `npm audit --json` report.
 *
 * @param entries - The advisories.
 * @returns The JSON text a stub `npm` should print.
 */
const auditReport = (...entries: Record<string, unknown>[]): string =>
  JSON.stringify({
    vulnerabilities: Object.fromEntries(entries.map(entry => [entry.name as string, entry]))
  })

// The audit step decides whether a known-vulnerable dependency can reach `main`,
// and the version it replaced was warn-only on a justification that had gone
// stale. Asserting on its source text would only prove the branches were typed —
// so these run the real emitted command with a stub `npm` on PATH feeding it
// canned `npm audit --json`, and check the exit status it chooses.
//
// Skipped on Windows for the reason the verify-guard harness is: a PATH stub under
// cmd.exe needs a `.cmd` shim, and this platform's job here is the e2e suite.
describeOnPosix('the npm audit step, executed', () => {
  const guard = extractGuard(githubActionsYaml('ubuntu-latest'), 'npm audit')

  let workspace: string

  /**
   * Runs the real guard against a canned audit report.
   *
   * @param report - What the stub `npm` prints on stdout.
   * @param exitCode - The stub's exit status (npm audit exits non-zero when it
   * finds anything, which the guard must not confuse with a failure).
   * @returns The guard's exit status and its stdout.
   */
  function run (report: string, exitCode = 1): { status: number | null; out: string } {
    writeFileSync(join(workspace, 'stub-bin/report.json'), report)
    const result = spawnSync(guard, {
      cwd: workspace,
      shell: true,
      encoding: 'utf8',
      env: {
        ...process.env,
        STUB_EXIT: String(exitCode),
        PATH: `${join(workspace, 'stub-bin')}${delimiter}${process.env.PATH ?? ''}`
      }
    })

    return { status: result.status, out: `${result.stdout}${result.stderr}` }
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'mnci-audit-'))
    mkdirSync(join(workspace, 'stub-bin'))
    // The stub ignores its arguments and prints the canned report, so the test
    // controls the finding set without needing a registry or a lockfile.
    writeFileSync(
      join(workspace, 'stub-bin/npm'),
      `#!/bin/sh\ncat "${join(workspace, 'stub-bin/report.json')}"\nexit \${STUB_EXIT:-1}\n`,
      { mode: 0o755 }
    )
  })

  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  it('fails on a high advisory that has a published fix', () => {
    // The case that matters: this is what all nine of this monorepo's own
    // advisories looked like, every one fixable by an `overrides` entry, while the
    // warn-only step printed them and exited 0.
    const { status, out } = run(auditReport(advisory('js-yaml', 'high', true)))

    expect(status).toBe(1)
    expect(out).toContain('BLOCKING [high] js-yaml')
  })

  it('fails on a MODERATE advisory with a fix, which --audit-level=high missed', () => {
    // Not a hypothetical: the `postcss` advisory in this repo was moderate and
    // fixable, and the step it replaced would have passed it silently.
    const { status, out } = run(auditReport(advisory('postcss', 'moderate', true)))

    expect(status).toBe(1)
    expect(out).toContain('BLOCKING [moderate] postcss')
  })

  it('PASSES a high advisory with no fix available, and says why', () => {
    // The whole of the original concern, kept: going red for something nobody in
    // this workspace can fix teaches people to ignore the gate.
    const { status, out } = run(auditReport(advisory('upstream-only', 'high', false)))

    expect(status).toBe(0)
    expect(out).toContain('NO fix available upstream')
  })

  it('passes a low advisory even with a fix, below the blocking threshold', () => {
    const { status, out } = run(auditReport(advisory('trivial', 'low', true)))

    expect(status).toBe(0)
    expect(out).toContain('below the blocking threshold')
  })

  it('blocks on the actionable one even when an unactionable one is present', () => {
    // A mixed report is the realistic case, and the unactionable entry must not
    // provide cover for the actionable one.
    const { status, out } = run(
      auditReport(advisory('upstream-only', 'critical', false), advisory('fixable', 'high', true))
    )

    expect(status).toBe(1)
    expect(out).toContain('BLOCKING [high] fixable')
    expect(out).toContain('NO fix available upstream')
  })

  it('flags a fix that needs a semver-major bump, rather than implying a one-liner', () => {
    const { status, out } = run(auditReport(advisory('big', 'high', { isSemVerMajor: true })))

    expect(status).toBe(1)
    expect(out).toContain('(semver-major)')
  })

  it('passes a clean report', () => {
    const { status, out } = run(auditReport(), 0)

    expect(status).toBe(0)
    expect(out).toContain('none actionable')
  })

  it('does NOT block when the audit itself is broken', () => {
    // A gate that cannot read its input should say so, not guess. A registry
    // outage or an npm output change must not read as "vulnerable".
    const { status, out } = run('not json at all', 1)

    expect(status).toBe(0)
    expect(out).toContain('not blocking on a broken audit')
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
      { plugin: '@nx/eslint/plugin', options: { targetName: 'lint' } }
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
      '@nx/eslint/plugin'
    ])
  })

  it('copes with an nx.json that has no plugins key at all', () => {
    expect(withEslintPlugin({}).plugins).toEqual([
      { plugin: '@nx/eslint/plugin', options: { targetName: 'lint' } }
    ])
  })
})

describe('devcontainerJson', () => {
  type Devcontainer = {
    name: string
    image: string
    features: Record<string, unknown>
    postCreateCommand: string
    customizations: { vscode: { extensions: string[] } }
  }
  const parsed = (): Devcontainer => JSON.parse(devcontainerJson('demo')) as Devcontainer

  it('is valid JSON naming the workspace', () => {
    // Written to disk verbatim, so a malformed string would break the container
    // build with no earlier signal.
    expect(parsed().name).toBe('demo')
  })

  it('pins the same Node major the pipeline does, from one constant', () => {
    // The whole point of the file is that local matches CI. Hardcoding the
    // number in two places would reintroduce exactly the drift it removes.
    expect(parsed().image).toBe(
      `mcr.microsoft.com/devcontainers/typescript-node:${NODE_VERSION}-bookworm`
    )
    expect(githubActionsYaml('ubuntu-latest')).toContain(`node-version: ${NODE_VERSION}`)
  })

  it('pins the same npm major the pipeline does, from one constant', () => {
    // Node was pinned and npm was not, and the gap cost six high advisories in
    // every generated workspace. npm 11 reuses an already-installed tree rather
    // than re-resolving, so it applies `overrides` differently from npm 10 —
    // measured on nx 23.1.1, same manifest, same sequence: npm 10.9.7 reported
    // 0 and npm 11.19.0 reported 6. A contributor on a different npm major
    // therefore verified something other than what users got.
    expect(parsed().postCreateCommand).toContain(`npm install -g npm@${NPM_VERSION}`)
    expect(githubActionsYaml('ubuntu-latest')).toContain(`npm install -g npm@${NPM_VERSION}`)
  })

  it('pins npm BEFORE npm ci, since the pin is pointless after the install', () => {
    const postCreate = parsed().postCreateCommand

    expect(postCreate.indexOf(`npm install -g npm@${NPM_VERSION}`)).toBeLessThan(
      postCreate.indexOf('npm ci')
    )

    const workflow = githubActionsYaml('ubuntu-latest')

    expect(workflow.indexOf(`npm install -g npm@${NPM_VERSION}`)).toBeLessThan(
      workflow.indexOf('- run: npm ci')
    )
  })

  it('brings Python and Go as features rather than a hand-maintained Dockerfile', () => {
    expect(Object.keys(parsed().features)).toEqual([
      'ghcr.io/devcontainers/features/python:1',
      'ghcr.io/devcontainers/features/go:1'
    ])
  })

  it("reuses the pipeline's own toolchain guards instead of a third copy", () => {
    // Each guard is already idempotent and already no-ops when the workspace has
    // no project of that kind, so a JS-only workspace pays almost nothing.
    // Reimplementing them here would be a third place to keep in sync.
    const command = parsed().postCreateCommand

    // `npm ci` comes before every guard, because they all run through the
    // workspace's own scripts and Nx, which do not exist until it completes.
    // It is no longer *first* — the npm pin precedes it, since pinning npm
    // after the install it was meant to govern would achieve nothing.
    expect(command.indexOf('npm ci')).toBeLessThan(command.indexOf('npm run python:install'))
    expect(command.indexOf('npm ci')).toBeLessThan(command.indexOf('golangci-lint'))
    expect(command).toContain('npm run python:install')
    expect(command).toContain('golangci-lint')
    // Flutter has no maintained devcontainer feature — the same reason
    // @mnci/nx-flutter exists — so the SDK arrives via the pinned clone CI uses.
    expect(command).toContain(FLUTTER_SDK_VERSION)
    expect(command).toContain('pubspec.yaml')
  })

  it('recommends the same extensions as the .code-workspace file', () => {
    expect(parsed().customizations.vscode.extensions).toEqual([...VSCODE_RECOMMENDED_EXTENSIONS])
    expect(vscodeWorkspace('demo')).toContain('dbaeumer.vscode-eslint')
  })
})

describe('withSharedGlobals', () => {
  it('lists the root config files, so `nx affected` on a PR is not blind to them', () => {
    // Measured on a real workspace before this existed: touching
    // tsconfig.base.json marked ONLY the root pseudo-project, which has no
    // lint/typecheck/test/build target — so `nx affected -t …` verified nothing
    // at all and CI reported green. Each of these three can change every
    // project's result.
    const patched = withSharedGlobals({ namedInputs: { sharedGlobals: [] } })

    expect((patched.namedInputs as { sharedGlobals: string[] }).sharedGlobals).toEqual([
      '{workspaceRoot}/eslint.config.mjs',
      '{workspaceRoot}/tsconfig.base.json',
      '{workspaceRoot}/package.json'
    ])
  })

  it('leaves the rest of namedInputs exactly as the preset generated it', () => {
    // `default` is what references sharedGlobals, and `production` extends
    // `default`. Overwriting either would change what every target hashes.
    const preset = {
      default: ['{projectRoot}/**/*', 'sharedGlobals'],
      production: ['default', '!{projectRoot}/jest.config.[jt]s'],
      sharedGlobals: []
    }

    expect(withSharedGlobals({ namedInputs: preset }).namedInputs).toMatchObject({
      default: preset.default,
      production: preset.production
    })
  })

  it('is idempotent, so `mnci upgrade` cannot accumulate duplicates', () => {
    const once = withSharedGlobals({ namedInputs: { sharedGlobals: [] } })

    expect(withSharedGlobals(once).namedInputs).toEqual(once.namedInputs)
  })

  it("keeps a workspace's own shared globals rather than replacing them", () => {
    // Additive on purpose: a user who added their own entry (a shared .env, a
    // codegen schema) would otherwise lose it on every `mnci upgrade`.
    const patched = withSharedGlobals({
      namedInputs: { sharedGlobals: ['{workspaceRoot}/schema.graphql'] }
    })

    expect((patched.namedInputs as { sharedGlobals: string[] }).sharedGlobals).toEqual([
      '{workspaceRoot}/schema.graphql',
      ...SHARED_GLOBAL_INPUTS
    ])
  })

  it('copes with an nx.json that has neither namedInputs nor sharedGlobals', () => {
    expect(withSharedGlobals({}).namedInputs).toEqual({ sharedGlobals: [...SHARED_GLOBAL_INPUTS] })
    expect(withSharedGlobals({ namedInputs: { default: [] } }).namedInputs).toEqual({
      default: [],
      sharedGlobals: [...SHARED_GLOBAL_INPUTS]
    })
  })

  it('does not list .prettierrc.json or the lockfile, and the reasons differ', () => {
    // Prettier is not a project target — the pipeline's `format:check` step runs
    // `prettier --check .` over the whole tree on every run, so listing it would
    // invalidate every cache and verify nothing new. The lockfile is already
    // covered: Nx marks projects affected from it through its external-dependency
    // nodes (verified on a real workspace — a lockfile-only edit marks all).
    expect(SHARED_GLOBAL_INPUTS).not.toContain('{workspaceRoot}/.prettierrc.json')
    expect(SHARED_GLOBAL_INPUTS).not.toContain('{workspaceRoot}/.prettierrc.mjs')
    expect(SHARED_GLOBAL_INPUTS).not.toContain('{workspaceRoot}/package-lock.json')
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
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' } as const,
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'github' as const,
      stack: { testRunner: 'vitest' as const, linter: 'eslint' as const }
    }
    expect(mnciConfig(options)).toEqual({
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'github',
      stack: { testRunner: 'vitest' }
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
      stack: DEFAULT_STACK
    })

    expect(readMnciConfig(workspaceRoot)).toEqual({
      // workspaceName is persisted so `mnci upgrade` can name the
      // `<name>.code-workspace` it rewrites; without it, upgrade wrote a file
      // literally called `undefined.code-workspace`.
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'github',
      stack: DEFAULT_STACK
    })
  })

  it('returns an empty object for a workspace with no mnci block at all (predates persistence)', () => {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ $schema: 's' }))

    expect(readMnciConfig(workspaceRoot)).toEqual({})
  })
})

describe('rootScripts', () => {
  it('uses nx lint, and `format` is eslint --fix — one tool, one command', () => {
    const scripts = rootScripts()

    expect(scripts.lint).toBe('nx run-many -t lint')
    expect(scripts.format).toBe('eslint . --fix --cache')
    // No `format:check`: `lint` already reports formatting as ordinary errors,
    // so a second script would run the same binary twice for no new coverage.
    expect(scripts['format:check']).toBeUndefined()
  })

  it('adds python:install chaining the same two guards CI runs (for local-dev convenience)', () => {
    const scripts = rootScripts()

    // Fixed dev toolchain (ruff/pytest/build/twine from requirements-dev.txt) ...
    expect(scripts['python:install']).toContain('-m pip install -r requirements-dev.txt')
    // ... then the workspace-wide editable install of every Python project.
    expect(scripts['python:install']).toContain('globSync(\'apps/*/pyproject.toml\')')
    expect(scripts['python:install']).toContain('globSync(\'python-packages/*/pyproject.toml\')')
    expect(scripts['python:install']).toContain('globSync(\'libs/*/pyproject.toml\')')
    // Chained (not parallel), toolchain install first.
    const toolchainIndex = scripts['python:install'].indexOf(
      '-m pip install -r requirements-dev.txt'
    )
    const workspaceIndex = scripts['python:install'].indexOf('globSync(\'apps/*/pyproject.toml\')')
    expect(toolchainIndex).toBeGreaterThan(-1)
    expect(workspaceIndex).toBeGreaterThan(toolchainIndex)
  })

  it('stamps python:install unconditionally (both guards already no-op with no Python projects)', () => {
    // This used to call rootScripts({ testRunner }) twice to prove the script was
    // stack-independent. rootScripts takes no parameters, so both calls were
    // identical and the test asserted the same thing twice — stack-independence
    // is now guaranteed by the signature rather than by assertion.
    expect(rootScripts()['python:install']).toBeDefined()
  })
})

describe('applyOverlay', () => {
  let workspaceRoot: string

  const overlayWith = (stack: StackConfig): void =>
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'azure',
      stack
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
      stack: DEFAULT_STACK
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
      stack: DEFAULT_STACK
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
      stack: DEFAULT_STACK
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
      stack: DEFAULT_STACK
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
      stack: DEFAULT_STACK
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
      stack: DEFAULT_STACK
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
      stack: DEFAULT_STACK
    })

    const dependabot = readFileSync(join(workspaceRoot, '.github/dependabot.yml'), 'utf8')
    const parsed = yaml.load(dependabot) as {
      updates: Array<{ 'package-ecosystem': string; directory?: string; directories?: string[] }>
    }
    expect(parsed.updates.map(update => update['package-ecosystem'])).toEqual([
      'npm',
      'github-actions',
      'pip',
      'pub'
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
      stack: DEFAULT_STACK
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
      stack: DEFAULT_STACK
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
      unitTestRunner: 'vitest'
    })
  })

  it('writes mnci.stack — the single source of truth `add` reads back, not the generator defaults', () => {
    overlayWith({ testRunner: 'vitest' })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as {
      mnci: { stack: { testRunner: string } }
    }
    expect(nxJson.mnci.stack).toEqual({ testRunner: 'vitest' })
  })

  it('writes the shared global inputs into nx.json, so an affected-scoped PR is not blind to the root configs', () => {
    // The unit tests above cover the merge; this covers the wiring. Without it
    // `withSharedGlobals` could be correct and simply never called — which is
    // exactly how the root eslint config went unowned for so long.
    overlayWith(DEFAULT_STACK)

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as {
      namedInputs: { sharedGlobals: string[] }
    }
    expect(nxJson.namedInputs.sharedGlobals).toEqual([...SHARED_GLOBAL_INPUTS])
  })

  it('writes the jsx-a11y peer override, without which npm install fails on ESLint 10', () => {
    // `eslint-plugin-jsx-a11y@6.10.2` peers at `^3 … ^9`, so npm ERESOLVEs
    // against ESLint 10. The cap is stale, not real — measured: with this
    // override the plugin installs and its rules still fire. npm only honours
    // `overrides` in the ROOT manifest, which is why the config package cannot
    // carry its own fix and mnci has to write this.
    overlayWith(DEFAULT_STACK)

    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      overrides: Record<string, unknown>
      devDependencies: Record<string, string>
    }

    expect(manifest.overrides['eslint-plugin-jsx-a11y']).toEqual({ eslint: '$eslint' })
    // `$eslint` is what keeps the override from pinning a version of its own, so
    // it has to resolve against a declared `eslint` — assert both halves.
    expect(manifest.devDependencies.eslint).toBe(ESLINT_VERSION)
    expect(ESLINT_VERSION.startsWith('^10.')).toBe(true)
  })

  it("merges overrides rather than replacing a workspace's own", () => {
    // A user's `overrides` block is theirs; `mnci upgrade` must not delete it.
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: 'x', overrides: { 'left-pad': '1.0.0' } })
    )
    overlayWith(DEFAULT_STACK)

    const { overrides } = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      overrides: Record<string, unknown>
    }

    expect(overrides['left-pad']).toBe('1.0.0')
    expect(overrides).toMatchObject(ESLINT_PEER_OVERRIDES)

    // Named explicitly, not just via the constant: this one is a SECURITY fix,
    // and a generated workspace shipped six high advisories without it. The audit
    // step found it the first time it ran inside a generated workspace —
    // `brace-expansion` carries a high advisory that `nx`, `@nx/js`,
    // `@nx/eslint`, `@nx/eslint-plugin` and `@nx/workspace` all inherit, and npm
    // reports the fix as semver-major, so `npm audit fix` would try to bump `nx`
    // itself. This repo had carried the same override for its own tree all along.
    for (const parent of ['nx', '@nx/js', '@nx/eslint', '@nx/eslint-plugin', '@nx/workspace']) {
      expect(overrides[parent]).toEqual({ 'brace-expansion': '^5.0.9' })
    }
    // NOT top-level: a tree with minimatch@3 legitimately carries
    // brace-expansion@1.x, and forcing that to v5 breaks it.
    expect(overrides['brace-expansion']).toBeUndefined()
  })

  it('gives the root project a lint target, since nothing else lints root-level files', () => {
    // `nx run-many -t lint` only runs targets that belong to a project, and every
    // other `lint` target runs `eslint .` inside its own project — so .github/
    // workflows, the pipeline YAML, root JSON/Markdown and the root config files
    // were linted by nothing at all.
    overlayWith(DEFAULT_STACK)

    const { nx } = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      nx: { includedScripts: unknown[]; targets: Record<string, unknown> }
    }

    expect(nx.targets.lint).toEqual(ROOT_LINT_TARGET)
    // Load-bearing: the root scripts are the `nx run-many` aggregators, so letting
    // Nx infer targets from them would make `lint` invoke `nx run-many -t lint`.
    expect(nx.includedScripts).toEqual([])
    // The ignore patterns must be CLI flags — in flat config, `ignores` are
    // relative to the config file, which every project's own lint resolves too.
    const { command } = ROOT_LINT_TARGET.options
    expect(command).toContain('--ignore-pattern "packages/**"')
    expect(command).toContain('--ignore-pattern "python-packages/**"')
  })

  it("keeps a workspace's own root targets when adding the lint one", () => {
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: 'x', nx: { targets: { 'local-registry': { executor: 'x' } } } })
    )
    overlayWith(DEFAULT_STACK)

    const { nx } = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      nx: { targets: Record<string, unknown> }
    }

    expect(nx.targets['local-registry']).toEqual({ executor: 'x' })
    expect(nx.targets.lint).toEqual(ROOT_LINT_TARGET)
  })

  it('writes .devcontainer/devcontainer.json, so a local environment can match CI', () => {
    overlayWith(DEFAULT_STACK)

    const written = readFileSync(join(workspaceRoot, '.devcontainer/devcontainer.json'), 'utf8')

    expect(JSON.parse(written).name).toBe('demo')
    expect(written).toBe(devcontainerJson('demo'))
  })

  it('writes the whole mnci block — workspaceName/scope/registry/agent/variableGroup/ci — so `mnci upgrade` can reconstruct the exact options a later run resolved', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: {
        kind: 'azure-artifacts',
        organization: 'org',
        project: 'proj',
        artifactsFeed: 'feed'
      },
      agent: 'windows-latest',
      variableGroup: 'CiSecrets',
      ci: 'both',
      stack: DEFAULT_STACK
    })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as {
      mnci: Record<string, unknown>
    }
    expect(nxJson.mnci).toEqual({
      workspaceName: 'demo',
      scope: '@demo',
      registry: {
        kind: 'azure-artifacts',
        organization: 'org',
        project: 'proj',
        artifactsFeed: 'feed'
      },
      agent: 'windows-latest',
      variableGroup: 'CiSecrets',
      ci: 'both',
      stack: DEFAULT_STACK
    })
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

  it('explains what is in the config, and how to override it', () => {
    overlayWith(DEFAULT_STACK)
    const config = readFileSync(join(workspaceRoot, 'eslint.config.mjs'), 'utf8')

    // The cost of moving the rules into a package: a three-line config gives no
    // hint that twenty tools are behind it. The comment is what buys that back,
    // so it is part of the deliverable rather than decoration.
    expect(config).toContain('npx eslint --inspect-config')
    expect(config).toContain("name: 'local/")
    // The one thing that cannot work must be stated where someone would try it,
    // not only in a README they have not opened — and what that is has CHANGED.
    // It used to be `space-before-function-paren`, unreachable while Prettier
    // rewrote `f (a)` back to `f(a)` on every run. That rule is now ON: it is
    // Standard's signature rule and nothing contradicts it any more.
    //
    // What replaces it is the inverse warning: do not add a formatter. Whichever
    // one is chosen disagrees with `mnci/standard`, and because a formatter runs
    // on save it wins silently — leaving `lint` to fail on files the user never
    // edited by hand.
    expect(config).toContain('FORMATTING IS LINTING HERE')
    expect(config).toContain('There is no Prettier, no oxfmt')
    expect(config).toContain('Installing a Prettier or oxfmt extension is')
  })

  it('names blocks in the inventory that the real config actually has', () => {
    // A stale inventory is worse than no inventory: it sends the reader to a
    // block that does not exist, and nothing about generating a workspace would
    // notice. So the comment is checked against the real thing in BOTH
    // directions — a renamed block fails, and a new block nobody documented
    // fails too.
    //
    // A subprocess because @mnci/eslint-config is ESM and this spec runs as CJS
    // under ts-jest; `import`ing it here does not parse. The workspace symlink in
    // node_modules is what makes the bare specifier resolve.
    const script = `
      const mnci = (await import('@mnci/eslint-config')).default
      const blocks = mnci({ workspaceRoot: process.cwd() })
      process.stdout.write(JSON.stringify(blocks.map(block => block.name ?? null)))
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: join(__dirname, '..', '..', '..'),
      encoding: 'utf8'
    })
    const stdout = result.stdout?.trim()
    if (!stdout?.startsWith('[')) {
      throw new Error(`could not resolve @mnci/eslint-config.\nstderr: ${result.stderr}`)
    }
    const actual = (JSON.parse(stdout) as (string | null)[]).filter(
      (name): name is string => name !== null
    )
    expect(actual.length).toBeGreaterThan(20)

    // The inventory documents mnci's own blocks; `typescript-eslint/*` is
    // upstream's and is listed with a wildcard rather than enumerated.
    const documented = ESLINT_BLOCK_INVENTORY.match(/\bmnci\/[\w/*,-]+/g) ?? []
    const own = actual.filter(name => name.startsWith('mnci/'))

    // Multi-block presets are documented as `mnci/yaml/recommended*`, since how
    // many blocks upstream splits them into is not a user-facing fact.
    const covers = (name: string): boolean =>
      documented.some(entry =>
        entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : entry === name
      )
    expect(own.filter(name => !covers(name))).toEqual([])

    // And nothing documented that no longer exists. `mnci/json, /jsonc, /json5`
    // is one line for three blocks, so the trailing comma is stripped and the
    // `/jsonc` shorthand is expanded against the family it belongs to.
    const stale = documented
      .map(entry => entry.replace(/,$/, ''))
      .filter(entry => !entry.endsWith('*'))
      .filter(entry => !own.includes(entry))
    expect(stale).toEqual([])
  })

  it('points `format` at eslint --fix, and ships no second format script', () => {
    // One tool means one command. `format:check` is deliberately absent: `lint`
    // already reports formatting as ordinary errors, so a second script would
    // run the same binary twice for no extra coverage.
    overlayWith({ testRunner: 'jest' })
    const { scripts } = JSON.parse(
      readFileSync(join(workspaceRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }

    expect(scripts.format).toBe('eslint . --fix --cache')
    expect(scripts['format:check']).toBeUndefined()
  })

  it('recommends the ESLint extension and NO formatter extension', () => {
    // The absence is the assertion. mnci recommended `esbenp.prettier-vscode`
    // for as long as Prettier owned formatting — and kept recommending it after
    // ESLint took over, which made mnci the thing that installed its own hazard.
    //
    // That extension needs no config file to act: with none present it formats
    // against Prettier's own defaults, semicolons and double quotes, the exact
    // inverse of Standard. Because it runs on save, the damage lands AFTER every
    // gate, so `lint` stays green until someone next looks. Recommending it
    // while `RETIRED_FORMATTER_FILES` deletes its config was the two halves of
    // one decision contradicting each other.
    const workspace = vscodeWorkspace('demo')
    expect(workspace).toContain('dbaeumer.vscode-eslint')
    expect(workspace).not.toContain('esbenp.prettier-vscode')
    expect(workspace).not.toContain('oxc.oxc-vscode')
  })

  it('recommends no retired formatter extension in the devcontainer either', () => {
    // The workspace file and the devcontainer read the same constant, so this
    // cannot diverge today — but the two lists HAVE been separate before, and a
    // container that silently installs a formatter is the harder half to notice,
    // since nobody opens it expecting to audit its extensions.
    const container = devcontainerJson('demo')
    expect(container).toContain('dbaeumer.vscode-eslint')
    expect(container).not.toContain('esbenp.prettier-vscode')
    expect(container).not.toContain('oxc.oxc-vscode')
  })

  it('points editor.defaultFormatter at ESLint, which is the formatter', () => {
    // Getting this wrong is silent and constant: format-on-save would invoke a
    // formatter the workspace does not configure, reformatting every file the
    // moment it is touched.
    expect(vscodeWorkspace('demo')).toContain(
      '"editor.defaultFormatter": "dbaeumer.vscode-eslint"'
    )
    expect(vscodeWorkspace('demo')).toContain(
      '"editor.defaultFormatter": "dbaeumer.vscode-eslint"'
    )
  })

  it('pins the formatter for EVERY language, not just the global default', () => {
    // The bug this fixes, reported from a real workspace: `.ts` files were not
    // formatted on save while `.json`/`.jsonc`/`.yaml` were — the three that had
    // explicit entries. VS Code resolves a language-specific setting ahead of a
    // general one, and does so BEFORE scope, so a `[typescript]` block in the
    // user's own settings outranks this file's global `editor.defaultFormatter`.
    // Nothing reports it: Prettier is installed, the config resolves, and
    // `format:check` still finds the unformatted files.
    const settings = JSON.parse(vscodeWorkspace('demo')).settings as Record<
      string,
      { 'editor.defaultFormatter'?: string }
    >
    for (const language of FORMATTED_LANGUAGES) {
      expect(settings[`[${language}]`]).toEqual({
        'editor.defaultFormatter': 'dbaeumer.vscode-eslint'
      })
    }
  })

  it('covers the languages that actually matter, TypeScript and HTML included', () => {
    // Asserted by name rather than only through the loop above, because the loop
    // would still pass if someone shortened FORMATTED_LANGUAGES back to the three
    // it started as — which is exactly how the reported bug existed. `html` is
    // here because it was missing for the same reason `typescript` was: the list
    // claimed to be "everything the formatter handles" and nobody checked it
    // against the binaries.
    for (const language of [
      'typescript',
      'typescriptreact',
      'javascript',
      'javascriptreact',
      'html'
    ]) {
      expect(FORMATTED_LANGUAGES).toContain(language)
    }
  })

  it('includes toml, which ESLint parses and no formatter here could', () => {
    // The entry the e2e asserted and the constant never got — a mismatch that
    // only a Windows nightly reported, and only after the oxlint mode (whose
    // `OXFMT_ONLY_LANGUAGES` used to carry it) was deleted.
    //
    // Measured, because the name of this constant overstates what it buys: a
    // real `eslint --fix` leaves a badly-laid-out `.toml` BYTE-IDENTICAL — the
    // TOML block is `flat/base`, parser only — while a malformed one reports
    // `Parsing error`. So the entry gets editor-side parse errors on a broken
    // `pyproject.toml`, and pins format-on-save to a no-op rather than to
    // whichever TOML formatter the user happens to have installed.
    expect(FORMATTED_LANGUAGES).toContain('toml')
  })

  it('recommends the same extensions in the devcontainer as in the workspace file', () => {
    // Shared for this reason: opening the workspace in a container must suggest
    // the same toolset as opening it directly. Asserted for BOTH rather than for
    // the constant alone — when these were two per-linter lists, the split was
    // exactly where they drifted.
    const container = JSON.parse(devcontainerJson('demo')) as {
      customizations: { vscode: { extensions: string[] } }
    }
    const workspace = JSON.parse(vscodeWorkspace('demo')) as {
      extensions: { recommendations: string[] }
    }

    expect(container.customizations.vscode.extensions).toEqual([...VSCODE_RECOMMENDED_EXTENSIONS])
    expect(workspace.extensions.recommendations).toEqual([...VSCODE_RECOMMENDED_EXTENSIONS])
  })

  it('exposes the four verify targets in Run and Debug, not only as tasks', () => {
    // A `tasks` entry is reachable only through Terminal -> Run Task. The Run and
    // Debug dropdown reads `launch`, so a workspace with tasks alone offers nothing
    // there — which is exactly what every generated workspace used to do.
    const workspace = JSON.parse(vscodeWorkspace('demo')) as {
      launch: { version: string; configurations: Record<string, unknown>[] }
    }

    expect(workspace.launch.configurations.map((c) => c.name)).toEqual([
      'mnci: build',
      'mnci: test',
      'mnci: lint',
      'mnci: typecheck'
    ])
  })

  it('drives npm scripts rather than a path into node_modules', () => {
    // Pointing `program` at node_modules/nx/bin/nx.js would be wrong twice over: Nx
    // ships its bin at dist/bin/nx.js, and that path is version-dependent. Driving
    // the root script instead tracks ROOT_SCRIPTS for free.
    const workspace = JSON.parse(vscodeWorkspace('demo')) as {
      launch: { configurations: Record<string, unknown>[] }
    }

    for (const configuration of workspace.launch.configurations) {
      expect(configuration.program).toBeUndefined()
      expect(configuration.command).toMatch(/^npm run /)
    }
    // Every script it launches must actually exist in the generated manifest.
    const scripts = Object.keys(rootScripts())
    for (const target of LAUNCH_CONFIGURATIONS) expect(scripts).toContain(target)
  })

  it('uses node-terminal, so a breakpoint in an nx-spawned child can bind', () => {
    // nx run-many executes every target in a CHILD process. A plain `node` launch
    // attaches to the Nx parent alone, so a breakpoint inside a spec never binds;
    // node-terminal runs in VS Code's JS Debug Terminal, which instruments children
    // as they spawn. This is the whole reason for the type, so it is pinned.
    const workspace = JSON.parse(vscodeWorkspace('demo')) as {
      launch: { configurations: Record<string, unknown>[] }
    }

    for (const configuration of workspace.launch.configurations) {
      expect(configuration.type).toBe('node-terminal')
    }
  })

  it('scopes cwd by folder NAME, which a second folder would otherwise break', () => {
    // A bare ${workspaceFolder} is ambiguous in a multi-root workspace and VS Code
    // refuses to resolve it. The generated file has one folder today, but a user
    // adding a second must not silently break every launch config.
    const workspace = JSON.parse(vscodeWorkspace('acme')) as {
      launch: { configurations: Record<string, unknown>[] }
    }

    for (const configuration of workspace.launch.configurations) {
      expect(configuration.cwd).toBe('${workspaceFolder:acme}')
    }
  })

  it('keeps settings mnci has no opinion about, and wins on the ones it does', () => {
    // Settings used to be replaced wholesale, which deleted everything a workspace
    // had added for itself. Measured on this repo's own file: an upgrade would have
    // destroyed a 1,179-entry cSpell.words dictionary that lives nowhere else.
    const workspace = JSON.parse(
      vscodeWorkspace('demo', undefined, undefined, {
        'cSpell.words': ['mnci', 'monecromanci'],
        'editor.rulers': [100],
        // A key mnci DOES own: its value must not survive.
        'editor.defaultFormatter': 'someone.else'
      })
    ) as { settings: Record<string, unknown> }

    expect(workspace.settings['cSpell.words']).toEqual(['mnci', 'monecromanci'])
    expect(workspace.settings['editor.rulers']).toEqual([100])
    expect(workspace.settings['editor.defaultFormatter']).not.toBe('someone.else')
    // The mnci opinion still lands in full.
    for (const key of Object.keys(vscodeSettings())) {
      // Keys here contain literal dots, so toHaveProperty would read them as paths.
      expect(Object.keys(workspace.settings)).toContain(key)
    }
  })

  it('keeps a hand-written launch config across an upgrade, replacing only its own', () => {
    // Additive like nx.json sharedGlobals. Tasks are carried through wholesale
    // because `mnci add` writes them; launch entries are overlay-owned, so only the
    // `mnci: ` ones may be replaced.
    const mine = { type: 'node', request: 'launch', name: 'debug my thing' }
    const workspace = JSON.parse(
      vscodeWorkspace('demo', undefined, {
        version: '0.2.0',
        configurations: [{ name: 'mnci: build', stale: true }, mine]
      })
    ) as { launch: { configurations: Record<string, unknown>[] } }

    expect(workspace.launch.configurations).toContainEqual(mine)
    // The stale mnci-owned entry is replaced, not duplicated or preserved.
    const builds = workspace.launch.configurations.filter((c) => c.name === 'mnci: build')
    expect(builds).toHaveLength(1)
    expect(builds[0].stale).toBeUndefined()
  })

  it('deletes every formatter config a past mnci version could have written', () => {
    // Load-bearing, not tidying, and the reason is that these files are INERT
    // from the command line — nothing runs Prettier or oxfmt any more. That is
    // exactly what makes them dangerous: a globally installed
    // `esbenp.prettier-vscode` or `oxc.oxc-vscode` still resolves one and still
    // reformats on save, quietly undoing Standard while `npm run lint` reports
    // nothing, because the damage lands after the last check ran.
    //
    // All six shapes mnci has shipped: `.prettierrc` from create-nx-workspace,
    // `.prettierrc.json` and `.prettierrc.mjs` from mnci itself, `.prettierignore`,
    // and the oxlint pair.
    for (const stale of RETIRED_FORMATTER_FILES) {
      writeFileSync(join(workspaceRoot, stale), '{}\n')
    }

    overlayWith(DEFAULT_STACK)

    for (const stale of RETIRED_FORMATTER_FILES) {
      expect(existsSync(join(workspaceRoot, stale))).toBe(false)
    }
    // ...and exactly one config remains, because there is exactly one tool.
    expect(existsSync(join(workspaceRoot, 'eslint.config.mjs'))).toBe(true)
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

  // The options themselves are asserted in @mnci/eslint-config's own suite, by
  // running the real Prettier binary against fixtures. They cannot be asserted
  // here: the package is ESM and these specs run as CJS under ts-jest, so
  // importing it fails to parse — the same wall that file's header documents.

  it('writes an .npmrc that can actually authenticate a publish', () => {
    overlayWith(DEFAULT_STACK)

    // The fixture is a public-npm workspace, so this is the auth-only variant:
    // one directive, no scope routing. It used to be comment-only, which meant
    // every generated workspace's `npm publish` failed to authenticate while CI
    // exported a token nothing consumed.
    const npmrc = readFileSync(join(workspaceRoot, '.npmrc'), 'utf8')
    const directives = npmrc
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith(';'))

    expect(directives).toEqual(['//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}'])
  })

  it('marks the commit-msg hook executable (git refuses to run it otherwise)', () => {
    applyOverlay(workspaceRoot, {
      workspaceName: 'demo',
      scope: '@demo',
      registry: { kind: 'npm' },
      agent: 'ubuntu-latest',
      variableGroup: 'Build',
      ci: 'azure',
      stack: DEFAULT_STACK
    })

    const mode = statSync(join(workspaceRoot, '.husky/commit-msg')).mode
    expect(mode & 0o111).not.toBe(0)
  })

  it('stamps the dual TypeScript compiler into devDependencies (TS6 API + TS7 tsc)', () => {
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({
        name: '@org/source',
        devDependencies: { typescript: '~6.0.3', nx: '23.0.0' }
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
      stack: DEFAULT_STACK
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
      stack: DEFAULT_STACK
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
      // Its own script because nothing else type-checks: a bundler-built
      // project's `build` strips types without reading them.
      typecheck: 'nx run-many -t typecheck',
      affected: 'nx affected -t lint,typecheck,test,build',
      graph: 'nx graph',
      'release:preview': 'nx release --dry-run',
      prepare: 'husky'
    })
    expect(format).toBe('eslint . --fix --cache')
    // No `format:check`: with one tool, `lint` already reports formatting.
    expect(formatCheck).toBeUndefined()
    // The local-dev counterpart of the CI Python-install guards — see the
    // dedicated `python:install` describe block below for the full assertions.
    expect(pythonInstall).toContain('-m pip install -r requirements-dev.txt')
    expect(pythonInstall).toContain('globSync(\'apps/*/pyproject.toml\')')
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
      stack: DEFAULT_STACK
    })

    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts.postinstall).toBe('echo hi')
    expect(manifest.scripts.build).toBe('nx run-many -t build')
  })
})
