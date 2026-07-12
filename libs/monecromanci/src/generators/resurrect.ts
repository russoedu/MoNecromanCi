import { join } from 'node:path'
import { applyFiles, reportApply } from '../engine/apply'
import { configFromVars, isManagedRepo, loadConfig, saveConfig } from '../engine/config'
import { DEFAULT_BASE, DEFAULT_NODE_VERSION, DEFAULT_TRIGGER_BRANCHES } from '../engine/constants'
import { ensureLegacyPeerDependencies, isLegacyPeerDependenciesMissing, removeSupersededDependencies } from '../engine/dependenciesHealth'
import { detectRepoDefaults, findCandidates } from '../engine/detect'
import type { CandidateProject } from '../engine/detect'
import { fileExists } from '../engine/fsx'
import { mergeManifest, setRootDependencies } from '../engine/rootPackage'
import type { ManifestTemplate } from '../engine/rootPackage'
import type { CiProvider, MonecromanciConfig, MonorepoVars, ProjectKind, ProjectVars, RegistryConfig } from '../engine/types'
import { DEV_DEPENDENCIES, monorepoFiles } from '../templates/monorepo'
import { logger } from '../util/logger'
import { checkbox, confirm, promptBranchList, promptText, select } from '../util/prompts'
import { toSlug } from '../util/strings'
import { applyRootDependencies, projectFiles } from './scaffold'

const KIND_LABELS: Record<ProjectKind, string> = {
  'internal-lib':    'Internal library',
  'publishable-lib': 'Publishable library',
  'cli-tool':        'CLI tool',
  'function-app':    'Azure Function App',
  'node-app':        'Node.js app (generic server)',
  'react-app':       'React app',
  'vue-app':         'Vue app',
  'svelte-app':      'Svelte app',
  'nextjs-app':      'Next.js app (full-stack)',
}

/** The area folder each kind's templates hardcode. */
const KIND_AREAS: Record<ProjectKind, 'apps' | 'libs'> = {
  'internal-lib':    'libs',
  'publishable-lib': 'libs',
  'cli-tool':        'libs',
  'function-app':    'apps',
  'node-app':        'apps',
  'react-app':       'apps',
  'vue-app':         'apps',
  'svelte-app':      'apps',
  'nextjs-app':      'apps',
}

/** Asks the user to confirm (or correct) a candidate's detected kind. */
async function confirmKind (candidate: CandidateProject): Promise<ProjectKind | undefined> {
  const detected = candidate.detected.kind
  const others = (Object.keys(KIND_LABELS) as ProjectKind[]).filter((kind) => kind !== detected)
  const suffix = candidate.packageName ? ` (${candidate.packageName})` : ''

  const answer = await select<ProjectKind | 'skip'>({
    message: `Found ${candidate.path}${suffix} — ${candidate.detected.evidence.join(', ')}. What is it?`,
    choices: [
      { name: `${KIND_LABELS[detected]} (detected)`, value: detected },
      ...others.map((kind) => ({ name: KIND_LABELS[kind], value: kind })),
      { name: 'Skip — don\'t manage this project', value: 'skip' as const },
    ],
  })

  if (answer === 'skip') {
    return undefined
  }

  if (KIND_AREAS[answer] !== candidate.area) {
    logger.warn(`${candidate.path} is a ${KIND_LABELS[answer]} but lives in ${candidate.area}/ — move it to ${KIND_AREAS[answer]}/ and run resurrect again.`)
    return undefined
  }

  return answer
}

/** A select that lists the detected value first, marked as such. */
async function selectWithDetected<T extends string> (message: string, choices: Array<{ name: string, value: T }>, detected: T | undefined): Promise<T> {
  const ordered = detected
    ? [
        { name: `${choices.find((choice) => choice.value === detected)?.name ?? detected} (detected)`, value: detected },
        ...choices.filter((choice) => choice.value !== detected),
      ]
    : choices
  return await select<T>({ message, choices: ordered })
}

/** Prompts for the publish registry, defaulting to whatever could be detected. */
async function promptRegistry (ci: CiProvider, detected: RegistryConfig | undefined): Promise<RegistryConfig> {
  const fallbackKind: RegistryConfig['kind'] = detected?.kind ?? (ci === 'github' ? 'github-packages' : 'azure-artifacts')
  const kind = await selectWithDetected<RegistryConfig['kind']>('Package registry', [
    { name: 'Azure Artifacts', value: 'azure-artifacts' },
    { name: 'GitHub Packages', value: 'github-packages' },
    { name: 'Public npm', value: 'npm' },
  ], fallbackKind)

  if (kind === 'azure-artifacts') {
    const detectedAzure = detected?.kind === 'azure-artifacts' ? detected : undefined
    const organization = await promptText('Azure DevOps organization', detectedAzure?.organization ?? 'my-org')
    const project = await promptText('Azure DevOps project', detectedAzure?.project ?? 'Automation')
    const artifactsFeed = await promptText('Azure Artifacts feed', detectedAzure?.artifactsFeed ?? 'AUTO')
    return { kind, organization, project, artifactsFeed }
  }

  if (kind === 'github-packages') {
    const detectedOwner = detected?.kind === 'github-packages' ? detected.owner : undefined
    const owner = await promptText('GitHub owner (org or user)', detectedOwner ?? 'my-org')
    return { kind, owner }
  }

  return { kind: 'npm' }
}

/** Prompts for the stamp inputs, defaulting to whatever could be detected. */
async function promptRepoVars (repoRoot: string, candidates: CandidateProject[]): Promise<MonorepoVars> {
  const defaults = detectRepoDefaults(repoRoot, candidates)

  const displayName = await promptText('Monorepo name', defaults.displayName ?? 'My Monorepo')

  const ci = await selectWithDetected<CiProvider>('CI provider', [
    { name: 'Azure DevOps Pipelines', value: 'azure' },
    { name: 'GitHub Actions', value: 'github' },
    { name: 'Both', value: 'both' },
  ], defaults.ci ?? 'azure')

  const registry = await promptRegistry(ci, defaults.registry)

  const defaultScope = defaults.scope ?? (registry.kind === 'github-packages' ? `@${registry.owner}` : '@auto')
  const scopeInput = await promptText('npm scope', defaultScope)
  const scope = scopeInput.startsWith('@') ? scopeInput : `@${scopeInput}`
  const defaultBase = await promptText('Default git branch', defaults.defaultBase ?? DEFAULT_BASE)
  const triggerBranches = await promptBranchList('Branches that should trigger CI', DEFAULT_TRIGGER_BRANCHES)

  return {
    workspaceName: toSlug(displayName),
    displayName,
    scope,
    defaultBase,
    nodeVersion:   defaults.nodeVersion ?? DEFAULT_NODE_VERSION,
    ci,
    registry,
    triggerBranches,
  }
}

/** Parses the scripts/workspaces/engines out of a template-generated package.json spec. */
function manifestTemplateFrom (content: string): ManifestTemplate {
  const parsed = JSON.parse(content) as ManifestTemplate
  return { scripts: parsed.scripts, workspaces: parsed.workspaces, engines: parsed.engines }
}

/** Applies the canonical root files, manifest merges, and toolchain pins. */
function resurrectRoot (repoRoot: string, vars: MonorepoVars): void {
  logger.step('Applying canonical root config')
  const specs = monorepoFiles(vars)
  reportApply(applyFiles(repoRoot, specs))

  const packageSpec = specs.find((spec) => spec.path === 'package.json')
  if (packageSpec) {
    const added = mergeManifest(repoRoot, manifestTemplateFrom(packageSpec.content))
    if (added.length > 0) {
      logger.step(`added to package.json: ${added.join(', ')}`)
    }
  }

  const pinned = setRootDependencies(repoRoot, DEV_DEPENDENCIES, 'devDependencies')
  if (pinned.length > 0) {
    logger.step(`pinned toolchain versions: ${pinned.join(', ')}`)
  }

  const removed = removeSupersededDependencies(repoRoot)
  if (removed.length > 0) {
    logger.step(`removed superseded lint packages: ${removed.join(', ')} (replaced by the tool-owned eslint.config.mjs)`)
  }
  if (isLegacyPeerDependenciesMissing(repoRoot)) {
    ensureLegacyPeerDependencies(repoRoot)
    logger.step('added legacy-peer-deps=true to .npmrc')
  }

  saveConfig(repoRoot, configFromVars(vars))
}

/** Applies one project's tool-owned config without touching its sources. */
function resurrectProject (repoRoot: string, candidate: CandidateProject, kind: ProjectKind, config: MonecromanciConfig): void {
  const vars: ProjectVars = {
    kind,
    name:        candidate.name,
    packageName: candidate.packageName ?? `${config.scope}/${candidate.name}`,
    scope:       config.scope,
    registry:    config.registry,
  }

  logger.step(`Resurrecting ${kind} '${candidate.path}' (${vars.packageName})`)

  // Never plant sample sources (greeter/App/...) inside a real project; the
  // config-ish scaffold files (.env.*, index.html) are still created when
  // missing, and applyFiles keeps any that already exist. jest.config.mjs is
  // tool-owned (doctor drift-checks it going forward) but, like the scaffold
  // files, must never be silently clobbered by this one-shot adoption step —
  // an adopted repo's existing jest config may be hand-customised, and this
  // path (unlike doctor's) has no diff/preview before writing.
  const specs = projectFiles(kind, vars)
    .filter((spec) => !(spec.ownership === 'scaffold' && spec.path.startsWith(`${candidate.path}/src/`)))
    .filter((spec) => !(spec.path === `${candidate.path}/jest.config.mjs` && fileExists(join(repoRoot, spec.path))))
  reportApply(applyFiles(repoRoot, specs))
  applyRootDependencies(repoRoot, kind)

  const packageSpec = specs.find((spec) => spec.path === `${candidate.path}/package.json`)
  if (packageSpec) {
    const added = mergeManifest(join(repoRoot, candidate.path), { scripts: manifestTemplateFrom(packageSpec.content).scripts })
    if (added.length > 0) {
      logger.step(`added to ${candidate.path}/package.json: ${added.join(', ')}`)
    }
  }
}

/**
 * Interactive `monecromanci resurrect`: adopt an existing monorepo.
 *
 * @remarks
 * Scans apps/ and libs/ for unmanaged projects, asks the user to confirm each
 * one's detected kind, asks a hard are-you-sure confirmation (tool-owned
 * config is overwritten and toolchain versions pinned; sources are never
 * touched), then lets the user pick which projects to adopt (select all with
 * `a`, invert with `i`, or toggle one by one). Projects left out stay
 * unmanaged and are offered again on the next run.
 *
 * @param None - this function takes no parameters.
 * @returns A promise that resolves once the repo has been resurrected (or the
 * user aborted).
 * @throws Propagates errors from the underlying file, prompt, or config
 * operations; the CLI entry point in `cli.ts` catches and reports them.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runResurrect (): Promise<void> {
  const repoRoot = process.cwd()

  if (!fileExists(join(repoRoot, 'package.json'))) {
    logger.error('No package.json found here. Run `resurrect` from the monorepo root.')
    return
  }

  const scan = findCandidates(repoRoot)

  for (const path of scan.managed) {
    logger.info(`  ${path} is already managed by MoNecromanCi — use \`monecromanci doctor\` to keep it in sync.`)
  }
  for (const path of scan.outside) {
    logger.warn(`${path} lives outside apps//libs/ — move it into apps/ or libs/ and run resurrect again to adopt it.`)
  }

  if (scan.candidates.length === 0) {
    if (isManagedRepo(repoRoot)) {
      logger.success('Nothing to resurrect: every project here is already managed.')
    } else {
      logger.warn('No projects found under apps/ or libs/. You can still resurrect the root config.')
    }
  }

  const confirmed: { candidate: CandidateProject, kind: ProjectKind }[] = []
  for (const candidate of scan.candidates) {
    const kind = await confirmKind(candidate)
    if (kind) {
      confirmed.push({ candidate, kind })
    }
  }

  const existingConfig = loadConfig(repoRoot)
  const vars: MonorepoVars = existingConfig
    ? {
        workspaceName:   existingConfig.workspaceName,
        displayName:     existingConfig.displayName,
        scope:           existingConfig.scope,
        defaultBase:     existingConfig.defaultBase,
        nodeVersion:     existingConfig.nodeVersion,
        ci:              existingConfig.ci,
        registry:        existingConfig.registry,
        triggerBranches: existingConfig.triggerBranches?.length
          ? existingConfig.triggerBranches
          : await promptBranchList('Branches that should trigger CI', DEFAULT_TRIGGER_BRANCHES),
      }
    : await promptRepoVars(repoRoot, scan.candidates)

  const proceed = await confirm({
    message: 'This will overwrite this repo\'s tool-owned config (tsconfig, eslint, nx.json, jest presets, pipelines) and pin the toolchain dependency versions. Your source code and existing scaffold files are never touched. Continue?',
    default: false,
  })
  if (!proceed) {
    logger.warn('Aborted. Nothing was changed.')
    return
  }

  const selected = confirmed.length > 0
    ? await checkbox<{ candidate: CandidateProject, kind: ProjectKind }>({
        message: 'Which projects should be resurrected? (press <a> to toggle all, <i> to invert)',
        choices: confirmed.map((entry) => ({
          name:    `${entry.candidate.path} — ${KIND_LABELS[entry.kind]}`,
          value:   entry,
          checked: true,
        })),
      })
    : []

  resurrectRoot(repoRoot, vars)

  const config = configFromVars(vars)
  for (const entry of selected) {
    resurrectProject(repoRoot, entry.candidate, entry.kind, config)
  }

  const skipped = confirmed.filter((entry) => !selected.includes(entry))
  if (skipped.length > 0) {
    logger.info(`  Left unmanaged: ${skipped.map((entry) => entry.candidate.path).join(', ')}. Run \`monecromanci resurrect\` again anytime to adopt them.`)
  }

  logger.success(`Resurrected the root config and ${selected.length} project(s). Next steps:`)
  logger.info('  npm install')
  logger.info('  monecromanci doctor')
  reportReleaseBaselines(selected)
}

/** The project kinds that `nx release` versions and publishes. */
const PUBLISHABLE_KINDS = new Set<ProjectKind>(['publishable-lib', 'cli-tool'])

/**
 * Prints release-baseline instructions for adopted publishable projects.
 *
 * @remarks
 * `nx release` derives each project's next version from a git tag named
 * `{projectName}@{version}`. A repo adopted from outside MoNecromanCI has no
 * such tags, so — for any project already published to a registry — nx would
 * compute from the scaffold `0.0.0` and clash with the higher version already
 * on the feed (`npm publish` then refuses to move the `latest` tag backwards).
 * This prints the one-time baseline seeding a maintainer must do; brand-new
 * projects with no published history can ignore it.
 *
 * @param selected - The projects the run adopted, with their confirmed kinds.
 * @returns Nothing.
 * @throws Never - only writes to the logger.
 * @typeParam None - this function has no generic type parameters.
 */
function reportReleaseBaselines (selected: { candidate: CandidateProject, kind: ProjectKind }[]): void {
  const publishable = selected.filter((entry) => PUBLISHABLE_KINDS.has(entry.kind))
  if (publishable.length === 0) {
    return
  }

  logger.info('')
  logger.warn('Publishable project(s) adopted — seed a release baseline before your first release.')
  logger.info('  nx release derives each version from a git tag `<project>@<version>`. This repo has')
  logger.info('  no such tags yet, so any project already published to a registry needs a one-time')
  logger.info('  baseline at its CURRENT published version (skip this for projects never published):')
  for (const entry of publishable) {
    logger.info(`    git tag -a "${entry.candidate.name}@<current-version>" -m "release baseline"   # then set ${entry.candidate.path}/package.json version to match`)
  }
  logger.info('  git push origin --tags')
  logger.info('  Verify with `npx nx release version --dry-run`. See MoNecromanCi.md → "Adopting a repo with published history".')
}
