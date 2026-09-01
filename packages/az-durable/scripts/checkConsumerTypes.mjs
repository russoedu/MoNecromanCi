/**
 * Typechecks a consumer-shaped fixture against the BUILT package.
 *
 * Run AFTER a build, alongside `checkEntryPoints`. The two catch different
 * things, and the gap between them is what let a real defect ship:
 * `checkEntryPoints` asserts every declared entry point EXISTS, and the file
 * did exist — its CONTENTS were unusable. Every relative specifier in the
 * emitted declarations was extensionless, which under `moduleResolution
 * nodenext` is TS2834 on every line. Consumers almost universally set
 * `skipLibCheck: true`, which suppresses those errors and resolves every export
 * to `any` — so importing the package to remove `any` from the
 * orchestrator/activity boundary silently introduced it, with nothing red
 * anywhere in the consumer's build.
 *
 * The fixture is the gate: it imports by package NAME (resolving through
 * `exports`/`types` to `dist`, unlike `test/types/*.test-d.ts` which import
 * from `../../src` and can never see a build-output defect), compiles with
 * `skipLibCheck: false`, and carries a `@ts-expect-error` that only holds while
 * the types are real. Zero diagnostics is the pass condition.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const project = path.join(root, 'test/consumer/tsconfig.json')
const declarations = path.join(root, 'dist/src/index.d.ts')

if (!existsSync(declarations)) {
  throw new Error(
    `No build output at ${declarations}. Run the build before this check — it verifies the artifact, not the source.`
  )
}

const tsc = path.join(root, '../../node_modules/.bin/tsc')
const result = spawnSync(tsc, ['--noEmit', '-p', project], {
  encoding: 'utf8',
  shell: process.platform === 'win32'
})
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()

if (result.status !== 0) {
  console.log(output)
  // Thrown rather than process.exit: the non-zero status is what CI reads, and
  // an uncaught throw adds a stack naming this file.
  throw new Error(
    'The built package does not typecheck for a consumer. TS2834 here means a relative specifier in the emitted declarations is missing its .js extension — see the docstring above.'
  )
}

console.log('OK   consumer typechecks against dist with skipLibCheck disabled')
