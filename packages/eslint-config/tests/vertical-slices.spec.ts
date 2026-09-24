import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The opt-in vertical-slice rules, run through the real `eslint` binary for the
 * same reasons as `config.spec.ts`: a flat config's shape proves nothing, and
 * this package is ESM while Jest runs these specs as CJS.
 *
 * One workspace, organised as slices, with each violation planted once and one
 * slice that must lint clean. The rules are opt-in, so `config.spec.ts` - whose
 * fixtures sit flat at the root of `src` - is the proof that nothing changes
 * for a workspace that does not ask for them.
 */

const packageRoot = join(__dirname, '..')
const eslintBin = join(packageRoot, '..', '..', 'node_modules', '.bin', 'eslint')

const FIXTURES: Record<string, string> = {
  // A self-contained tsconfig at the WORKSPACE ROOT, so the TypeScript resolver
  // that `import-x/no-cycle` uses stops walking here.
  //
  // Without it the walk continues into the OS temp directory, which these
  // workspaces are created inside. Anything a previous tool left there - a
  // generated workspace's own tsconfig.json, say - is picked up instead, and if
  // it `extends` a file that is not there the resolver throws and EVERY
  // assertion in the suite fails with "eslint produced no JSON". CI never sees
  // it because CI's temp directory is empty; a developer's is not.
  'tsconfig.json':
    '{\n  "compilerOptions": {\n    "target": "es2021",\n    "module": "commonjs",\n    "moduleResolution": "node",\n    "strict": true,\n    "noEmit": true\n  },\n  "include": []\n}\n',
  'packages/app/tsconfig.json':
    '{\n  "compilerOptions": {\n    "target": "es2021",\n    "module": "commonjs",\n    "moduleResolution": "node",\n    "strict": true,\n    "noEmit": true\n  },\n  "include": ["src/**/*.ts"]\n}\n',
  'packages/app/src/index.ts':                    "export { fee } from './billing'\nexport { add } from './arithmetic'\n",
  // A clean slice: flat, role-suffixed, reached through its index.
  'packages/app/src/arithmetic/index.ts':         "export { add } from './add.algorithm'\n",
  'packages/app/src/arithmetic/add.algorithm.ts': 'export function add (a: number, b: number): number {\n  return a + b\n}\n',
  // billing and invoicing import each other - through different files on each
  // side, a type on one and a value on the other, so no FILE forms a cycle.
  'packages/app/src/billing/index.ts':            "export { fee } from './fee.policy'\n",
  'packages/app/src/billing/fee.policy.ts':
    "import type { Invoice } from '../invoicing'\n\nexport function fee (invoice: Invoice): number {\n  return invoice.amount / 100\n}\n",
  'packages/app/src/invoicing/index.ts':            "export type { Invoice } from './invoice.contract'\nexport { total } from './total.use-case'\n",
  'packages/app/src/invoicing/invoice.contract.ts': 'export interface Invoice {\n  amount: number\n}\n',
  'packages/app/src/invoicing/total.use-case.ts':
    "import { fee } from '../billing'\nimport type { Invoice } from './invoice.contract'\n\nexport function total (invoice: Invoice): number {\n  return invoice.amount + fee(invoice)\n}\n",
  'packages/app/src/reports/index.ts': "export { report } from './report.use-case'\n",
  'packages/app/src/reports/report.use-case.ts':
    "import { add } from '../arithmetic/add.algorithm'\n\nexport function report (): number {\n  return add(1, 2)\n}\n",
  'packages/app/src/reports/selfish.use-case.ts':
    "import { report } from '.'\n\nexport function twice (): number {\n  return report() * 2\n}\n",
  'packages/app/src/reports/reportHelper.ts':          'export const helper = 1\n',
  'packages/app/src/reports/deeper/inner.use-case.ts': 'export const inner = 1\n',
  'packages/app/src/stray.ts':                         'export const stray = 1\n',
  // Tests name the file they test, and are exempt from the role and cycle rules.
  'packages/app/src/arithmetic/add.algorithm.spec.ts':
    "import { add } from './add.algorithm'\n\ndescribe('add', () => {\n  it('adds', () => {\n    expect(add(1, 2)).toBe(3)\n  })\n})\n",
  // A test reaching PAST a sibling's index. NOT exempt, deliberately — see the
  // assertion below for why the three rules treat tests differently.
  'packages/app/src/billing/fee.policy.spec.ts':
    "import { add } from '../arithmetic/add.algorithm'\n\ndescribe('fee', () => {\n  it('adds', () => {\n    expect(add(1, 2)).toBe(3)\n  })\n})\n",
}

let workspace: string
let reported: Record<string, string[]>

function lintAll (directory: string): Record<string, string[]> {
  const result = spawnSync(eslintBin, ['.', '--format', 'json', '--no-error-on-unmatched-pattern'], {
    cwd:      directory,
    encoding: 'utf8',
    shell:    process.platform === 'win32',
  })
  const stdout = result.stdout?.trim()
  if (!stdout?.startsWith('[')) throw new Error(`eslint produced no JSON.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  const parsed = JSON.parse(stdout) as { filePath: string, messages: { ruleId: string | null }[] }[]
  const byFile: Record<string, string[]> = {}
  for (const file of parsed) {
    const relative = file.filePath.slice(directory.length + 1).replaceAll('\\', '/')
    byFile[relative] = file.messages.map(message => message.ruleId ?? 'FATAL')
  }

  return byFile
}

/** The vertical-slice rules reported for one file. */
function slicesFor (filename: string): string[] {
  return (reported[filename] ?? []).filter(rule => rule.startsWith('vertical-slices/') || rule === 'FATAL').toSorted((a, b) => a.localeCompare(b))
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mnci-eslint-slices-'))
  const entry = pathToFileURL(join(packageRoot, 'index.js')).href
  writeFileSync(join(workspace, 'eslint.config.mjs'), `import mnci from ${JSON.stringify(entry)}\nexport default mnci({ verticalSlices: true })\n`)
  for (const [filename, contents] of Object.entries(FIXTURES)) {
    const target = join(workspace, filename)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  reported = lintAll(workspace)
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('mnci({ verticalSlices: { roles } })', () => {
  // The default role list is the BACK-END vocabulary. The ADR these rules come
  // from also allows `.service` and `.middleware`, and its front-end amendment
  // adds `.route`, `.component`, `.hook`, `.section`, `.style`, `.content`,
  // `.mock` and `.fixture`. While the list was fixed, a React app could not opt
  // in at all - every component it has would report.
  let extended: Record<string, string[]>
  let scoped: string

  beforeAll(() => {
    scoped = mkdtempSync(join(tmpdir(), 'mnci-eslint-slices-roles-'))
    const entry = pathToFileURL(join(packageRoot, 'index.js')).href
    writeFileSync(
      join(scoped, 'eslint.config.mjs'),
      `import mnci from ${JSON.stringify(entry)}\nexport default mnci({ verticalSlices: { roles: ['component', 'hook'] } })\n`,
    )
    const files: Record<string, string> = {
      'tsconfig.json':                                FIXTURES['tsconfig.json'],
      'packages/app/tsconfig.json':                   FIXTURES['packages/app/tsconfig.json'],
      'packages/app/src/index.ts':                    "export { Button } from './buttons'\n",
      'packages/app/src/buttons/index.ts':            "export { Button } from './button.component'\n",
      // An added role.
      'packages/app/src/buttons/button.component.ts': 'export const Button = 1\n',
      // Another added role.
      'packages/app/src/buttons/use-press.hook.ts':   'export const usePress = 1\n',
      // A DEFAULT role, which must still pass - the option appends, it does not
      // replace, or adding one role would cost you the other fourteen.
      'packages/app/src/buttons/press.use-case.ts':   'export const press = 1\n',
      // Still not a role.
      'packages/app/src/buttons/helper.ts':           'export const helper = 1\n',
    }
    for (const [filename, contents] of Object.entries(files)) {
      const target = join(scoped, filename)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, contents)
    }
    extended = lintAll(scoped)
  })

  afterAll(() => {
    rmSync(scoped, { recursive: true, force: true })
  })

  const slicesIn = (filename: string): string[] =>
    (extended[filename] ?? [])
      .filter(rule => rule.startsWith('vertical-slices/') || rule === 'FATAL')
      .toSorted((a, b) => a.localeCompare(b))

  it('accepts the roles it was given', () => {
    expect(slicesIn('packages/app/src/buttons/button.component.ts')).toEqual([])
    expect(slicesIn('packages/app/src/buttons/use-press.hook.ts')).toEqual([])
  })

  it('still accepts the defaults, because the option APPENDS', () => {
    expect(slicesIn('packages/app/src/buttons/press.use-case.ts')).toEqual([])
  })

  it('still reports a file with no role at all', () => {
    expect(slicesIn('packages/app/src/buttons/helper.ts')).toEqual(['vertical-slices/file-role'])
  })
})

describe('mnci({ verticalSlices })', () => {
  it('passes a slice that follows the rules, and its test', () => {
    expect(slicesFor('packages/app/src/index.ts')).toEqual([])
    expect(slicesFor('packages/app/src/arithmetic/index.ts')).toEqual([])
    expect(slicesFor('packages/app/src/arithmetic/add.algorithm.ts')).toEqual([])
    expect(slicesFor('packages/app/src/arithmetic/add.algorithm.spec.ts')).toEqual([])
  })

  it('reports two subfeatures importing each other, though no file forms a cycle', () => {
    expect(slicesFor('packages/app/src/billing/fee.policy.ts')).toEqual(['vertical-slices/no-slice-cycle'])
    expect(slicesFor('packages/app/src/invoicing/total.use-case.ts')).toEqual(['vertical-slices/no-slice-cycle'])
  })

  it('reports a sibling reached past its index, and a slice importing its own', () => {
    expect(slicesFor('packages/app/src/reports/report.use-case.ts')).toEqual(['vertical-slices/no-deep-import'])
    expect(slicesFor('packages/app/src/reports/selfish.use-case.ts')).toEqual(['vertical-slices/no-deep-import'])
  })

  it('holds a TEST to no-deep-import, unlike the role and cycle rules', () => {
    // The three rules treat tests differently, and the distinction is
    // principled rather than an oversight - it was documented as a blanket
    // "tests may reach wherever they need to", which was simply wrong.
    //
    // `file-role` must exempt them: a test is named for the file it tests, so
    // it has no role suffix by design.
    // `no-slice-cycle` must exempt them: it describes the PRODUCTION dependency
    // graph, and a spec is not in the shipped bundle.
    // `no-deep-import` must NOT: it is about respecting a sibling's public
    // API, and a test that reaches past an index couples to that sibling's
    // internals exactly as production code would. Rename a file in one slice
    // and another slice's test breaks - which is the coupling the rule exists
    // to prevent, and it does not care who wrote the import.
    expect(slicesFor('packages/app/src/billing/fee.policy.spec.ts'))
      .toEqual(['vertical-slices/no-deep-import'])
  })

  it('reports a file without its role, or not in kebab-case, nested, or at the root of src', () => {
    expect(slicesFor('packages/app/src/reports/reportHelper.ts')).toEqual(['vertical-slices/file-role', 'vertical-slices/file-role'])
    expect(slicesFor('packages/app/src/reports/deeper/inner.use-case.ts')).toEqual(['vertical-slices/file-role'])
    expect(slicesFor('packages/app/src/stray.ts')).toEqual(['vertical-slices/file-role'])
  })
})
