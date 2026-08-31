/**
 * Fails when the manifest declares an entry point the build does not produce.
 *
 * Run AFTER a build. This is deliberately a script rather than a Jest spec: a
 * spec would have to either require `dist` (failing on a clean checkout) or
 * skip when it is absent — and a gate that skips itself is the one shape of
 * gate this repo keeps having to fix. `@mnci/cli`'s published `npm-lib` shipped
 * a `types` field pointing at a file its own build never emitted, and every
 * TypeScript consumer silently got `any`; the packing assertion that existed at
 * the time passed, because it checked one file rather than every declared one.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

const declared = new Set(
  [
    manifest.main,
    manifest.module,
    manifest.types,
    ...Object.values(manifest.exports ?? {}).flatMap(entry =>
      typeof entry === 'string' ? [entry] : Object.values(entry)
    )
  ].filter(entry => typeof entry === 'string' && entry !== './package.json')
)

const missing = [...declared].filter(entry => !existsSync(path.join(root, entry)))
const sorted = [...declared].toSorted((a, b) => a.localeCompare(b))
for (const entry of sorted) {
  console.log(`${missing.includes(entry) ? 'MISS' : 'OK  '} ${entry}`)
}

if (missing.length > 0) {
  // Thrown, not `process.exit`: the non-zero status is what a CI step reads,
  // and an uncaught throw gives that plus a stack naming this file.
  throw new Error(
    `${missing.length} declared entry point(s) missing from the build: ${missing.join(', ')}`
  )
}
console.log('\nevery declared entry point exists')
