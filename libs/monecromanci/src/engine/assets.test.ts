import { existsSync } from 'node:fs'
import { assetsRoot, listAssetFiles, readAsset } from './assets'

describe('assetsRoot', () => {
  it('walks up from __dirname to find the bundled assets directory', () => {
    const root = assetsRoot()
    expect(existsSync(root)).toBe(true)
    expect(root.endsWith('assets')).toBe(true)
  })

  it('throws when no assets directory is found while walking up to the filesystem root', async () => {
    jest.doMock('node:fs', () => ({
      ...jest.requireActual('node:fs'),
      existsSync: jest.fn(() => false),
    }))

    await jest.isolateModulesAsync(async () => {
      const fresh = await import('./assets')
      expect(() => fresh.assetsRoot()).toThrow('MoNecromanCI assets directory not found')
    })
  })
})

describe('readAsset', () => {
  it('reads a bundled asset file as UTF-8 text', () => {
    expect(readAsset('MoNecromanCi.md').length).toBeGreaterThan(0)
  })
})

describe('listAssetFiles', () => {
  it('lists nested files as forward-slash relative paths', () => {
    const files = listAssetFiles('github')
    expect(files).toContain('workflows/ci.yml')
    expect(files.some((file) => file.includes('/'))).toBe(true)
    expect(files.every((file) => !file.includes('\\'))).toBe(true)
  })
})
