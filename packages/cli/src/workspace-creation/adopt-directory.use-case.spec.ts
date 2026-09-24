import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptGeneratedWorkspace, assertAdoptableDirectory } from './adopt-directory.use-case'

/**
 * Adopting an existing directory, which is the only operation in this CLI that
 * writes into a place a human already owns. Every test here is about that: what
 * it refuses, and what it leaves alone when it does not refuse.
 */

let root: string
let generated: string
let target: string

function write (file: string, contents: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, contents)
}

/** A stand-in for what `create-nx-workspace --preset=ts` leaves behind. */
function generateWorkspace (): void {
  write(join(generated, 'package.json'), '{ "name": "demo" }\n')
  write(join(generated, 'nx.json'), '{}\n')
  write(join(generated, 'README.md'), '# demo (generated)\n')
  write(join(generated, '.gitignore'), 'node_modules\n.nx/cache\ndist\n')
  write(join(generated, 'packages/.gitkeep'), '')
  // create-nx-workspace initialises a repository of its own.
  write(join(generated, '.git/HEAD'), 'ref: refs/heads/main\n')
  write(join(generated, 'node_modules/left/index.js'), '')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mnci-adopt-'))
  generated = join(root, 'staging', 'demo')
  target = join(root, 'demo')
  mkdirSync(generated, { recursive: true })
  mkdirSync(target, { recursive: true })
  generateWorkspace()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('assertAdoptableDirectory', () => {
  it('rejects a path that is not there', () => {
    expect(() => assertAdoptableDirectory(join(root, 'absent'))).toThrow('does not exist')
  })

  it('rejects a file', () => {
    const file = join(root, 'a-file')
    writeFileSync(file, '')
    expect(() => assertAdoptableDirectory(file)).toThrow('is not a directory')
  })

  it('accepts an empty directory, and one holding only .git', () => {
    expect(() => assertAdoptableDirectory(target)).not.toThrow()
    write(join(target, '.git/HEAD'), 'ref: refs/heads/main\n')
    expect(() => assertAdoptableDirectory(target)).not.toThrow()
  })

  it('accepts a host-created repository, which arrives with a README and a licence', () => {
    write(join(target, 'README.md'), '# mine\n')
    write(join(target, 'LICENSE'), 'MIT\n')
    write(join(target, '.gitignore'), 'node_modules\n')
    expect(() => assertAdoptableDirectory(target)).not.toThrow()
  })

  it('refuses a directory that is already a project, and names what it found', () => {
    // The point of the pre-flight: this costs nothing, and the alternative is
    // finding out after `create-nx-workspace` has spent minutes generating.
    write(join(target, 'package.json'), '{}\n')
    expect(() => assertAdoptableDirectory(target)).toThrow('package.json')
    expect(() => assertAdoptableDirectory(target)).toThrow('mnci upgrade')
  })
})

describe('adoptGeneratedWorkspace', () => {
  it('copies the workspace in and never copies .git or node_modules', () => {
    write(join(target, '.git/HEAD'), 'ref: refs/heads/main\n')
    const result = adoptGeneratedWorkspace(generated, target)

    expect(existsSync(join(target, 'package.json'))).toBe(true)
    expect(existsSync(join(target, 'packages/.gitkeep'))).toBe(true)
    // The whole reason the operation exists: the clone's own history survives.
    expect(readFileSync(join(target, '.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
    expect(existsSync(join(target, 'node_modules'))).toBe(false)
    expect(result.copied).toContain('package.json')
    expect(result.copied).not.toContain('.git')
  })

  it('keeps a README and a licence that were already there', () => {
    // A hand-written README is very often the only hand-written file in a
    // fresh repository, and the generator's is boilerplate. Losing the first to
    // the second would be the worst outcome of the whole operation.
    write(join(target, 'README.md'), '# mine\n')
    write(join(target, 'LICENSE'), 'MIT\n')
    const result = adoptGeneratedWorkspace(generated, target)

    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# mine\n')
    expect(readFileSync(join(target, 'LICENSE'), 'utf8')).toBe('MIT\n')
    // Only README.md is REPORTED as kept. `kept` enumerates generated entries
    // that were left alone, and the generator writes no licence — a file it
    // never produces is not a decision, it is simply out of scope.
    expect(result.kept).toEqual(['README.md'])
  })

  it('merges an existing .gitignore rather than choosing between the two', () => {
    // Both halves matter: the repository may ignore things the generator knows
    // nothing about, and a workspace that does not ignore `.nx/cache` and
    // `dist` shows every build as a diff.
    write(join(target, '.gitignore'), '.idea\nnode_modules\n')
    const result = adoptGeneratedWorkspace(generated, target)

    const merged = readFileSync(join(target, '.gitignore'), 'utf8')
    expect(merged).toContain('.idea')
    expect(merged).toContain('.nx/cache')
    expect(merged).toContain('dist')
    expect(result.mergedGitignore).toBe(true)
    // Already present, so not repeated.
    expect(merged.split('\n').filter(line => line === 'node_modules')).toHaveLength(1)
  })

  it('reports no merge when the existing .gitignore already covers everything', () => {
    write(join(target, '.gitignore'), 'node_modules\n.nx/cache\ndist\n')
    const result = adoptGeneratedWorkspace(generated, target)

    expect(result.mergedGitignore).toBe(false)
    expect(readFileSync(join(target, '.gitignore'), 'utf8')).toBe('node_modules\n.nx/cache\ndist\n')
  })

  it('refuses a collision it cannot resolve, having written nothing at all', () => {
    // The refusal has to come before the first write, or a half-adopted
    // directory is left behind with no way to tell which files are whose.
    write(join(target, 'nx.json'), '{ "mine": true }\n')
    expect(() => adoptGeneratedWorkspace(generated, target)).toThrow('nx.json')

    expect(readFileSync(join(target, 'nx.json'), 'utf8')).toBe('{ "mine": true }\n')
    expect(existsSync(join(target, 'package.json'))).toBe(false)
    expect(existsSync(join(target, 'packages'))).toBe(false)
    // And the staging tree is still there, because nothing succeeded.
    expect(existsSync(join(generated, 'package.json'))).toBe(true)
  })

  it('removes the staging tree once it has succeeded', () => {
    adoptGeneratedWorkspace(generated, target)
    expect(existsSync(generated)).toBe(false)
  })
})
