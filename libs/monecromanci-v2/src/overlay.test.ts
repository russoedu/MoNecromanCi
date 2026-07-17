import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyOverlay, azurePipelinesYaml, npmrcContent, registryUrl, withReleaseConfig } from './overlay'

describe('registryUrl', () => {
  it('builds the Azure Artifacts feed URL', () => {
    expect(registryUrl({ kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' }))
      .toBe('https://pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/')
  })

  it('returns undefined for public npm', () => {
    expect(registryUrl({ kind: 'npm' })).toBeUndefined()
  })
})

describe('npmrcContent', () => {
  it('routes the scope to the Azure feed with an auth-token placeholder', () => {
    const npmrc = npmrcContent({ kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' }, '@demo')
    expect(npmrc).toContain('@demo:registry=https://pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/')
    // eslint-disable-next-line no-template-curly-in-string -- asserting the literal placeholder the generated .npmrc must contain.
    expect(npmrc).toContain('//pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/:_authToken=${NODE_AUTH_TOKEN}')
  })

  it('authenticates the default registry for public npm', () => {
    const npmrc = npmrcContent({ kind: 'npm' }, '@demo')
    // eslint-disable-next-line no-template-curly-in-string -- asserting the literal placeholder the generated .npmrc must contain.
    expect(npmrc).toContain('//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}')
    expect(npmrc).not.toContain('@demo:registry')
  })

  it('accepts lagging community-plugin peer ranges (legacy-peer-deps)', () => {
    expect(npmrcContent({ kind: 'npm' }, '@demo')).toContain('legacy-peer-deps=true')
  })
})

describe('withReleaseConfig', () => {
  it('patches release and defaultBase while preserving what the preset generated', () => {
    const patched = withReleaseConfig({ $schema: './node_modules/nx/schemas/nx-schema.json', namedInputs: { default: [] } })

    expect(patched.$schema).toBe('./node_modules/nx/schemas/nx-schema.json')
    expect(patched.namedInputs).toEqual({ default: [] })
    expect(patched.defaultBase).toBe('main')
    expect(patched.release).toMatchObject({
      projectsRelationship: 'independent',
      projects:             ['packages/*'],
      releaseTag:           { pattern: '{projectName}@{version}' },
      version:              {
        conventionalCommits:            true,
        fallbackCurrentVersionResolver: 'disk',
        // Tag-only model: nothing is ever committed to main; the tag is pushed.
        // Lives under version.git — Nx rejects a top-level release.git for the
        // `nx release version` subcommand (the dry-run every user runs).
        git:                            { commit: false, tag: true, push: true },
        // Releasing packages must not require building apps.
        preVersionCommand:              'npx nx run-many -t build --projects=packages/*',
      },
      changelog: { workspaceChangelog: false },
    })
  })
})

describe('azurePipelinesYaml', () => {
  it('re-attaches the detached HEAD before fetching refs, building or releasing', () => {
    const pipeline = azurePipelinesYaml()

    const checkoutIndex = pipeline.indexOf('checkout: self')
    const attachIndex = pipeline.indexOf('git checkout -B $(Build.SourceBranchName)')
    const fetchIndex = pipeline.indexOf('git fetch --all --prune --tags')
    const affectedIndex = pipeline.indexOf('nx affected -t lint,test,build')
    const releaseIndex = pipeline.indexOf('nx release --yes')

    expect(checkoutIndex).toBeGreaterThan(-1)
    expect(attachIndex).toBeGreaterThan(checkoutIndex)
    expect(fetchIndex).toBeGreaterThan(attachIndex)
    expect(affectedIndex).toBeGreaterThan(fetchIndex)
    expect(releaseIndex).toBeGreaterThan(affectedIndex)
  })

  it('persists credentials, sets a git identity and gates release on main non-PR builds', () => {
    const pipeline = azurePipelinesYaml()

    expect(pipeline).toContain('persistCredentials: true')
    expect(pipeline).toContain('git config user.name')
    expect(pipeline).toContain('npmAuthenticate@0')
    expect(pipeline).toContain('ne(variables[\'Build.Reason\'], \'PullRequest\')')
    expect(pipeline).toContain('eq(variables[\'Build.SourceBranchName\'], \'main\')')
  })

  it('does not reference any custom CI engine — the pipeline is plain Nx', () => {
    const pipeline = azurePipelinesYaml()

    expect(pipeline).not.toContain('build-templates')
    expect(pipeline).not.toContain('monecromanci-toolchain')
    expect(pipeline).not.toContain('.mjs')
  })

  it('is cross-platform: no multi-line shell blocks, no bash-isms, no PowerShell', () => {
    const pipeline = azurePipelinesYaml()

    // Every script step must be a single-line command (cmd.exe and sh both
    // run it); a block scalar would mean OS-specific shell scripting.
    expect(pipeline).not.toContain('script: |')
    expect(pipeline).not.toContain('shopt')
    expect(pipeline).not.toContain('for host in')
    expect(pipeline).not.toContain('if [')
    expect(pipeline).not.toContain('powershell')
    expect(pipeline).not.toContain('pwsh')
  })

  it('runs affected for PRs against the target branch, and for main pushes against HEAD~1', () => {
    const pipeline = azurePipelinesYaml()

    expect(pipeline).toContain('npx nx affected -t lint,test,build --base=origin/$(System.PullRequest.TargetBranchName) --head=HEAD')
    expect(pipeline).toContain('npx nx affected -t lint,test,build --base=HEAD~1 --head=HEAD')
    expect(pipeline).toContain('eq(variables[\'Build.Reason\'], \'PullRequest\')')
  })

  it('publishes the self-contained dist/function-apps folders on main, before release', () => {
    const pipeline = azurePipelinesYaml()

    const buildAllIndex = pipeline.indexOf('npx nx run-many -t build')
    const ensureFolderIndex = pipeline.indexOf(`mkdirSync('dist/function-apps'`)
    const publishArtifactIndex = pipeline.indexOf('ArtifactName: function-apps')
    const releaseIndex = pipeline.indexOf('nx release --yes')

    expect(buildAllIndex).toBeGreaterThan(-1)
    expect(ensureFolderIndex).toBeGreaterThan(buildAllIndex)
    expect(publishArtifactIndex).toBeGreaterThan(ensureFolderIndex)
    expect(releaseIndex).toBeGreaterThan(publishArtifactIndex)
    expect(pipeline).toContain('PathtoPublish: $(Build.SourcesDirectory)/dist/function-apps')
    // No shell packaging loop and no staged install — the build output IS the
    // deployable.
    expect(pipeline).not.toContain('npm install --omit=dev')
  })

  it('guards the release with a portable node one-liner while packages/* is empty', () => {
    const pipeline = azurePipelinesYaml()

    expect(pipeline).toContain(`globSync('packages/*/package.json')`)
    expect(pipeline).toContain('nx release --yes')
    expect(pipeline).toContain('NODE_AUTH_TOKEN: $(NODE_AUTH_TOKEN)')
  })
})

describe('applyOverlay', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci2-overlay-'))
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ $schema: 's', namedInputs: {} }))
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@org/source', private: true, devDependencies: { nx: '23.0.0' } }))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('writes the five overlay files and leaves the rest of nx.json intact', () => {
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' } })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as Record<string, unknown>
    expect(nxJson.$schema).toBe('s')
    expect(nxJson.release).toBeDefined()

    expect(existsSync(join(workspaceRoot, '.npmrc'))).toBe(true)
    expect(readFileSync(join(workspaceRoot, 'commitlint.config.mjs'), 'utf8')).toContain('@commitlint/config-conventional')
    expect(readFileSync(join(workspaceRoot, '.husky/commit-msg'), 'utf8')).toContain('commitlint --edit')
    expect(existsSync(join(workspaceRoot, 'azure-pipelines.yml'))).toBe(true)
  })

  it('marks the commit-msg hook executable (git refuses to run it otherwise)', () => {
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' } })

    const mode = statSync(join(workspaceRoot, '.husky/commit-msg')).mode
    expect(mode & 0o111).not.toBe(0)
  })

  it('stamps the chosen scope into the root package name, preserving the rest', () => {
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' } })

    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.name).toBe('@demo/source')
    expect(manifest.private).toBe(true)
    expect(manifest.devDependencies).toEqual({ nx: '23.0.0' })
  })

  it('stamps the curated root scripts — single cross-platform commands only', () => {
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' } })

    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(manifest.scripts).toEqual({
      build:             'nx run-many -t build',
      lint:              'nx run-many -t lint',
      test:              'nx run-many -t test',
      affected:          'nx affected -t lint,test,build',
      graph:             'nx graph',
      'release:preview': 'nx release --dry-run',
      prepare:           'husky',
    })
  })

  it('keeps any scripts the preset generated that the curated set does not own', () => {
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@org/source', scripts: { postinstall: 'echo hi' } }))

    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' } })

    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(manifest.scripts.postinstall).toBe('echo hi')
    expect(manifest.scripts.build).toBe('nx run-many -t build')
  })
})
