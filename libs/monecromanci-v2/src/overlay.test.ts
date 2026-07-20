import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { applyOverlay, azurePipelinesYaml, DEFAULT_STACK, generatorDefaults, mnci2Config, npmrcContent, poolBlock, pythonPublishUrl, registryUrl, rootScripts, type StackConfig, withReleaseConfig } from './overlay'

describe('registryUrl', () => {
  it('builds the Azure Artifacts feed URL', () => {
    expect(registryUrl({ kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' }))
      .toBe('https://pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/')
  })

  it('returns undefined for public npm', () => {
    expect(registryUrl({ kind: 'npm' })).toBeUndefined()
  })
})

describe('pythonPublishUrl', () => {
  it('derives the pypi upload URL from the same Azure Artifacts feed (multi-protocol)', () => {
    expect(pythonPublishUrl({ kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' }))
      .toBe('https://pkgs.dev.azure.com/org/proj/_packaging/feed/pypi/upload/')
  })

  it('returns undefined for public npm (no PyPI publish wired in this cut)', () => {
    expect(pythonPublishUrl({ kind: 'npm' })).toBeUndefined()
  })
})

describe('npmrcContent', () => {
  it('routes the scope to the Azure feed and authenticates with the base64 PAT block', () => {
    const npmrc = npmrcContent({ kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' }, '@demo')
    expect(npmrc).toContain('@demo:registry=https://pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/')
    // Base64 PAT via _password (expanded at runtime from ${PAT}), for both the
    // install (/npm/registry/) and publish (feed root) paths — never a raw token.
    // eslint-disable-next-line no-template-curly-in-string -- asserting the literal placeholder the generated .npmrc must contain.
    expect(npmrc).toContain('//pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/:_password=${PAT}')
    // eslint-disable-next-line no-template-curly-in-string -- asserting the literal placeholder the generated .npmrc must contain.
    expect(npmrc).toContain('//pkgs.dev.azure.com/org/proj/_packaging/feed/:_password=${PAT}')
    expect(npmrc).toContain('//pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/:username=org')
    expect(npmrc).not.toContain('_authToken')
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
      // Both publishable dirs: npm (packages/*) and Python (python-packages/*).
      projects:             ['packages/*', 'python-packages/*'],
      releaseTag:           { pattern: '{projectName}@{version}' },
      version:              {
        conventionalCommits:            true,
        fallbackCurrentVersionResolver: 'disk',
        // Tag-only model: nothing is ever committed to main; the tag is pushed.
        // Lives under version.git — Nx rejects a top-level release.git for the
        // `nx release version` subcommand (the dry-run every user runs).
        git:                            { commit: false, tag: true, push: true },
        // Releasing packages must not require building apps; both globs listed
        // (nx run-many no-ops on an empty one).
        preVersionCommand:              'npx nx run-many -t build --projects=packages/*,python-packages/*',
      },
      changelog: { workspaceChangelog: false },
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
    expect(poolBlock('AzurePipelineManagedPool-Windows')).toBe('  name: AzurePipelineManagedPool-Windows')
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
      const document_ = yaml.load(azurePipelinesYaml(agent, 'Build')) as { steps?: unknown, pool?: unknown, variables?: unknown }
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
    expect(pipeline).toContain('ne(variables[\'Build.Reason\'], \'PullRequest\')')
    expect(pipeline).toContain('eq(variables[\'Build.SourceBranchName\'], \'main\')')
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

  it('folds uv publish credentials (base64 PAT decoded) into the release step for an Azure feed', () => {
    const url = 'https://pkgs.dev.azure.com/org/proj/_packaging/feed/pypi/upload/'
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build', url)

    // One unified release step (npm + Python), not a separate publish step.
    expect(pipeline).toContain('Release — version, tag and publish (npm + Python)')
    expect(pipeline).not.toContain('nx run-many -t publish')
    // The release step exports uv publish creds when there are Python packages.
    expect(pipeline).toContain(`UV_PUBLISH_URL='${url}'`)
    // Reuses the base64 PAT from the group, decoded to the raw token uv needs.
    expect(pipeline).toContain(`Buffer.from(process.env.PAT,'base64')`)
    // Guarded on either publishable dir.
    expect(pipeline).toContain(`globSync('python-packages/*/pyproject.toml')`)
    expect(pipeline).toContain(`globSync('packages/*/package.json')`)
  })

  it('still versions/tags Python on public npm, but exports no uv publish creds', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')
    // Python packages are always in the release scope (versioning + tags)…
    expect(pipeline).toContain(`globSync('python-packages/*/pyproject.toml')`)
    // …but without an Azure feed the release step sets no UV_PUBLISH_* env.
    expect(pipeline).not.toContain('UV_PUBLISH_URL')
  })

  it('verifies every run linter-agnostically (npm run lint) then test+build, no affected branching', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // `npm run lint` abstracts eslint-via-nx vs oxlint, so the pipeline never
    // branches on the linter. The run-many also carries `lint` so Nx-native
    // lint targets `npm run lint` misses (Python's ruff) still run in CI.
    expect(pipeline).toContain('npm run lint')
    expect(pipeline).toContain('npx nx run-many -t lint,test,build')
    expect(pipeline).not.toContain('nx affected')
  })

  it('checks the workspace is synced early, before lint/test/build (fails fast on a stale TS reference)', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    const installIndex = pipeline.indexOf('npm ci')
    const syncCheckIndex = pipeline.indexOf('nx sync:check')
    const lintIndex = pipeline.indexOf('npm run lint')

    expect(syncCheckIndex).toBeGreaterThan(installIndex)
    expect(lintIndex).toBeGreaterThan(syncCheckIndex)
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

describe('generatorDefaults', () => {
  it('maps eslint straight through', () => {
    const defaults = generatorDefaults({ linter: 'eslint', testRunner: 'jest' }) as Record<string, { linter: string, unitTestRunner: string }>
    expect(defaults['@nx/js:library']).toEqual({ linter: 'eslint', unitTestRunner: 'jest' })
    expect(defaults['@nx/react:application']).toEqual({ linter: 'eslint', unitTestRunner: 'jest' })
  })

  it('maps oxlint to linter:none (oxlint is not an Nx linter) and carries the runner', () => {
    const defaults = generatorDefaults({ linter: 'oxlint', testRunner: 'vitest' }) as Record<string, { linter: string, unitTestRunner: string }>
    expect(defaults['@nx/js:library']).toEqual({ linter: 'none', unitTestRunner: 'vitest' })
  })
})

describe('mnci2Config', () => {
  it('carries the stack through unchanged — the single source of truth `add` reads back', () => {
    expect(mnci2Config({ linter: 'oxlint', testRunner: 'vitest' })).toEqual({ stack: { linter: 'oxlint', testRunner: 'vitest' } })
    expect(mnci2Config({ linter: 'eslint', testRunner: 'jest' })).toEqual({ stack: { linter: 'eslint', testRunner: 'jest' } })
  })
})

describe('rootScripts', () => {
  it('keeps nx lint (and no formatter) for eslint', () => {
    const scripts = rootScripts({ linter: 'eslint', testRunner: 'jest' })
    expect(scripts.lint).toBe('nx run-many -t lint')
    expect(scripts.format).toBeUndefined()
    expect(scripts['format:check']).toBeUndefined()
  })

  it('swaps to oxlint and adds the oxfmt format scripts for oxlint', () => {
    const scripts = rootScripts({ linter: 'oxlint', testRunner: 'jest' })
    expect(scripts.lint).toBe('oxlint')
    expect(scripts.format).toBe('oxfmt -c oxfmt.config.mts .')
    expect(scripts['format:check']).toBe('oxfmt -c oxfmt.config.mts --check .')
  })
})

describe('applyOverlay', () => {
  let workspaceRoot: string

  const overlayWith = (stack: StackConfig): void =>
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', stack })

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci2-overlay-'))
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ $schema: 's', namedInputs: {} }))
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@org/source', private: true, devDependencies: { nx: '23.0.0' } }))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('writes the five overlay files and leaves the rest of nx.json intact', () => {
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', stack: DEFAULT_STACK })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as Record<string, unknown>
    expect(nxJson.$schema).toBe('s')
    expect(nxJson.release).toBeDefined()

    expect(existsSync(join(workspaceRoot, '.npmrc'))).toBe(true)
    expect(readFileSync(join(workspaceRoot, 'commitlint.config.mjs'), 'utf8')).toContain('@commitlint/config-conventional')
    expect(readFileSync(join(workspaceRoot, '.husky/commit-msg'), 'utf8')).toContain('commitlint --edit')
    const pipeline = readFileSync(join(workspaceRoot, 'azure-pipelines.yml'), 'utf8')
    expect(pipeline).toContain('  vmImage: ubuntu-latest')
    expect(pipeline).toContain('- group: Build')
  })

  it('turns on sync.applyChanges so a stale TS project reference is fixed automatically, not just prompted', () => {
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', stack: DEFAULT_STACK })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as { sync?: { applyChanges?: boolean } }
    expect(nxJson.sync?.applyChanges).toBe(true)
  })

  it('writes the stack as nx.json generator defaults (for a user\'s own direct `nx g`)', () => {
    overlayWith({ linter: 'oxlint', testRunner: 'vitest' })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as { generators: Record<string, { linter: string, unitTestRunner: string }> }
    expect(nxJson.generators['@nx/js:library']).toEqual({ linter: 'none', unitTestRunner: 'vitest' })
  })

  it('writes mnci2.stack — the single source of truth `add` reads back, not the generator defaults', () => {
    overlayWith({ linter: 'oxlint', testRunner: 'vitest' })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as { mnci2: { stack: { linter: string, testRunner: string } } }
    expect(nxJson.mnci2.stack).toEqual({ linter: 'oxlint', testRunner: 'vitest' })
  })

  it('sets up oxlint + oxfmt (typed .mts configs + scripts) only when oxlint is chosen', () => {
    overlayWith({ linter: 'oxlint', testRunner: 'jest' })
    const oxlintConfig = readFileSync(join(workspaceRoot, 'oxlint.config.mts'), 'utf8')
    // A typed config extending the oxc-standard StandardJS preset (not JSON).
    expect(oxlintConfig).toContain(`import { defineConfig } from 'oxlint'`)
    expect(oxlintConfig).toContain(`import standard from 'oxc-standard/.oxlintrc.json' with { type: 'json' }`)
    expect(oxlintConfig).toContain('extends: [standard]')
    expect(existsSync(join(workspaceRoot, '.oxlintrc.json'))).toBe(false)
    // The formatter counterpart, mirroring oxc-standard's .oxfmtrc.json.
    const oxfmtConfig = readFileSync(join(workspaceRoot, 'oxfmt.config.mts'), 'utf8')
    expect(oxfmtConfig).toContain(`import { defineConfig } from 'oxfmt'`)
    expect(oxfmtConfig).toContain('semi: false')
    expect(oxfmtConfig).toContain('singleQuote: true')
    const scripts = (JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts.lint).toBe('oxlint')
    expect(scripts.format).toBe('oxfmt -c oxfmt.config.mts .')
    expect(scripts['format:check']).toBe('oxfmt -c oxfmt.config.mts --check .')
  })

  it('does not write oxlint/oxfmt configs when eslint is chosen', () => {
    overlayWith(DEFAULT_STACK)
    expect(existsSync(join(workspaceRoot, 'oxlint.config.mts'))).toBe(false)
    expect(existsSync(join(workspaceRoot, 'oxfmt.config.mts'))).toBe(false)
    const scripts = (JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts.lint).toBe('nx run-many -t lint')
    expect(scripts.format).toBeUndefined()
  })

  it('marks the commit-msg hook executable (git refuses to run it otherwise)', () => {
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', stack: DEFAULT_STACK })

    const mode = statSync(join(workspaceRoot, '.husky/commit-msg')).mode
    expect(mode & 0o111).not.toBe(0)
  })

  it('stamps the dual TypeScript compiler into devDependencies (TS6 API + TS7 tsc)', () => {
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@org/source', devDependencies: { typescript: '~6.0.3', nx: '23.0.0' } }))

    overlayWith(DEFAULT_STACK)

    const devDependencies = (JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }).devDependencies
    // typescript is aliased to the TS6 package (API intact; its bin is tsc6, not tsc)…
    expect(devDependencies.typescript).toBe('npm:@typescript/typescript6@^6.0.2')
    // …and @typescript/native provides the TS7 `tsc`.
    expect(devDependencies['@typescript/native']).toBe('npm:typescript@^7.0.2')
    // Unrelated devDeps are preserved.
    expect(devDependencies.nx).toBe('23.0.0')
  })

  it('stamps the chosen scope into the root package name, preserving the rest', () => {
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', stack: DEFAULT_STACK })

    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.name).toBe('@demo/source')
    expect(manifest.private).toBe(true)
    // Existing devDeps preserved (the dual TS compiler is added on top).
    expect(manifest.devDependencies).toMatchObject({ nx: '23.0.0' })
  })

  it('stamps the curated root scripts — single cross-platform commands only', () => {
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', stack: DEFAULT_STACK })

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

    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', stack: DEFAULT_STACK })

    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(manifest.scripts.postinstall).toBe('echo hi')
    expect(manifest.scripts.build).toBe('nx run-many -t build')
  })
})
