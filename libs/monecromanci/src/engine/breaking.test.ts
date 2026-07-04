import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { breakingHints, collectExports, loadTypescript } from './breaking'
import type { ChangedProject } from './changes'
import { TAGS } from './constants'

let repoRoot: string

const git = (command: string): void => {
  execSync(`git ${command}`, { cwd: repoRoot, stdio: 'ignore' })
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-breaking-'))
  git('init --quiet')
  git('config user.email test@example.com')
  git('config user.name Test')
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function write (path: string, content: string): void {
  mkdirSync(join(repoRoot, path, '..'), { recursive: true })
  writeFileSync(join(repoRoot, path), content)
}

function writePublishable (name: string): void {
  write(`libs/${name}/project.json`, JSON.stringify({ tags: [TAGS.publishableLib] }))
}

describe('loadTypescript', () => {
  it('falls back to the CLI resolution when the repo has no typescript install', () => {
    expect(loadTypescript(repoRoot)).toBeDefined()
  })
})

describe('collectExports', () => {
  it('collects functions with signatures, consts, enums, types and re-exports', () => {
    const source = [
      'export function greet (name: string, loud?: boolean): string { return name }',
      'export const VERSION: string = "1"',
      'export enum Level { Low, High }',
      'export interface Options { a: string }',
      'export type Kind = "a" | "b"',
      'export class Engine {}',
      'export { helper } from \'./helper\'',
      'function internal (): void {}',
    ].join('\n')

    const exports = collectExports(ts, 'index.ts', source)

    expect(exports).toEqual([
      { name: 'greet', kind: 'function', signature: '(name: string, loud?: boolean): string' },
      { name: 'VERSION', kind: 'const', signature: ': string' },
      { name: 'Level', kind: 'enum', signature: '{ Low, High }' },
      { name: 'Options', kind: 'interface', signature: '' },
      { name: 'Kind', kind: 'type', signature: '' },
      { name: 'Engine', kind: 'class', signature: '' },
      { name: 'helper', kind: 're-export', signature: '' },
    ])
  })
})

describe('breakingHints', () => {
  const changesFor = (name: string, files: string[]): ChangedProject[] => [{ name, path: `libs/${name}`, files }]

  it('flags removed exports and changed signatures in publishable projects', () => {
    writePublishable('pub')
    write('libs/pub/src/index.ts', 'export function greet (name: string): string { return name }\nexport const GONE = 1\n')
    git('add . && git commit -m init --quiet')

    write('libs/pub/src/index.ts', 'export function greet (name: string, loud: boolean): string { return name }\n')

    const hints = breakingHints(repoRoot, changesFor('pub', ['libs/pub/src/index.ts']))

    expect(hints.pub).toEqual([
      expect.stringContaining('signature changed in libs/pub/src/index.ts: greet(name: string): string → greet(name: string, loud: boolean): string'),
      expect.stringContaining('export removed in libs/pub/src/index.ts: const GONE'),
    ])
  })

  it('skips non-publishable projects and test files, and treats new files as additions', () => {
    write('libs/internal/project.json', JSON.stringify({ tags: [TAGS.internalLib] }))
    write('libs/internal/src/index.ts', 'export function a (): void {}\n')
    writePublishable('pub')
    write('libs/pub/src/index.ts', 'export const KEEP = 1\n')
    git('add . && git commit -m init --quiet')

    write('libs/internal/src/index.ts', 'export function b (): void {}\n') // removal, but internal
    write('libs/pub/src/index.test.ts', 'test\n') // test file
    write('libs/pub/src/brand-new.ts', 'export const NEW = 1\n') // new file

    const hints = breakingHints(repoRoot, [
      { name: 'internal', path: 'libs/internal', files: ['libs/internal/src/index.ts'] },
      { name: 'pub', path: 'libs/pub', files: ['libs/pub/src/index.test.ts', 'libs/pub/src/brand-new.ts'] },
    ])

    expect(hints).toEqual({})
  })

  it('flags contract changes: root engines, project peer deps and removed bins', () => {
    writePublishable('pub')
    write('package.json', JSON.stringify({ engines: { node: '>=22' } }))
    write('libs/pub/package.json', JSON.stringify({ bin: { pub: './cli.js' }, peerDependencies: {} }))
    git('add . && git commit -m init --quiet')

    write('package.json', JSON.stringify({ engines: { node: '>=24' } }))
    write('libs/pub/package.json', JSON.stringify({ bin: {}, peerDependencies: { react: '^19.0.0' } }))

    const hints = breakingHints(repoRoot, [
      { name: 'root', files: ['package.json'] },
      { name: 'pub', path: 'libs/pub', files: ['libs/pub/package.json'] },
    ])

    expect(hints.root).toEqual([expect.stringContaining('engines.node changed in package.json: >=22 → >=24')])
    expect(hints.pub).toEqual([
      expect.stringContaining('new peer dependency in libs/pub/package.json: react'),
      expect.stringContaining('bin removed in libs/pub/package.json: pub'),
    ])
  })

  it('flags every export as removed when a publishable source file is deleted', () => {
    writePublishable('pub')
    write('libs/pub/src/extra.ts', 'export function gone (): void {}\n')
    git('add . && git commit -m init --quiet')
    rmSync(join(repoRoot, 'libs/pub/src/extra.ts'))

    const hints = breakingHints(repoRoot, changesFor('pub', ['libs/pub/src/extra.ts']))

    expect(hints.pub).toEqual([expect.stringContaining('export removed in libs/pub/src/extra.ts: function gone')])
  })
})
