import type { RegistryConfig } from './types'

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
  switch (registry.kind) {
    case 'azure-artifacts': {
      return `https://pkgs.dev.azure.com/${registry.organization}/${registry.project}/_packaging/${registry.artifactsFeed}/npm/registry/`
    }
    case 'github-packages': {
      return 'https://npm.pkg.github.com/'
    }
    default: {
      return undefined
    }
  }
}

/**
 * Builds the `.npmrc` body for a registry configuration.
 *
 * @remarks
 * Always points the default registry at public npm, then adds a scoped registry
 * plus auth-token line for Azure Artifacts / GitHub Packages. The
 * `${NODE_AUTH_TOKEN}` placeholder is kept literal (the CI authenticates it).
 *
 * @param registry - The monorepo's resolved registry configuration.
 * @param scope - The npm scope (e.g. `@auto`) the scoped registry applies to.
 * @returns The full text of the generated `.npmrc`.
 * @throws Never - performs a pure mapping with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function npmrcContent (registry: RegistryConfig, scope: string): string {
  const scopeName = scope.replace(/^@/, '')
  const url = registryUrl(registry)
  const lines = [
    'registry=https://registry.npmjs.org/',
    '; ESLint 10 lands ahead of some plugins\' peer ranges; accept the resolved tree.',
    'legacy-peer-deps=true',
  ]

  if (url) {
    const host = url.replace(/^https:\/\//, '')
    lines.push(`@${scopeName}:registry=${url}`, `//${host}:_authToken=\${NODE_AUTH_TOKEN}`)
  }

  lines.push('')
  return lines.join('\n')
}
