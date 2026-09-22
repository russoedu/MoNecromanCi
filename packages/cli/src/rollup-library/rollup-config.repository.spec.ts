import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasRollupSourceMaps } from './rollup-config.algorithm'
import { resolveRollupConfigText } from './rollup-config.repository'

let workspaceRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-rollup-config-'))
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('resolveRollupConfigText', () => {
  it('returns the config text unchanged when it has no local require() at all', () => {
    const config = 'module.exports = withNx({ sourceMap: true }, {})\n'
    writeFileSync(join(workspaceRoot, 'rollup.config.cjs'), config)

    expect(resolveRollupConfigText(join(workspaceRoot, 'rollup.config.cjs'))).toBe(config)
  })

  it('follows a local require() and appends the target file, so the flag one file away is still seen', () => {
    // The other shape from the report: a workspace that hoists the shared
    // withNx() call into one root rollup.base.cjs and leaves each project as
    // a one-line delegation. hasRollupSourceMaps reading only the project's
    // own text finds nothing; reading the resolved text finds it.
    mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'rollup.base.cjs'),
      [
        "const { withNx } = require('@nx/rollup/with-nx');",
        '',
        'module.exports = () => withNx(',
        '  {',
        "    compiler: 'babel',",
        '    sourceMap: true',
        '  },',
        '  {}',
        ');',
      ].join('\n'),
    )
    writeFileSync(
      join(workspaceRoot, 'packages/sdk/rollup.config.cjs'),
      "module.exports = require('../../rollup.base.cjs')()\n",
    )

    const resolved = resolveRollupConfigText(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'))

    expect(hasRollupSourceMaps(resolved)).toBe(true)
  })

  it('does not follow a require() of an npm package, only a local relative path', () => {
    const config = "const { withNx } = require('@nx/rollup/with-nx');\nmodule.exports = withNx({}, {})\n"
    writeFileSync(join(workspaceRoot, 'rollup.config.cjs'), config)

    // Nothing is appended: the only require() here is a package specifier,
    // which does not start with a dot, so there is nothing local to follow.
    expect(resolveRollupConfigText(join(workspaceRoot, 'rollup.config.cjs'))).toBe(config)
  })

  it('terminates on a require() cycle rather than recursing forever', () => {
    writeFileSync(join(workspaceRoot, 'a.cjs'), "require('./b.cjs')")
    writeFileSync(join(workspaceRoot, 'b.cjs'), "require('./a.cjs')")

    expect(() => resolveRollupConfigText(join(workspaceRoot, 'a.cjs'))).not.toThrow()
  })
})
