#!/usr/bin/env node

/**
 * "Space-strips" a Function App's environment config files.
 *
 * Reads every JSON file under the project's `.configurations/` folder and
 * rewrites it minified (no whitespace), so the classic release pipeline receives
 * compact app-settings files. Run from the Function App directory (cwd = project
 * root), typically by CI before the configs are copied to the build artifact:
 *   npm run clean:config -w <app>
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const configurationsDir = join(process.cwd(), '.configurations')

if (!existsSync(configurationsDir)) {
  process.stdout.write('No .configurations folder — nothing to strip.\n')
  process.exit(0)
}

let count = 0
for (const entry of readdirSync(configurationsDir)) {
  if (!entry.endsWith('.json')) {
    continue
  }

  const file = join(configurationsDir, entry)
  const data = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify(data), 'utf8')
  count += 1
}

process.stdout.write(`Stripped ${count} configuration file(s).\n`)
