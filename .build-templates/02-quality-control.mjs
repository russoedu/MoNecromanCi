#!/usr/bin/env node

/**
 * Step 02 — Quality control.
 *
 * Runs lint, test, build and e2e for the affected projects over the resolved
 * git range. Kept as a Node step (rather than a repo `qa` npm script) so the
 * template stays self-contained — a consuming repo only needs the standard Nx
 * `lint`/`test`/`build`/`e2e` targets, defined either in `project.json` or via
 * the `@nx/*` inference plugins. `e2e` is opt-in per project: `nx affected`
 * silently skips a target a project doesn't define, so a project with no
 * `e2e` target (most of them) is unaffected by listing it here — it's the
 * mechanism that lets `monecromanci-v2`'s real, slow, network-touching e2e
 * suite (proving generated workspaces actually build/lint/test on the real
 * toolchain, not just against mocks) run automatically whenever that project
 * itself is affected, without adding an e2e target — or its runtime — to
 * every other project in the repo.
 */

import process from 'node:process'
import { banner, shellEscape } from './lib/_h.mjs'
import { runNxInherit } from './lib/nx.mjs'

/**
 * Runs lint, test, build and e2e for the affected project set.
 */
function main () {
  banner('[02] Quality control — lint, test, build and e2e for affected projects')

  const base = process.env.NX_BASE || ''
  const head = process.env.NX_HEAD || ''
  const range = base && head ? ` --base=${shellEscape(base)} --head=${shellEscape(head)}` : ''

  runNxInherit(`affected -t lint,test,build,e2e${range} --outputStyle=static`)

  banner('[02] Quality control complete')
}

main()
