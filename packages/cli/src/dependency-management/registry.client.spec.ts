// Mocked because this spec reaches a sibling slice through its barrel, which
// transitively loads @inquirer/prompts — ESM-only, and unparseable by jest
// as CJS. Nothing here exercises a prompt; every other spec that touches
// this module mocks it the same way.
jest.mock('@inquirer/prompts', () => ({ confirm: jest.fn(), input: jest.fn(), select: jest.fn(), checkbox: jest.fn(), Separator: class {} }))
// The suite mocks only the process boundary (runCaptureAsync); `pool` stays
// the real implementation so it is `latestNugetVersions`'s own JSON-parsing
// and matching logic under test, not a hand-rolled pool stub's behaviour.
jest.mock('../nx-workspace', () => ({
  ...jest.requireActual('../nx-workspace'),
  runCaptureAsync: jest.fn(),
}))

import { runCaptureAsync } from '../nx-workspace'
import {
  latestGoVersions,
  latestNpmVersions,
  latestNugetVersions,
  latestPipVersions,
  latestPubVersions,
  latestVersions,
} from './registry.client'

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

  // Every case, not just nuget. The switch names 'pub' explicitly rather than
  // using `default` so a new ecosystem fails to compile instead of silently
  // resolving as Dart's whole-graph query — but that only protects against a
  // MISSING case, not against one wired to the wrong lookup. These pin the
  // routing itself, by the command each branch shells out to.
  it.each([
    ['npm', 'npm', ['view', 'x', 'version', '--json']],
    ['pip', process.platform === 'win32' ? 'python' : 'python3', ['-m', 'pip', 'index', 'versions', 'x']],
    ['go', 'go', ['list', '-m', '-u', '-json', 'all']],
    ['pub', 'flutter', ['pub', 'outdated', '--json']],
  ] as const)('routes %s to %s', async (ecosystem, command, argv) => {
    mockRunCaptureAsync.mockResolvedValue({ status: 1, stdout: '' })

    await latestVersions(ecosystem, ['x'], '/workspace')

    expect(mockRunCaptureAsync).toHaveBeenCalledWith(command, argv, '/workspace')
  })
})

describe('latestNpmVersions', () => {
  // Both fixtures are real `npm view` output, captured from the registry rather
  // than written from the docs: `npm view ms version --json` and
  // `npm view 'ms@^2.0.0' version --json`. The shape difference between them is
  // the whole reason this function has a branch.
  it('reads the bare quoted string npm returns for a single match', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 0, stdout: '"2.1.3"\n' })

    const latest = await latestNpmVersions(['ms'], '/workspace')

    expect(latest.get('ms')).toBe('2.1.3')
    expect(mockRunCaptureAsync).toHaveBeenCalledWith(
      'npm',
      ['view', 'ms', 'version', '--json'],
      '/workspace',
    )
  })

  it('takes the LAST entry when npm returns an array, because it is ordered oldest first', async () => {
    // Real output for a range spec. Reading [0] would report 2.0.0 — the oldest
    // matching version — as "latest", which is the failure this pins.
    mockRunCaptureAsync.mockResolvedValue({
      status: 0,
      stdout: '[\n  "2.0.0",\n  "2.1.0",\n  "2.1.1",\n  "2.1.2",\n  "2.1.3"\n]\n',
    })

    const latest = await latestNpmVersions(['ms'], '/workspace')

    expect(latest.get('ms')).toBe('2.1.3')
  })

  it('is absent, never present with a wrong value, when npm exits non-zero', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 1, stdout: '' })

    const latest = await latestNpmVersions(['nope'], '/workspace')

    expect(latest.has('nope')).toBe(false)
  })

  it('is absent rather than throwing when the output is not JSON', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 0, stdout: 'npm ERR! code E404' })

    const latest = await latestNpmVersions(['nope'], '/workspace')

    expect(latest.has('nope')).toBe(false)
  })

  it('looks every requested name up, one call each', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 0, stdout: '"1.0.0"' })

    const latest = await latestNpmVersions(['a', 'b', 'c'], '/workspace')

    expect(latest.size).toBe(3)
    expect(mockRunCaptureAsync).toHaveBeenCalledTimes(3)
  })
})

describe('latestPipVersions', () => {
  // Real `python3 -m pip index versions requests` output (pip 26.2.1). The
  // INSTALLED and LATEST lines are kept deliberately: they are what proves the
  // parenthesised value in the header is the LATEST version and not the
  // installed one, which is the assumption the one-line regex rests on.
  const REAL_PIP_OUTPUT = [
    'requests (2.34.2)',
    'Available versions: 2.34.2, 2.34.1, 2.34.0, 2.33.1, 2.33.0',
    '  INSTALLED: 2.33.1',
    '  LATEST:    2.34.2',
  ].join('\n')

  it('reads the latest from the header, not the installed version below it', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 0, stdout: REAL_PIP_OUTPUT })

    const latest = await latestPipVersions(['requests'], '/workspace')

    expect(latest.get('requests')).toBe('2.34.2')
    expect(latest.get('requests')).not.toBe('2.33.1')
  })

  it('invokes the interpreter by name, never a venv path', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 0, stdout: REAL_PIP_OUTPUT })

    await latestPipVersions(['requests'], '/workspace')

    expect(mockRunCaptureAsync).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'python' : 'python3',
      ['-m', 'pip', 'index', 'versions', 'requests'],
      '/workspace',
    )
  })

  it('is absent when pip exits non-zero, and when nothing is parenthesised', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 1, stdout: '' })
    const afterFailure = await latestPipVersions(['nope'], '/workspace')

    expect(afterFailure.has('nope')).toBe(false)

    mockRunCaptureAsync.mockResolvedValue({ status: 0, stdout: 'ERROR: No matching distribution' })
    const afterNoMatch = await latestPipVersions(['nope'], '/workspace')

    expect(afterNoMatch.has('nope')).toBe(false)
  })
})

describe('latestGoVersions', () => {
  // Real `go list -m -u -json all` output, captured from a throwaway module
  // pinned to an outdated github.com/google/uuid. The formatting matters and is
  // preserved exactly: tab indentation, and each object closed by a `}` alone at
  // column 0, which is the boundary the stream is split on. It is a stream of
  // concatenated objects, NOT a JSON array, so JSON.parse on the whole thing
  // fails.
  const REAL_GO_OUTPUT = [
    '{',
    '\t"Path": "example.com/probe",',
    '\t"Main": true,',
    '\t"Dir": "/tmp/gofix",',
    '\t"GoVersion": "1.24.7"',
    '}',
    '{',
    '\t"Path": "github.com/google/uuid",',
    '\t"Version": "v1.3.0",',
    '\t"Update": {',
    '\t\t"Path": "github.com/google/uuid",',
    '\t\t"Version": "v1.6.0",',
    '\t\t"Time": "2024-01-23T18:54:04Z"',
    '\t},',
    '\t"Indirect": true',
    '}',
  ].join('\n')

  it('reads Update.Version from a concatenated object stream', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 0, stdout: REAL_GO_OUTPUT })

    const latest = await latestGoVersions('/workspace')

    expect(latest.get('github.com/google/uuid')).toBe('v1.6.0')
    expect(mockRunCaptureAsync).toHaveBeenCalledWith(
      'go',
      ['list', '-m', '-u', '-json', 'all'],
      '/workspace',
    )
  })

  it('skips a module with no Update, including the main module itself', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 0, stdout: REAL_GO_OUTPUT })

    const latest = await latestGoVersions('/workspace')

    // The main module is reported with no `Update` key at all. Listing it would
    // offer the user an upgrade to their own workspace.
    expect(latest.has('example.com/probe')).toBe(false)
    expect(latest.size).toBe(1)
  })

  it('yields an empty map when the Go toolchain is absent, rather than throwing', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 1, stdout: '' })

    const latest = await latestGoVersions('/workspace')

    expect(latest.size).toBe(0)
  })

  it('tolerates a truncated object at the tail of the stream', async () => {
    mockRunCaptureAsync.mockResolvedValue({
      status: 0,
      stdout: `${REAL_GO_OUTPUT}\n{\n\t"Path": "github.com/trunc`,
    })

    const latest = await latestGoVersions('/workspace')

    expect(latest.get('github.com/google/uuid')).toBe('v1.6.0')
    expect(latest.has('github.com/trunc')).toBe(false)
  })
})

describe('latestPubVersions', () => {
  // Flutter is not installed in this environment, so unlike the npm, pip and Go
  // fixtures above this one is built from `flutter pub outdated --json`'s
  // documented shape rather than captured output. It is labelled as such
  // deliberately: the other three are evidence, this one is a specification.
  const PUB_REPORT = JSON.stringify({
    packages: [
      {
        package:    'async',
        current:    { version: '2.10.0' },
        upgradable: { version: '2.10.0' },
        resolvable: { version: '2.10.0' },
        latest:     { version: '2.11.0' },
      },
    ],
  })

  it('reads `latest`, not `resolvable`, so a capped constraint does not hide an upgrade', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 0, stdout: PUB_REPORT })

    const latest = await latestPubVersions('/workspace')

    expect(latest.get('async')).toBe('2.11.0')
    expect(latest.get('async')).not.toBe('2.10.0')
  })

  it('yields an empty map when the Flutter SDK is absent or the output is unparseable', async () => {
    mockRunCaptureAsync.mockResolvedValue({ status: 1, stdout: '' })
    const afterFailure = await latestPubVersions('/workspace')

    expect(afterFailure.size).toBe(0)

    mockRunCaptureAsync.mockResolvedValue({ status: 0, stdout: 'not json' })
    const afterBadJson = await latestPubVersions('/workspace')

    expect(afterBadJson.size).toBe(0)
  })
})
