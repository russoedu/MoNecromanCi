import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runNx } from '../../nx'
import { fileExists, readJson, toJson, writeFileEnsured } from '../../util/fsx'
import { logger } from '../../util/logger'
import { ensureAdmZip, hasPlugin, type WorkspaceStack } from './shared'

/**
 * Ensures an Nx plugin is installed in the workspace, installing it on first use.
 *
 * @remarks
 * `nx add` installs the package and runs its init generator — the Nx-native
 * way to bring a plugin into an existing workspace.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param packageName - The plugin package (e.g. `@nx/react`).
 * @returns Nothing.
 * @throws Error when the underlying `nx add` exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function ensurePlugin (workspaceRoot: string, packageName: string): void {
  if (hasPlugin(workspaceRoot, packageName)) {
    return
  }
  logger.step(`Installing Nx plugin ${packageName}`)
  runNx(['add', packageName], workspaceRoot)
}

/**
 * The deploy environments each React app is built for.
 *
 * @remarks
 * A React SPA bakes its `VITE_*` config in at build time, so one build per
 * environment is needed. These are the three the generator scaffolds.
 */
export const REACT_ENVIRONMENTS = ['dev', 'uat', 'prod'] as const

/**
 * The `.env.<environment>` file scaffolded into a React app.
 *
 * @remarks
 * `vite build --mode <environment>` loads this file and compiles its `VITE_`
 * vars into that environment's bundle. Because those values ship to the
 * browser they are inherently public, so committing them (rather than sourcing
 * secrets) is correct — real secrets never belong in a client bundle.
 *
 * @param environment - The environment name (`dev` | `uat` | `prod`).
 * @returns The `.env.<environment>` file contents.
 * @throws Never - pure string build.
 * @typeParam None - this function has no generic type parameters.
 */
export function reactEnvironmentFile (environment: string): string {
  return `# Vite compiles VITE_-prefixed vars into the '${environment}' bundle at build time.
# They ship to the browser, so keep only PUBLIC config here — never secrets.
VITE_ENVIRONMENT=${environment}
VITE_API_URL=https://api.${environment}.example.com
`
}

/**
 * The per-environment build + packaging targets for a React app.
 *
 * @remarks
 * One `build-<env>` target per {@link REACT_ENVIRONMENTS} entry runs
 * `vite build --mode <env> --outDir dist-<env>`, so each environment gets its
 * own compiled-in `VITE_*` config. The `package` target depends on all three
 * and zips each `dist-<env>` into `dist/drop/react-app-<name>-<env>.zip` — one
 * artifact per environment. CI needs no change: the "tag per app" step derives
 * `##vso[build.addbuildtag]react-app-<name>-<env>` straight from the zip
 * filenames, so a classic release pipeline can deploy each environment from its
 * own artifact + tag. The inference-only `build` (default mode) stays for local
 * `nx build` and the CI verify step.
 *
 * @param name - The React app's project name.
 * @returns The Nx targets to merge into the app manifest's `nx` field.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
export function reactAppTargets (name: string): Record<string, unknown> {
  const targets: Record<string, unknown> = {}
  for (const environment of REACT_ENVIRONMENTS) {
    targets[`build-${environment}`] = {
      executor: 'nx:run-commands',
      // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {workspaceRoot} is an Nx output token
      outputs:  [`{workspaceRoot}/apps/${name}/dist-${environment}`],
      options:  { command: `vite build --mode ${environment} --outDir dist-${environment}`, cwd: `apps/${name}` },
    }
  }
  const zipStatements = REACT_ENVIRONMENTS
    .map((environment) => `z=new A();z.addLocalFolder('apps/${name}/dist-${environment}');z.writeZip('dist/drop/react-app-${name}-${environment}.zip')`)
    .join(';')
  targets.package = {
    executor:  'nx:run-commands',
    dependsOn: REACT_ENVIRONMENTS.map((environment) => `build-${environment}`),
    // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {workspaceRoot} tokens, not JS interpolation
    outputs:   REACT_ENVIRONMENTS.map((environment) => `{workspaceRoot}/dist/drop/react-app-${name}-${environment}.zip`),
    options:   { command: `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');let z;${zipStatements}"` },
  }
  return targets
}

/**
 * Ensures the committed per-environment `.env.<env>` files are not gitignored.
 *
 * @remarks
 * The `.env.<env>` files hold public config and are meant to be versioned, but
 * some presets ignore `.env*`. This appends an idempotent allow-block to the
 * root `.gitignore` so `apps/<app>/.env.<env>` stays tracked regardless (a
 * no-op when nothing ignored them). File-level negation works because the
 * parent `apps/<app>` directory is never ignored.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Propagates any `fs` error reading or writing `.gitignore`.
 * @typeParam None - this function has no generic type parameters.
 */
function allowEnvFiles (workspaceRoot: string): void {
  const gitignorePath = join(workspaceRoot, '.gitignore')
  if (!fileExists(gitignorePath)) {
    return
  }
  const marker = '# MoNecromanCI: keep the committed per-environment Vite config (public VITE_ values)'
  const current = readFileSync(gitignorePath, 'utf8')
  if (current.includes(marker)) {
    return
  }
  const allow = REACT_ENVIRONMENTS.map((environment) => `!apps/*/.env.${environment}`).join('\n')
  writeFileEnsured(gitignorePath, `${current.replace(/\n*$/, '\n')}\n${marker}\n${allow}\n`)
}

/**
 * Merges extra Nx targets into an inference-only app via its manifest `nx` field.
 *
 * @remarks
 * React apps generated by `@nx/react:app` have no `project.json` (targets are
 * inferred), so extra targets (the per-environment builds and the `package`
 * target) are attached through the package.json `nx` field — merged with the
 * inferred targets, and free of the project-name clash a second `project.json`
 * would risk in a TS-solution workspace.
 *
 * @param manifestPath - Absolute path to the app's `package.json`.
 * @param newTargets - The targets to merge in (e.g. from {@link reactAppTargets}).
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function addNxTargets (manifestPath: string, newTargets: Record<string, unknown>): void {
  // The generator always writes this manifest first (runAdd throws otherwise);
  // defaulting to {} only guards the pathological missing-file case.
  const manifest = fileExists(manifestPath) ? readJson<Record<string, unknown>>(manifestPath) : {}
  const nx = (manifest.nx as Record<string, unknown> | undefined) ?? {}
  const targets = (nx.targets as Record<string, unknown> | undefined) ?? {}
  writeFileEnsured(manifestPath, toJson({ ...manifest, nx: { ...nx, targets: { ...targets, ...newTargets } } }))
}

/**
 * Adds a React app: `@nx/react:app` (Vite) plus per-environment build/package targets.
 *
 * @remarks
 * Pure delegation to the generator, then the one thing it doesn't do: a React
 * SPA bakes its `VITE_` config in at build time, so it needs one build per
 * environment. Scaffolds a `.env.<env>` per {@link REACT_ENVIRONMENTS} and
 * attaches the per-env build + packaging targets (inference-only app, so via
 * the manifest's `nx` field). Each env produces its own dist/drop zip + tag.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param stack - The workspace's chosen linter/test runner.
 * @returns Nothing.
 * @throws Error when the generator or a required install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addReactApp (workspaceRoot: string, name: string, stack: WorkspaceStack): void {
  ensurePlugin(workspaceRoot, '@nx/react')
  runNx([
    'g', '@nx/react:app', `apps/${name}`,
    '--bundler=vite',
    `--unitTestRunner=${stack.testRunner}`,
    `--linter=${stack.linter}`,
    '--style=css',
    '--e2eTestRunner=none',
    '--no-interactive',
  ], workspaceRoot)
  ensureAdmZip(workspaceRoot)
  const reactAppRoot = join(workspaceRoot, 'apps', name)
  for (const environment of REACT_ENVIRONMENTS) {
    writeFileEnsured(join(reactAppRoot, `.env.${environment}`), reactEnvironmentFile(environment))
  }
  allowEnvFiles(workspaceRoot)
  addNxTargets(join(reactAppRoot, 'package.json'), reactAppTargets(name))
}
