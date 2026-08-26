import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runShell } from '../nx'
import { ESLINT_VERSION, RETIRED_FORMATTER_FILES, type RegistryConfig } from '../overlay'
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
 * Normalises a `globSync` result to forward slashes.
 *
 * @remarks
 * Load-bearing on Windows, where `globSync` returns `packages\name\file`. Two
 * checks here split those results on `'/'`, and on a backslash path
 * `lastIndexOf('/')` is `-1`, so `slice(0, -1)` silently drops the last
 * character instead of the filename. The resulting path resolves to nothing,
 * which turned {@link checkVersionActions} — the highest-consequence check in
 * this file — into a check that reported a failure for EVERY publishable
 * Dart/Python package on Windows, including correctly configured ones, under a
 * mangled name. A doctor that cries wolf on a healthy workspace is worse than
 * one that stays quiet.
 *
 * @param path - A workspace-relative path from `globSync`.
 * @returns The same path with forward slashes.
 * @throws Never - performs a pure string replacement.
 * @typeParam None - this function has no generic type parameters.
 */
function toPosix(path: string): string {
  return path.replaceAll('\\', '/')
}

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
function checkEslintConfigs (workspaceRoot: string): Finding[] {
  const rootConfigs = globSync('eslint.config.{js,mjs,cjs,ts,mts,cts}', { cwd: workspaceRoot })
  const projectConfigs = globSync('{apps,libs,packages}/*/eslint.config.{js,mjs,cjs,ts,mts,cts}', {
    cwd: workspaceRoot
  }).map(config => toPosix(config))

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
 * The root manifest's devDependencies, tolerantly.
 *
 * @remarks
 * `readJson` throws on a missing file, and doctor exists to diagnose exactly
 * the broken workspaces where one might be absent — so it must not die on the
 * thing it is inspecting.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The declared devDependencies, or an empty map.
 * @throws Never - a missing or malformed manifest reads as empty.
 * @typeParam None - this function has no generic type parameters.
 */
function declaredDevDependencies (workspaceRoot: string): Record<string, string> {
  try {
    const manifest = readJson<{ devDependencies?: Record<string, string> }>(
      join(workspaceRoot, 'package.json')
    )
    return manifest.devDependencies ?? {}
  } catch {
    return {}
  }
}

/**
 * Fails when a retired formatter's config or dependency is still present.
 *
 * @remarks
 * ESLint is the only linter and the only formatter. Two checks used to live
 * here — one for the eslint/oxlint mode split, one for "exactly one formatter
 * declared" — and both are meaningless now that there is nothing to choose.
 * This replaces them with the failure that survived the collapse.
 *
 * A leftover `.prettierrc.mjs`, `.oxfmtrc.json` or `oxlint.config.ts` is inert
 * from the command line, because nothing runs those binaries any more. That is
 * precisely what makes it worth a check: a globally installed
 * `esbenp.prettier-vscode` or `oxc.oxc-vscode` still resolves the config and
 * still reformats on save, so the editor quietly undoes Standard — semicolons
 * come back, `function f (a)` loses its space — while `npm run lint` reports
 * nothing, because the damage lands after the last check ran. A declared
 * `prettier` in `devDependencies` is the same trap by the other route, since
 * the extension resolves the formatter from the project.
 *
 * `mnci upgrade` removes all of them; this reports a workspace that has not
 * been upgraded yet, and names the command that fixes it.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The finding.
 * @throws Never - only reads the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
function checkNoRetiredFormatter (workspaceRoot: string): Finding {
  const files = RETIRED_FORMATTER_FILES.filter(file => fileExists(join(workspaceRoot, file)))
  const declared = ['prettier', 'eslint-config-prettier', 'oxlint', 'oxfmt', '@mnci/oxlint-config']
    .filter(name => declaredDevDependencies(workspaceRoot)[name] !== undefined)
  const stale = [...files, ...declared]

  if (stale.length === 0) {
    return { check: 'ESLint is the only linter and formatter', ok: true }
  }
  return {
    check: 'no retired formatter is still configured',
    ok: false,
    detail:
      `Found: ${stale.join(', ')}. These no longer run, but an editor extension ` +
      'still resolves them and will reformat on save against an opinion no gate ' +
      'checks.',
    remedy: "Run 'mnci upgrade' to remove them."
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
function checkEslintPlugin (nxJson: Record<string, unknown>): Finding {
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
function checkResolvedEslint (workspaceRoot: string): Finding | undefined {
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
function checkNpmrc (
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
function checkVersionActions (workspaceRoot: string): Finding[] {
  const candidates = [
    ...globSync('packages/*/pubspec.yaml', { cwd: workspaceRoot }),
    ...globSync('python-packages/*/pyproject.toml', { cwd: workspaceRoot })
  ].map(manifest => toPosix(manifest))
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
 * The target options whose value is a single path to a file that must already
 * exist for the target to run.
 *
 * @remarks
 * Deliberately short. `outputPath` is an output, not an input, so it is absent
 * by design; `assets` takes globs and would need matching rather than an
 * existence test. These three are the ones whose absence produces a failure
 * that reads as a compiler problem rather than a config problem.
 */
const TARGET_FILE_OPTIONS = ['main', 'tsConfig', 'packageJson'] as const

/**
 * Reads every Nx target a project declares, from either place it can declare them.
 *
 * @remarks
 * A project can carry targets in `project.json` **and** in `package.json`'s `nx`
 * block, and a real workspace was found doing both for one project with
 * different `main` values in each. Both are read here rather than whichever is
 * found first, so a stale definition cannot hide behind the live one.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param projectRoot - The project's workspace-relative directory.
 * @returns One entry per declaring file, with that file's targets.
 * @throws Never - an unreadable or absent manifest contributes no targets.
 * @typeParam None - this function has no generic type parameters.
 */
function declaredTargets(
  workspaceRoot: string,
  projectRoot: string
): { source: string; targets: Record<string, { options?: Record<string, unknown> }> }[] {
  const sources: {
    source: string
    targets: Record<string, { options?: Record<string, unknown> }>
  }[] = []
  for (const [file, extract] of [
    ['project.json', (json: Record<string, unknown>) => json['targets']],
    [
      'package.json',
      (json: Record<string, unknown>) => (json['nx'] as Record<string, unknown>)?.['targets']
    ]
  ] as const) {
    try {
      const targets = extract(
        readJson<Record<string, unknown>>(join(workspaceRoot, projectRoot, file))
      )
      if (targets && typeof targets === 'object') {
        sources.push({
          source: `${projectRoot}/${file}`,
          targets: targets as Record<string, { options?: Record<string, unknown> }>
        })
      }
    } catch {
      // No manifest, or unparseable — nothing to check, and the other checks
      // already report a workspace that broken.
    }
  }
  return sources
}

/**
 * Checks that every target option naming a file points at a file that exists.
 *
 * @remarks
 * Found in a real hand-built workspace, three times over in one repo: a build
 * target whose `main` was `src/index.ts` in `project.json` and `src/main.ts` in
 * the same project's `package.json`, with **neither** file present, and a
 * library whose `tsConfig` named a `tsconfig.lib.json` that had never been
 * written.
 *
 * Worth a check rather than left to the build because of how it surfaces. Nx
 * hands the path to the executor unvalidated, so the failure arrives as a
 * TypeScript or esbuild error about the compiler finding no inputs — which
 * reads as a broken tsconfig, and sends people to edit the one file that is
 * fine. Nothing anywhere names the missing file.
 *
 * Paths carrying an Nx token (`{workspaceRoot}`, `{projectRoot}`) are skipped:
 * they are resolved by Nx at run time, so testing them literally would report a
 * file that is never meant to exist under that name.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns One finding per target option pointing at a missing file.
 * @throws Never - only reads the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
function checkTargetFilesExist(workspaceRoot: string): Finding[] {
  const projectRoots = new Set(
    [
      ...globSync('{apps,libs,packages}/*/project.json', { cwd: workspaceRoot }),
      ...globSync('{apps,libs,packages}/*/package.json', { cwd: workspaceRoot })
    ].map(manifest => toPosix(manifest).split('/').slice(0, 2).join('/'))
  )

  return [...projectRoots].flatMap(projectRoot =>
    declaredTargets(workspaceRoot, projectRoot).flatMap(({ source, targets }) =>
      Object.entries(targets).flatMap(([targetName, target]) =>
        checkOneTargetsFiles(workspaceRoot, source, targetName, target)
      )
    )
  )
}

/**
 * Checks one target's file-valued options.
 *
 * @remarks
 * Split out of {@link checkTargetFilesExist} so the sweep stays a flat
 * comprehension rather than four nested loops around a pair of `continue`s.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param source - The manifest that declared the target, for the message.
 * @param targetName - The target's name, for the message.
 * @param target - The target definition to inspect.
 * @returns One finding per option pointing at a missing file.
 * @throws Never - only reads the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
function checkOneTargetsFiles(
  workspaceRoot: string,
  source: string,
  targetName: string,
  target: { options?: Record<string, unknown> }
): Finding[] {
  return TARGET_FILE_OPTIONS.flatMap(option => {
    const value = target?.options?.[option]
    // A token (`{workspaceRoot}`, `{projectRoot}`) is resolved by Nx at run
    // time, so a literal existence test would report a file that is never
    // meant to exist under that name.
    const checkable = typeof value === 'string' && !value.includes('{')
    if (!checkable || fileExists(join(workspaceRoot, value))) {
      return []
    }
    return [
      {
        check: `${source} → ${targetName}.${option} points at a real file`,
        ok: false,
        detail: `${value} does not exist — the target fails as if the compiler were misconfigured`,
        remedy: `create ${value}, or correct ${option} in ${source}`
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
function checkSync (workspaceRoot: string): Finding {
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
export function collectFindings (workspaceRoot: string): Finding[] {
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
    checkNoRetiredFormatter(workspaceRoot),
    checkEslintPlugin(nxJson),
    checkResolvedEslint(workspaceRoot),
    checkNpmrc(workspaceRoot, nxJson.mnci?.registry, nxJson.mnci?.scope),
    ...checkVersionActions(workspaceRoot),
    ...checkTargetFilesExist(workspaceRoot),
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
export function runDoctor (workspaceRoot: string): void {
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
