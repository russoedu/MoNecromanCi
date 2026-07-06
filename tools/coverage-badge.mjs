#!/usr/bin/env node

/**
 * Generates a shields.io "endpoint badge" JSON from the monecromanci
 * package's own Jest coverage summary, so the README can show a live
 * coverage badge without a third-party service (Codecov, Coveralls, ...).
 *
 * Run after `npm run test:cov` in libs/monecromanci (which emits
 * coverage/coverage-summary.json via the json-summary reporter):
 *   node tools/coverage-badge.mjs
 *
 * Writes .github/badges/coverage.json, consumed via:
 *   https://img.shields.io/endpoint?url=<raw-github-url-to-that-file>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const summaryPath = path.join(repoRoot, 'libs/monecromanci/coverage/coverage-summary.json')
const badgePath = path.join(repoRoot, '.github/badges/coverage.json')

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
const pct = summary.total.statements.pct

const color = pct >= 90 ? 'brightgreen' : pct >= 80 ? 'green' : pct >= 60 ? 'yellow' : 'red'

const badge = {
  schemaVersion: 1,
  label:         'coverage',
  message:       `${pct}%`,
  color,
}

mkdirSync(path.dirname(badgePath), { recursive: true })
writeFileSync(badgePath, `${JSON.stringify(badge, null, 2)}\n`)

console.log(`Wrote ${badgePath}: ${badge.message} (${badge.color})`)
