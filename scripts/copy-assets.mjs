// Copies the bundled template assets into dist/ so the published CLI can read
// them at runtime (tsup bundles JS but not arbitrary asset files).
import { cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const source = join(repoRoot, 'assets')
const destination = join(repoRoot, 'dist', 'assets')

if (existsSync(source)) {
  cpSync(source, destination, { recursive: true })
  process.stdout.write('Copied assets -> dist/assets\n')
}
