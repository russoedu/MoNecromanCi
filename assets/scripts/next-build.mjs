#!/usr/bin/env node

/**
 * Builds a Next.js app for one environment and assembles a self-contained drop
 * in `dist-<env>`. The output mode is chosen by NEXT_OUTPUT:
 *   - 'standalone' (default): a runnable Node server (`node dist-<env>/server.js`)
 *   - 'export': a static site
 *
 * Run per environment with the env file loaded, e.g.:
 *   dotenv -e .env.dev -- node ../../tools/next-build.mjs dev
 */
import { execSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const environment = process.argv[2] ?? 'dev'
const mode = process.env.NEXT_OUTPUT === 'export' ? 'export' : 'standalone'
const cwd = process.cwd()
const distDir = join(cwd, `dist-${environment}`)

rmSync(distDir, { recursive: true, force: true })
execSync('next build', { stdio: 'inherit', cwd, env: { ...process.env, NEXT_OUTPUT: mode } })

if (mode === 'export') {
  cpSync(join(cwd, 'out'), distDir, { recursive: true })
} else {
  cpSync(join(cwd, '.next', 'standalone'), distDir, { recursive: true })
  if (existsSync(join(cwd, '.next', 'static'))) {
    cpSync(join(cwd, '.next', 'static'), join(distDir, '.next', 'static'), { recursive: true })
  }
  if (existsSync(join(cwd, 'public'))) {
    cpSync(join(cwd, 'public'), join(distDir, 'public'), { recursive: true })
  }
}

process.stdout.write(`Assembled dist-${environment} (mode: ${mode})\n`)
