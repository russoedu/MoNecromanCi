// The suite mocks only the process boundary (runCaptureAsync); `pool` stays
// the real implementation so it is `latestNugetVersions`'s own JSON-parsing
// and matching logic under test, not a hand-rolled pool stub's behaviour.
jest.mock('../nx', () => ({
  ...jest.requireActual('../nx'),
  runCaptureAsync: jest.fn(),
}))

import { runCaptureAsync } from '../nx'
import { latestNugetVersions, latestVersions } from './registry'

const mockRunCaptureAsync = jest.mocked(runCaptureAsync)

beforeEach(() => {
  mockRunCaptureAsync.mockReset()
})

describe('latestNugetVersions', () => {
  it('reads latestVersion from an exact-match search result', async () => {
    mockRunCaptureAsync.mockResolvedValue({
      status: 0,
      stdout: JSON.stringify({
        version:      2,
        problems:     [],
        searchResult: [
          {
            sourceName: 'https://api.nuget.org/v3/index.json',
            packages:   [
              { id: 'Newtonsoft.Json', latestVersion: '13.0.3', totalDownloads: 1, owners: 'x' },
            ],
          },
        ],
      }),
    })

    const latest = await latestNugetVersions(['Newtonsoft.Json'], '/workspace')

    expect(latest.get('Newtonsoft.Json')).toBe('13.0.3')
    expect(mockRunCaptureAsync).toHaveBeenCalledWith(
      'dotnet',
      ['package', 'search', 'Newtonsoft.Json', '--exact-match', '--format', 'json'],
      '/workspace',
    )
  })

  it('matches the package id case-insensitively, even when it is not the first result', async () => {
    // A second, unrelated entry sits at packages[0] deliberately: a broken
    // match that quietly fell back to "the first result" would still pass
    // here only by accident, and this fixture is built so it cannot.
    mockRunCaptureAsync.mockResolvedValue({
      status: 0,
      stdout: JSON.stringify({
        searchResult: [
          {
            packages: [
              { id: 'Some.Other.Pkg', latestVersion: '9.9.9' },
              { id: 'newtonsoft.json', latestVersion: '13.0.3' },
            ],
          },
        ],
      }),
    })

    const latest = await latestNugetVersions(['Newtonsoft.Json'], '/workspace')

    expect(latest.get('Newtonsoft.Json')).toBe('13.0.3')
  })

  it('is absent from the map, never present with an empty value, when a source knows nothing', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 1, stdout: '' })

    const latest = await latestNugetVersions(['Unknown.Pkg'], '/workspace')

    expect(latest.has('Unknown.Pkg')).toBe(false)
  })

  it('is absent rather than throwing when the output is not valid JSON', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 0, stdout: 'not json' })

    const latest = await latestNugetVersions(['Broken.Pkg'], '/workspace')

    expect(latest.has('Broken.Pkg')).toBe(false)
  })
})

describe('latestVersions', () => {
  it('routes nuget to latestNugetVersions, not the pub whole-graph query', async () => {
    // Before this switch named every case explicitly, an ecosystem with no
    // case fell through to the 'pub' branch silently — exactly the trap
    // being guarded against here for nuget specifically.
    mockRunCaptureAsync.mockResolvedValue({
      status: 0,
      stdout: JSON.stringify({ searchResult: [{ packages: [{ id: 'A.Pkg', latestVersion: '1.0.0' }] }] }),
    })

    const latest = await latestVersions('nuget', ['A.Pkg'], '/workspace')

    expect(latest.get('A.Pkg')).toBe('1.0.0')
    expect(mockRunCaptureAsync).toHaveBeenCalledWith(
      'dotnet',
      expect.arrayContaining(['package', 'search']),
      '/workspace',
    )
    expect(mockRunCaptureAsync).not.toHaveBeenCalledWith('flutter', expect.anything(), expect.anything())
  })
})
