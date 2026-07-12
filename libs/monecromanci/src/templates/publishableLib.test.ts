import type { ProjectVars } from '../engine/types'
import { cliToolFiles, publishableLibFiles } from './publishableLib'

function readPackageJson (files: ReturnType<typeof publishableLibFiles>): { publishConfig?: unknown } {
  const file = files.find((entry) => entry.path.endsWith('package.json'))
  return JSON.parse(file?.content ?? '{}') as { publishConfig?: unknown }
}

function readProjectJson (files: ReturnType<typeof publishableLibFiles>): { tags?: string[] } {
  const file = files.find((entry) => entry.path.endsWith('project.json'))
  return JSON.parse(file?.content ?? '{}') as { tags?: string[] }
}

describe('publishableLibFiles', () => {
  it('sets a publishConfig registry when azure coordinates are provided', () => {
    const vars: ProjectVars = { kind: 'publishable-lib', name: 'sdk', packageName: '@demo/sdk', scope: '@demo', registry: { kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' } }
    const package_ = readPackageJson(publishableLibFiles(vars))
    expect(package_.publishConfig).toEqual({ registry: 'https://pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/' })
  })

  it('omits publishConfig when no azure coordinates are configured', () => {
    const vars: ProjectVars = { kind: 'publishable-lib', name: 'sdk', packageName: '@demo/sdk', scope: '@demo' }
    const package_ = readPackageJson(publishableLibFiles(vars))
    expect(package_.publishConfig).toBeUndefined()
  })

  it('preserves extra project.json tags (e.g. ci:ignore) alongside the canonical type tag', () => {
    const vars: ProjectVars = { kind: 'publishable-lib', name: 'sdk', packageName: '@demo/sdk', scope: '@demo', extraTags: ['ci:ignore'] }
    const project = readProjectJson(publishableLibFiles(vars))
    expect(project.tags).toEqual(['type:publishable-lib', 'ci:ignore'])
  })
})

describe('cliToolFiles', () => {
  it('omits publishConfig when no azure coordinates are configured', () => {
    const vars: ProjectVars = { kind: 'cli-tool', name: 'mytool', packageName: '@demo/mytool', scope: '@demo' }
    const package_ = readPackageJson(cliToolFiles(vars))
    expect(package_.publishConfig).toBeUndefined()
  })
})
