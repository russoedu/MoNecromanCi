import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { applyOverlay, azurePipelinesYaml, DEFAULT_STACK, generatorDefaults, npmrcContent, poolBlock, registryUrl, rootScripts, type StackConfig, withReleaseConfig } from './overlay'

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

  it('verifies every run linter-agnostically (npm run lint) then test+build, no affected branching', () => {
    const pipeline = azurePipelinesYaml('ubuntu-latest', 'Build')

    // `npm run lint` abstracts eslint-via-nx vs oxlint, so the pipeline never
    // branches on the linter.
    expect(pipeline).toContain('npm run lint')
    expect(pipeline).toContain('npx nx run-many -t test,build')
    expect(pipeline).not.toContain('nx affected')
    expect(pipeline).not.toContain('run-many -t lint,test,build')
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

describe('rootScripts', () => {
  it('keeps nx lint for eslint, swaps to oxlint for oxlint', () => {
    expect(rootScripts({ linter: 'eslint', testRunner: 'jest' }).lint).toBe('nx run-many -t lint')
    expect(rootScripts({ linter: 'oxlint', testRunner: 'jest' }).lint).toBe('oxlint')
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

  it('writes the stack as nx.json generator defaults (honoured by later `add`)', () => {
    overlayWith({ linter: 'oxlint', testRunner: 'vitest' })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as { generators: Record<string, { linter: string, unitTestRunner: string }> }
    expect(nxJson.generators['@nx/js:library']).toEqual({ linter: 'none', unitTestRunner: 'vitest' })
  })

  it('sets up oxlint (config + root script) only when oxlint is chosen', () => {
    overlayWith({ linter: 'oxlint', testRunner: 'jest' })
    expect(existsSync(join(workspaceRoot, '.oxlintrc.json'))).toBe(true)
    const scripts = (JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts.lint).toBe('oxlint')
  })

  it('does not write an oxlint config when eslint is chosen', () => {
    overlayWith(DEFAULT_STACK)
    expect(existsSync(join(workspaceRoot, '.oxlintrc.json'))).toBe(false)
    const scripts = (JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts.lint).toBe('nx run-many -t lint')
  })

  it('marks the commit-msg hook executable (git refuses to run it otherwise)', () => {
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', stack: DEFAULT_STACK })

    const mode = statSync(join(workspaceRoot, '.husky/commit-msg')).mode
    expect(mode & 0o111).not.toBe(0)
  })

  it('stamps the chosen scope into the root package name, preserving the rest', () => {
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', stack: DEFAULT_STACK })

    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.name).toBe('@demo/source')
    expect(manifest.private).toBe(true)
    expect(manifest.devDependencies).toEqual({ nx: '23.0.0' })
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
