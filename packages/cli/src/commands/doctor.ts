import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runShell } from '../nx'
import { ESLINT_VERSION, readMnciConfig, type RegistryConfig } from '../overlay'
import { fileExists, readJson } from '../util/fsx'
import { logger } from '../util/logger'

/**
 * One check's outcome.
 *
 * @remarks
 * `remedy` is separate from `detail` on purpose: the detail says what is wrong in
 * this workspace, the remedy says what to type. A finding without a remedy is a
 * finding the user cannot act on, which is the main way a doctor command becomes
 * noise.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface Finding {
  /** Short check name, shown as the line label. */
  check: string
  /** Whether the invariant holds. */
  ok: boolean
  /** What is wrong, when it is not ok. */
  detail?: string
  /** The command or edit that fixes it. */
  remedy?: string
}

/** The ESLint major this stack supports, derived from the version mnci pins. */
const SUPPORTED_ESLINT_MAJOR = ESLINT_VERSION.replace(/^\D*/, '').split('.', 1)[0]

/**
 * Checks that the workspace has exactly one ESLint config, at the root.
 *
 * @remarks
 * The invariant that actually broke in practice, twice over: every `@nx/*`
 * generator writes a per-project config, and a workspace generated before mnci
 * owned linting has one in every project directory. Either way the root config
 * stops being the only opinion, silently, because each project lints against
 * whichever config sits nearest it.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The findings for the root config and the per-project sweep.
 * @throws Never - only reads the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
function checkEslintConfigs(workspaceRoot: string): Finding[] {
  const rootConfigs = globSync('eslint.config.{js,mjs,cjs,ts,mts,cts}', { cwd: workspaceRoot })
  const projectConfigs = globSync('{apps,libs,packages}/*/eslint.config.{js,mjs,cjs,ts,mts,cts}', {
    cwd: workspaceRoot
  })

  return [
    {
      check: 'root ESLint config',
      ok: rootConfigs.length === 1,
      detail:
        rootConfigs.length === 0
          ? 'no eslint.config.* at the workspace root'
          : `${rootConfigs.length} root configs: ${rootConfigs.join(', ')}`,
      remedy: 'run `mnci upgrade` to rewrite the root config'
    },
    {
      check: 'no per-project ESLint configs',
      ok: projectConfigs.length === 0,
      detail: `found ${projectConfigs.length}: ${projectConfigs.join(', ')}`,
      remedy: 'run `mnci upgrade`, which sweeps {apps,libs,packages}/*/eslint.config.*'
    }
  ]
}

/**
 * Checks that no `.prettierrc` outranks mnci's `.prettierrc.json`.
 *
 * @remarks
 * Worth a dedicated check because the failure is invisible: both files exist and
 * both look fine, but Prettier's config resolution puts `.prettierrc` **above**
 * `.prettierrc.json`, so the entire formatting opinion is silently discarded.
 * `create-nx-workspace` writes the winning filename.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The finding.
 * @throws Never - only reads the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
function checkPrettierConfig(workspaceRoot: string): Finding {
  const strayExists = fileExists(join(workspaceRoot, '.prettierrc'))
  return {
    check: 'Prettier config is mnci’s',
    ok: !strayExists,
    detail: '.prettierrc exists and outranks .prettierrc.json, so mnci’s config is ignored',
    remedy: 'delete .prettierrc (or run `mnci upgrade`, which deletes it)'
  }
}

/**
 * Checks that exactly one linter mode's config files are present.
 *
 * @remarks
 * The failure this catches is a workspace carrying **both** modes at once —
 * `.prettierrc.mjs` alongside `.oxfmtrc.json`, or an `oxlint.config.ts` in a
 * workspace whose persisted linter is `eslint`. `mnci upgrade` removes the
 * losing mode's files, so this only happens when someone adds one by hand or
 * copies config between repos.
 *
 * It is worth a check for the same reason the `.prettierrc` one is: two formatter
 * configs is not a visible error. Each file is valid on its own, the CLI picks
 * one, the editor extension may pick the other, and the two gates disagree
 * silently — a file formatted correctly by `npm run format` and reformatted on
 * every save.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The finding.
 * @throws Never - only reads the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
function checkLinterModeIsConsistent(workspaceRoot: string): Finding {
  const linter = readMnciConfig(workspaceRoot).stack?.linter ?? 'eslint'
  const oxlintFiles = ['oxlint.config.ts', '.oxfmtrc.json'].filter(file =>
    fileExists(join(workspaceRoot, file))
  )
  const hasPrettier = fileExists(join(workspaceRoot, '.prettierrc.mjs'))

  const stray = linter === 'oxlint' ? (hasPrettier ? ['.prettierrc.mjs'] : []) : oxlintFiles

  return {
    check: `linter is ${linter} and only ${linter}'s config files are present`,
    ok: stray.length === 0,
    detail: `${stray.join(', ')} belongs to the other linter mode, so two configs are in play at once`,
    remedy: 'run `mnci upgrade`, which removes the mode the workspace did not choose'
  }
}

/**
 * Checks that an oxlint workspace declares the binaries it needs.
 *
 * @remarks
 * `@mnci/oxlint-config` **peers** on `oxlint`, so the workspace has to declare
 * it — and `oxfmt` is what the `format` script invokes. Missing either turns
 * `npm run lint`/`npm run format` into a "command not found" at the worst moment
 * rather than at install time.
 *
 * Only meaningful for an oxlint workspace, so it reports `ok` for an ESLint one
 * rather than being skipped: a check that silently disappears is one nobody
 * notices has stopped running.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The finding.
 * @throws Never - only reads the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
function checkOxlintToolchainDeclared(workspaceRoot: string): Finding {
  const linter = readMnciConfig(workspaceRoot).stack?.linter ?? 'eslint'
  if (linter !== 'oxlint') {
    return {
      check: 'oxlint toolchain declared',
      ok: true,
      detail: 'not an oxlint workspace',
      remedy: ''
    }
  }
  const manifest = readJson<{ devDependencies?: Record<string, string> }>(
    join(workspaceRoot, 'package.json')
  )
  const devDeps = manifest?.devDependencies ?? {}
  const missing = ['oxlint', 'oxfmt', '@mnci/oxlint-config'].filter(
    dependency => devDeps[dependency] === undefined
  )

  return {
    check: 'oxlint toolchain declared in devDependencies',
    ok: missing.length === 0,
    detail: `missing: ${missing.join(', ')} — lint or format will fail with "command not found"`,
    remedy: 'run `mnci upgrade`, which writes the toolchain the chosen linter needs'
  }
}

/**
 * Checks that `@nx/eslint/plugin` is registered in `nx.json`.
 *
 * @remarks
 * This registration is what turns the single root config into a `lint` target on
 * every project. Without it, `npm run lint` still exits 0 while linting nothing —
 * a green check that proves nothing, which is worse than a red one.
 *
 * @param nxJson - The parsed `nx.json`.
 * @returns The finding.
 * @throws Never - pure inspection.
 * @typeParam None - this function has no generic type parameters.
 */
function checkEslintPlugin(nxJson: Record<string, unknown>): Finding {
  const plugins = (nxJson.plugins as unknown[] | undefined) ?? []
  const registered = plugins.some(
    entry =>
      (typeof entry === 'string' ? entry : (entry as { plugin?: string }).plugin) ===
      '@nx/eslint/plugin'
  )
  return {
    check: '@nx/eslint/plugin registered',
    ok: registered,
    detail: 'not in nx.json plugins — every project silently loses its lint target',
    remedy: 'run `mnci upgrade`'
  }
}

/**
 * Checks that the ESLint actually installed is the major this stack supports.
 *
 * @remarks
 * The exact bug this command exists for. mnci pins ESLint 9 because
 * `eslint-plugin-react` has no ESLint 10 release, but a declared range and the
 * **resolved** version are different things: this repo carried four package
 * manifests declaring `^10` while the docs said 9, and the resolved binary was 10.
 * Nothing failed, because the repo has no `.tsx` of its own — the drift was only
 * visible by asking `node_modules` what actually got installed.
 *
 * Skipped rather than failed when there are no `node_modules`, since "not
 * installed yet" is not a drift.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The finding, or `undefined` when nothing is installed to inspect.
 * @throws Never - a malformed manifest yields no finding.
 * @typeParam None - this function has no generic type parameters.
 */
function checkResolvedEslint(workspaceRoot: string): Finding | undefined {
  const manifestPath = join(workspaceRoot, 'node_modules/eslint/package.json')
  if (!fileExists(manifestPath)) {
    return undefined
  }
  try {
    const { version } = readJson<{ version: string }>(manifestPath)
    const major = version.split('.', 1)[0]
    return {
      check: `resolved eslint is ${SUPPORTED_ESLINT_MAJOR}.x`,
      ok: major === SUPPORTED_ESLINT_MAJOR,
      detail: `node_modules/eslint is ${version}, but this stack supports ${SUPPORTED_ESLINT_MAJOR}.x (eslint-plugin-react has no release beyond it)`,
      remedy: `pin eslint to ${ESLINT_VERSION} in every package manifest, then reinstall`
    }
  } catch {
    return undefined
  }
}

/**
 * Checks that `.npmrc` matches the registry the workspace recorded.
 *
 * @remarks
 * Only meaningful now that publish auth is wired: the two registry kinds get
 * genuinely different files, so a workspace whose `.npmrc` predates its recorded
 * registry choice cannot publish. An `azure-artifacts` workspace additionally
 * needs its scope routed, which is what keeps a scoped package off npmjs.org.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param registry - The registry persisted in `nx.json`'s `mnci` block.
 * @param scope - The npm scope persisted alongside it.
 * @returns The finding, or `undefined` when nothing is persisted to compare against.
 * @throws Never - only reads the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
function checkNpmrc(
  workspaceRoot: string,
  registry: RegistryConfig | undefined,
  scope: string | undefined
): Finding | undefined {
  const npmrcPath = join(workspaceRoot, '.npmrc')
  if (!registry || !fileExists(npmrcPath)) {
    return undefined
  }
  const npmrc = readFileSync(npmrcPath, 'utf8')
  if (registry.kind === 'npm') {
    return {
      check: '.npmrc authenticates the public registry',
      ok: npmrc.includes('//registry.npmjs.org/:_authToken='),
      detail: 'no npmjs.org token line — `npm publish` cannot authenticate',
      remedy: 'run `mnci upgrade`'
    }
  }
  return {
    check: '.npmrc routes the scope to the feed',
    ok: scope !== undefined && npmrc.includes(`${scope}:registry=`),
    detail: `no '${scope ?? '@scope'}:registry=' line — a scoped package could publish to npmjs.org instead of the feed`,
    remedy: 'run `mnci upgrade`'
  }
}

/**
 * Checks that every publishable non-npm package keeps its `versionActions` override.
 *
 * @remarks
 * The highest-consequence check here, because the blast radius is the whole
 * workspace rather than the offending project: Nx's default `versionActions` reads
 * a `package.json`, which a Dart or Python package does not have, so it aborts
 * while building the release graph and `nx release` fails for **every** project.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns One finding per publishable Dart/Python package missing the override.
 * @throws Never - an unreadable `project.json` is reported as missing.
 * @typeParam None - this function has no generic type parameters.
 */
function checkVersionActions(workspaceRoot: string): Finding[] {
  const candidates = [
    ...globSync('packages/*/pubspec.yaml', { cwd: workspaceRoot }),
    ...globSync('python-packages/*/pyproject.toml', { cwd: workspaceRoot })
  ]
  return candidates.flatMap(manifest => {
    const projectRoot = manifest.slice(0, manifest.lastIndexOf('/'))
    const projectJsonPath = join(workspaceRoot, projectRoot, 'project.json')
    let hasOverride = false
    try {
      const projectJson = readJson<{
        release?: { version?: { versionActions?: string } }
      }>(projectJsonPath)
      hasOverride = Boolean(projectJson.release?.version?.versionActions)
    } catch {
      // No project.json at all, so no override — the initialiser already says so.
    }
    return [
      {
        check: `${projectRoot} keeps its versionActions override`,
        ok: hasOverride,
        detail: 'missing — nx release aborts for the ENTIRE workspace, not just this project',
        remedy: `add release.version.versionActions to ${projectRoot}/project.json`
      }
    ]
  })
}

/**
 * Checks that the workspace's TypeScript project references are synced.
 *
 * @remarks
 * The one check that shells out, because only Nx can answer it. Reported as a
 * finding rather than left to CI so the fix happens before the push that fails.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The finding.
 * @throws Never - a non-zero exit is the finding, not an error.
 * @typeParam None - this function has no generic type parameters.
 */
function checkSync(workspaceRoot: string): Finding {
  return {
    check: 'TypeScript project references synced',
    ok: runShell('npx', ['nx', 'sync:check'], workspaceRoot) === 0,
    detail: 'nx sync:check failed — a stale project reference was never committed',
    remedy: 'run `npx nx sync` and commit the result'
  }
}

/**
 * Collects every doctor finding for a workspace.
 *
 * @remarks
 * Exported separately from {@link runDoctor} so the checks can be asserted
 * directly, without capturing console output or an exit code.
 *
 * Every check corresponds to an invariant that has actually been violated in
 * practice, in this repo or in a workspace it generated — none are hypothetical.
 * That is the bar for adding one: a check nobody has ever needed is noise that
 * trains people to ignore the output.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The findings, in report order.
 * @throws Error when `workspaceRoot` has no `nx.json`.
 * @typeParam None - this function has no generic type parameters.
 */
export function collectFindings(workspaceRoot: string): Finding[] {
  const nxJsonPath = join(workspaceRoot, 'nx.json')
  if (!fileExists(nxJsonPath)) {
    throw new Error(
      `No nx.json found in ${workspaceRoot} — run 'mnci doctor' from the workspace root.`
    )
  }
  const nxJson = readJson<{
    plugins?: unknown[]
    mnci?: { registry?: RegistryConfig; scope?: string }
  }>(nxJsonPath)

  return [
    ...checkEslintConfigs(workspaceRoot),
    checkPrettierConfig(workspaceRoot),
    checkLinterModeIsConsistent(workspaceRoot),
    checkOxlintToolchainDeclared(workspaceRoot),
    checkEslintPlugin(nxJson),
    checkResolvedEslint(workspaceRoot),
    checkNpmrc(workspaceRoot, nxJson.mnci?.registry, nxJson.mnci?.scope),
    ...checkVersionActions(workspaceRoot),
    checkSync(workspaceRoot)
  ].filter((finding): finding is Finding => finding !== undefined)
}

/**
 * Reports on the mnci invariants a workspace is supposed to uphold.
 *
 * @remarks
 * Read-only by design: it never edits the workspace, so it is safe to run
 * anywhere, and every failing finding names the command that fixes it (usually
 * `mnci upgrade`) rather than fixing it silently.
 *
 * Exits non-zero when anything failed, so it works as a CI step as well as a
 * local command. Sets `process.exitCode` rather than calling `process.exit`, so
 * output is never truncated.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Error when `workspaceRoot` is not an Nx workspace.
 * @typeParam None - this function has no generic type parameters.
 */
export function runDoctor(workspaceRoot: string): void {
  const findings = collectFindings(workspaceRoot)
  const failed = findings.filter(finding => !finding.ok)

  for (const finding of findings) {
    if (finding.ok) {
      logger.success(finding.check)
    } else {
      logger.error(`${finding.check} — ${finding.detail ?? 'failed'}`)
      if (finding.remedy) {
        logger.info(`    fix: ${finding.remedy}`)
      }
    }
  }

  if (failed.length === 0) {
    logger.success(`All ${findings.length} checks passed.`)
    return
  }
  logger.error(`${failed.length} of ${findings.length} checks failed.`)
  process.exitCode = 1
}
