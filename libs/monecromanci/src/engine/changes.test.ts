import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedFiles, changedProjects } from './changes'

let repoRoot: string

const git = (command: string): void => {
  execSync(`git ${command}`, { cwd: repoRoot, stdio: 'ignore' })
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-changes-'))
  git('init --quiet')
  git('config user.email test@example.com')
  git('config user.name Test')
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function write (path: string, content = 'x\n'): void {
  mkdirSync(join(repoRoot, path, '..'), { recursive: true })
  writeFileSync(join(repoRoot, path), content)
}

describe('changedFiles', () => {
  it('returns an empty list outside a git repository', () => {
    const bare = mkdtempSync(join(tmpdir(), 'monecromanci-nogit-'))
    try {
      expect(changedFiles(bare)).toEqual([])
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('lists staged, unstaged and untracked files', () => {
    write('committed.txt')
    git('add . && git commit -m init --quiet')

    write('committed.txt', 'changed\n') // unstaged
    write('staged.txt')
    git('add staged.txt')
    write('untracked.txt')

    expect(changedFiles(repoRoot).toSorted((left, right) => left.localeCompare(right))).toEqual(['committed.txt', 'staged.txt', 'untracked.txt'])
  })

  it('reports the new path for renames', () => {
    write('old.txt')
    git('add . && git commit -m init --quiet')
    renameSync(join(repoRoot, 'old.txt'), join(repoRoot, 'new.txt'))
    git('add -A')

    expect(changedFiles(repoRoot)).toEqual(['new.txt'])
  })
})

describe('changedProjects', () => {
  it('groups files by apps//libs/ project with root last', () => {
    write('package.json', '{}')
    git('add . && git commit -m init --quiet')

    write('libs/jato.index/src/index.ts')
    write('libs/jato.index/package.json', '{}')
    write('apps/web/src/main.tsx')
    write('README.md')
    write('docs/notes.md')

    const changes = changedProjects(repoRoot)

    expect(changes.map((change) => change.name)).toEqual(['jato.index', 'web', 'root'])
    expect(changes[0]).toMatchObject({ path: 'libs/jato.index', files: expect.arrayContaining(['libs/jato.index/src/index.ts', 'libs/jato.index/package.json']) })
    expect(changes[1].path).toBe('apps/web')
    expect(changes[2].path).toBeUndefined()
    expect(changes[2].files.toSorted((left, right) => left.localeCompare(right))).toEqual(['docs/notes.md', 'README.md'])
  })

  it('returns an empty list for a clean tree', () => {
    write('a.txt')
    git('add . && git commit -m init --quiet')

    expect(changedProjects(repoRoot)).toEqual([])
  })
})
