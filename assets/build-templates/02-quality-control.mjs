#!/usr/bin/env node

/**
 * Step 02 — Quality control.
 *
 * Runs lint, test and build for the affected projects over the resolved git
 * range. Kept as a Node step (rather than a repo `qa` npm script) so the
 * template stays self-contained — a consuming repo only needs the standard Nx
 * `lint`/`test`/`build` targets, defined either in `project.json` or via the
 * `@nx/*` inference plugins.
 */

import process from 'node:process'
import { banner, shellEscape } from './lib/_h.mjs'
import { runNxInherit } from './lib/nx.mjs'

/**
 * Runs lint, test and build for the affected project set.
 */
function main () {
  banner('[02] Quality control — lint, test and build affected projects')

  const base = process.env.NX_BASE || ''
  const head = process.env.NX_HEAD || ''
  const range = base && head ? ` --base=${shellEscape(base)} --head=${shellEscape(head)}` : ''

  runNxInherit(`affected -t lint,test,build${range} --outputStyle=static`)

  banner('[02] Quality control complete')
}

main()
