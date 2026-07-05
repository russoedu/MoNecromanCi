import { npmrcContent, registryUrl } from './registry'
import type { RegistryConfig } from './types'

const azure: RegistryConfig = { kind: 'azure-artifacts', organization: 'my-org', project: 'MyProject', artifactsFeed: 'MyFeed' }
const github: RegistryConfig = { kind: 'github-packages', owner: 'acme' }
const npm: RegistryConfig = { kind: 'npm' }

describe('registryUrl', () => {
  it('builds the Azure Artifacts feed URL', () => {
    expect(registryUrl(azure)).toBe('https://pkgs.dev.azure.com/my-org/MyProject/_packaging/MyFeed/npm/registry/')
  })

  it('returns the GitHub Packages registry URL', () => {
    expect(registryUrl(github)).toBe('https://npm.pkg.github.com/')
  })

  it('returns undefined for the public npm registry', () => {
    expect(registryUrl(npm)).toBeUndefined()
  })
})

describe('npmrcContent', () => {
  it('adds a scoped registry and literal auth-token line for Azure Artifacts', () => {
    const content = npmrcContent(azure, '@auto')

    expect(content).toContain('registry=https://registry.npmjs.org/')
    expect(content).toContain('legacy-peer-deps=true')
    expect(content).toContain('@auto:registry=https://pkgs.dev.azure.com/my-org/MyProject/_packaging/MyFeed/npm/registry/')

    // eslint-disable-next-line no-template-curly-in-string -- asserting the literal placeholder the generated .npmrc must contain.
    expect(content).toContain('//pkgs.dev.azure.com/my-org/MyProject/_packaging/MyFeed/npm/registry/:_authToken=${NODE_AUTH_TOKEN}')
    expect(content.endsWith('\n')).toBe(true)
  })

  it('strips a leading @ from the scope and targets GitHub Packages', () => {
    const content = npmrcContent(github, 'acme')

    expect(content).toContain('@acme:registry=https://npm.pkg.github.com/')

    // eslint-disable-next-line no-template-curly-in-string -- asserting the literal placeholder the generated .npmrc must contain.
    expect(content).toContain('//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}')
  })

  it('authenticates the default registry (no scoped registry) for public npm', () => {
    const content = npmrcContent(npm, '@auto')

    expect(content).toContain('registry=https://registry.npmjs.org/')
    // Public npm needs the default-registry token so CI can publish…
    // eslint-disable-next-line no-template-curly-in-string -- asserting the literal placeholder the generated .npmrc must contain.
    expect(content).toContain('//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}')
    // …but no scoped registry line.
    expect(content).not.toContain('@auto:registry')
  })
})
