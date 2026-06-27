#!/usr/bin/env node

/**
 * Step 03 — Package affected apps.
 *
 * Builds, packages and stages every affected Azure Function app and React app
 * declared in the context manifest. Function apps receive a generated runtime
 * `package.json` whose dependencies are discovered from the built output, with
 * internal workspace libraries vendored as tarballs. React apps are zipped per
 * build output directory. The Azure YAML step then publishes the staged folders
 * as pipeline artifacts.
 *
 * Run locally with `npm run pipeline:package` (after `npm ci`) to exercise the
 * build/zip flow into `./.pipeline-out` without a pipeline. The local dry run
 * skips the production dependency install (which needs registry auth).
 */

import { builtinModules } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  addBuildTag,
  banner,
  isWindows,
  log,
  readJsonSafe,
  run,
  runInherit,
  section,
  shellEscape,
  warn,
  writeJson,
} from './lib/_h.mjs'
import { loadContext, selectAffected } from './lib/context.mjs'
import { runNxInherit } from './lib/nx.mjs'

const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map(moduleName => `node:${moduleName.replace(/^node:/, '')}`),
])

const WORKSPACE_ROOT = process.cwd()
const SOURCES_DIR = process.env.BUILD_SOURCESDIRECTORY || WORKSPACE_ROOT
// Folder that gets published as an artifact — must contain ONLY the final zips.
const STAGING_DIR = process.env.BUILD_ARTIFACTSTAGINGDIRECTORY || path.join(WORKSPACE_ROOT, '.pipeline-out')
// Scratch area for the unzipped app folders (incl. node_modules). NOT published —
// keeping it out of STAGING_DIR is what stops the artifact upload from shipping
// thousands of loose node_modules files.
const STAGE_AREA = process.env.AGENT_TEMPDIRECTORY || path.join(WORKSPACE_ROOT, '.pipeline-staging')
const BUILD_ID = process.env.BUILD_BUILDID || 'local'
const NPM_BIN = isWindows() ? 'npm.cmd' : 'npm'
const NPM_USER_CONFIG = path.join(SOURCES_DIR, '.npmrc')

const DRY_RUN = process.argv.includes('--dry-run')

/**
 * Recreates a directory, removing any previous contents.
 *
 * @param {string} directoryPath The directory to recreate.
 */
function recreateDirectory (directoryPath) {
  if (existsSync(directoryPath)) {
    rmSync(directoryPath, { recursive: true, force: true })
  }

  mkdirSync(directoryPath, { recursive: true })
}

/**
 * Compresses the contents of a directory into a zip archive.
 *
 * @param {string} sourceDirectory The directory whose contents are archived.
 * @param {string} zipPath The destination archive path.
 */
function zipDirectoryContents (sourceDirectory, zipPath) {
  mkdirSync(path.dirname(zipPath), { recursive: true })

  if (existsSync(zipPath)) {
    rmSync(zipPath, { force: true })
  }

  // bsdtar (`tar.exe`, bundled with Windows 10+/Server 2019+) writes a real zip
  // from the `.zip` extension and is dramatically faster than Compress-Archive on
  // trees with many small files (node_modules). The System32 path is used
  // explicitly so a GNU `tar` on PATH (e.g. from Git) can't shadow it. Falls back
  // to `zip` on POSIX.
  if (isWindows()) {
    const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    run(`${shellEscape(bsdtar)} -a -c -f ${shellEscape(zipPath)} .`, { cwd: sourceDirectory })

    return
  }

  run(`zip -rq ${shellEscape(zipPath)} .`, { cwd: sourceDirectory })
}

/* ---------------------------------------------------------------------------
 * Runtime dependency manifest (function apps)
 * ------------------------------------------------------------------------- */

/**
 * Resolves the package name from an import specifier.
 *
 * @param {string} specifier The import specifier.
 * @returns {string} Returns the package name.
 */
function getPackageNameFromSpecifier (specifier) {
  if (specifier.startsWith('@')) {
    const [scope, packageName] = specifier.split('/')

    return `${scope}/${packageName || ''}`
  }

  return specifier.split('/')[0]
}

/**
 * Returns whether an import specifier is a relative or absolute path.
 *
 * @param {string} specifier The import specifier.
 * @returns {boolean} Returns true when the specifier is path-like.
 */
function isPathSpecifier (specifier) {
  return (
    specifier === '.'
    || specifier === '..'
    || specifier.startsWith('./')
    || specifier.startsWith('../')
    || specifier.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(specifier)
  )
}

/**
 * Lists JavaScript runtime files recursively under a directory.
 *
 * @param {string} directoryPath The directory path.
 * @returns {string[]} Returns runtime file paths.
 */
function listRuntimeFiles (directoryPath) {
  const files = []

  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const fullPath = path.join(directoryPath, entry.name)

    if (entry.isDirectory()) {
      files.push(...listRuntimeFiles(fullPath))
      continue
    }

    if (/\.(c|m)?js$/i.test(entry.name)) {
      files.push(fullPath)
    }
  }

  return files
}

/**
 * Extracts import and require specifiers from JavaScript source.
 *
 * @param {string} sourceCode The JavaScript source.
 * @returns {string[]} Returns extracted specifiers.
 */
function extractSpecifiersFromSource (sourceCode) {
  const specifiers = new Set()
  const patterns = [
    /\bimport\s+[^'"\n]+\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+[^'"\n]+\s+from\s+['"]([^'"]+)['"]/g,
  ]

  for (const expression of patterns) {
    for (const match of sourceCode.matchAll(expression)) {
      if (match[1]) {
        specifiers.add(match[1])
      }
    }
  }

  return [...specifiers]
}

/**
 * Resolves workspace package manifests from the root workspace globs.
 *
 * @param {string[]} workspaceGlobs The root workspace glob entries.
 * @returns {Map<string, {name: string, version: string, directoryPath: string}>} Returns the workspace package map.
 */
function resolveWorkspacePackages (workspaceGlobs) {
  const workspacePackages = new Map()

  for (const workspaceGlob of workspaceGlobs) {
    if (!workspaceGlob.endsWith('/*')) {
      continue
    }

    const absoluteParent = path.join(WORKSPACE_ROOT, workspaceGlob.slice(0, -2))
    if (!existsSync(absoluteParent)) {
      continue
    }

    for (const child of readdirSync(absoluteParent, { withFileTypes: true })) {
      if (!child.isDirectory()) {
        continue
      }

      const packageDirectory = path.join(absoluteParent, child.name)
      const packagePath = path.join(packageDirectory, 'package.json')
      if (!existsSync(packagePath)) {
        continue
      }

      const packageJson = readJsonSafe(packagePath)
      if (!packageJson?.name || !packageJson?.version) {
        continue
      }

      workspacePackages.set(packageJson.name, {
        name:          packageJson.name,
        version:       packageJson.version,
        directoryPath: packageDirectory,
      })
    }
  }

  return workspacePackages
}

/**
 * Reads the optional runtime dependency allowlist for an app.
 *
 * @param {string} appRoot The app root path.
 * @returns {{externalPackages: string[], internalPackages: string[]}} Returns the allowlist.
 */
function readRuntimeAllowlist (appRoot) {
  const allowlist = readJsonSafe(path.join(appRoot, 'runtimeDependencies.json'))

  return {
    externalPackages: Array.isArray(allowlist.externalPackages) ? allowlist.externalPackages : [],
    internalPackages: Array.isArray(allowlist.internalPackages) ? allowlist.internalPackages : [],
  }
}

/**
 * Resolves the installed version of a package from the root node_modules.
 *
 * @param {string} packageName The package name.
 * @returns {string} Returns the installed version or an empty string.
 */
function resolveInstalledPackageVersion (packageName) {
  const packagePath = path.join(WORKSPACE_ROOT, 'node_modules', packageName, 'package.json')

  return String(readJsonSafe(packagePath).version || '').trim()
}

/**
 * Packs a workspace package into a vendor directory and returns the tarball.
 *
 * @param {string} packageDirectory The package directory.
 * @param {string} vendorDirectory The destination vendor directory.
 * @returns {string} Returns the produced tarball file name.
 */
function packWorkspacePackage (packageDirectory, vendorDirectory) {
  const output = run(`${NPM_BIN} pack --pack-destination ${shellEscape(vendorDirectory)}`, { cwd: packageDirectory })

  return output.split('\n').map(line => line.trim()).filter(Boolean).at(-1) || ''
}

/**
 * Generates the runtime `package.json` and vendors internal dependencies.
 *
 * @param {{appName: string, appRoot: string, distRoot: string, stageRoot: string}} input The manifest input.
 * @returns {{externalDependencies: string[], internalDependencies: string[], runtimeFilesScanned: number}} Returns the dependency report.
 */
function generateRuntimeManifest (input) {
  const { appName, appRoot, distRoot, stageRoot } = input
  const rootPackageJson = readJsonSafe(path.join(WORKSPACE_ROOT, 'package.json'))
  const appPackageJson = readJsonSafe(path.join(appRoot, 'package.json'))
  const workspacePackages = resolveWorkspacePackages(rootPackageJson.workspaces || [])
  const allowlist = readRuntimeAllowlist(appRoot)

  const externalPackages = new Set(allowlist.externalPackages)
  const internalPackages = new Set(allowlist.internalPackages)

  for (const runtimeFile of listRuntimeFiles(distRoot)) {
    for (const specifier of extractSpecifiersFromSource(readFileSync(runtimeFile, 'utf8'))) {
      if (isPathSpecifier(specifier) || BUILTIN_MODULES.has(specifier)) {
        continue
      }

      const packageName = getPackageNameFromSpecifier(specifier)
      if (!packageName) {
        continue
      }

      if (workspacePackages.has(packageName)) {
        internalPackages.add(packageName)
      } else {
        externalPackages.add(packageName)
      }
    }
  }

  const runtimeFilesScanned = listRuntimeFiles(distRoot).length
  const rootDependencies = {
    ...rootPackageJson.dependencies,
    ...rootPackageJson.optionalDependencies,
    ...rootPackageJson.devDependencies,
  }

  const externalDependencies = {}
  const missingExternal = []

  for (const packageName of [...externalPackages].sort((left, right) => left.localeCompare(right))) {
    const version = rootDependencies[packageName] || resolveInstalledPackageVersion(packageName)

    if (version) {
      externalDependencies[packageName] = version
    } else {
      missingExternal.push(packageName)
    }
  }

  if (missingExternal.length > 0) {
    throw new Error(`[${appName}] Missing versions in root dependencies or node_modules: ${missingExternal.join(', ')}`)
  }

  const internalDependencies = {}
  if (internalPackages.size > 0) {
    mkdirSync(path.join(stageRoot, 'vendor'), { recursive: true })
  }

  for (const packageName of [...internalPackages].sort((left, right) => left.localeCompare(right))) {
    const workspacePackage = workspacePackages.get(packageName)
    if (!workspacePackage) {
      throw new Error(`[${appName}] Internal dependency '${packageName}' was detected but not found in the workspace.`)
    }

    const tarballName = packWorkspacePackage(workspacePackage.directoryPath, path.join(stageRoot, 'vendor'))
    if (!tarballName) {
      throw new Error(`[${appName}] Failed to pack workspace dependency '${packageName}'.`)
    }

    internalDependencies[packageName] = `file:./vendor/${tarballName}`
  }

  writeJson(path.join(stageRoot, 'package.json'), {
    name:         appPackageJson.name,
    version:      appPackageJson.version,
    description:  appPackageJson.description,
    license:      appPackageJson.license,
    main:         appPackageJson.main,
    repository:   appPackageJson.repository,
    dependencies: { ...externalDependencies, ...internalDependencies },
    overrides:    rootPackageJson.overrides || {},
  })

  const report = {
    app:                  appName,
    runtimeFilesScanned,
    externalDependencies: Object.keys(externalDependencies),
    internalDependencies: Object.keys(internalDependencies),
  }

  writeJson(path.join(stageRoot, 'runtime-dependency-report.json'), report)
  log(`[${appName}] runtime files scanned: ${runtimeFilesScanned}`)
  log(`[${appName}] external deps (${report.externalDependencies.length}): ${report.externalDependencies.join(', ') || 'none'}`)
  log(`[${appName}] internal deps (${report.internalDependencies.length}): ${report.internalDependencies.join(', ') || 'none'}`)

  return report
}

/* ---------------------------------------------------------------------------
 * Packaging
 * ------------------------------------------------------------------------- */

/**
 * Builds, stages and zips a single Azure Function app.
 *
 * The unzipped app (incl. node_modules) is staged in `directories.stageRoot`
 * (a scratch area), and only the final zip lands in `directories.dropRoot`
 * (the published artifact folder).
 *
 * @param {Record<string, any>} project The function app project data.
 * @param {{dropRoot: string, configRoot: string, stageRoot: string}} directories The output directories.
 */
function packageFunctionApp (project, directories) {
  section(`Function app: ${project.name}`)

  runNxInherit(`run ${project.name}:build`)

  const appRoot = path.join(SOURCES_DIR, project.root)
  const distRoot = path.join(appRoot, 'dist')
  if (!existsSync(distRoot)) {
    throw new Error(`[${project.name}] dist folder not found: ${distRoot}`)
  }

  const stageRoot = path.join(directories.stageRoot, project.name)
  recreateDirectory(stageRoot)
  cpSync(distRoot, path.join(stageRoot, 'dist'), { recursive: true })

  const hostJsonPath = path.join(appRoot, 'host.json')
  if (existsSync(hostJsonPath)) {
    cpSync(hostJsonPath, path.join(stageRoot, 'host.json'))
  }

  generateRuntimeManifest({ appName: project.name, appRoot, distRoot, stageRoot })

  if (DRY_RUN) {
    warn(`[${project.name}] dry run — skipping production dependency install`)
  } else {
    runInherit(`${NPM_BIN} install --userconfig ${shellEscape(NPM_USER_CONFIG)} --prefix ${shellEscape(stageRoot)} --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline`)
  }

  const zipPath = path.join(directories.dropRoot, `${project.name}-${BUILD_ID}.zip`)
  zipDirectoryContents(stageRoot, zipPath)
  log(`[${project.name}] packaged: ${zipPath}`)
  addBuildTag(project.name)

  const scripts = readJsonSafe(path.join(appRoot, 'package.json')).scripts || {}
  if (scripts['clean:config'] && project.packageName) {
    runInherit(`${NPM_BIN} run clean:config -w ${shellEscape(project.packageName)} --userconfig ${shellEscape(NPM_USER_CONFIG)}`, { cwd: SOURCES_DIR })
  }

  const configSource = path.join(appRoot, '.configurations')
  if (existsSync(configSource)) {
    cpSync(configSource, path.join(directories.configRoot, project.name), { recursive: true })
    log(`[${project.name}] configurations staged`)
  }
}

/**
 * Builds, stages and zips a single React app.
 *
 * @param {Record<string, any>} project The React app project data.
 * @param {{artifactRoot: string}} directories The output directories.
 */
function packageReactApp (project, directories) {
  section(`React app: ${project.name}`)

  const buildCommand = project.reactBuild?.command
  if (!buildCommand) {
    throw new Error(`[${project.name}] no React build command resolved.`)
  }

  log(`[${project.name}] building with "${buildCommand}"`)
  runInherit(`${NPM_BIN} run ${buildCommand} -w ${shellEscape(project.packageName)}`, { cwd: SOURCES_DIR })

  const appRoot = path.join(SOURCES_DIR, project.root)
  const configuredDirs = Array.isArray(project.reactBuild?.distDirs) ? project.reactBuild.distDirs : []
  const existingDirs = configuredDirs.filter(distDir => existsSync(path.join(appRoot, distDir)))
  const missingDirs = configuredDirs.filter(distDir => !existsSync(path.join(appRoot, distDir)))

  if (missingDirs.length > 0) {
    warn(`[${project.name}] configured outputs not produced by "${buildCommand}": ${missingDirs.join(', ')}`)
  }

  if (existingDirs.length === 0) {
    throw new Error(`[${project.name}] no build output directories were produced (expected one of: ${configuredDirs.join(', ') || 'dist'}).`)
  }

  const packageRoot = path.join(directories.artifactRoot, project.name)
  recreateDirectory(packageRoot)

  for (const distDir of existingDirs) {
    const zipPath = path.join(packageRoot, `${distDir}-${BUILD_ID}.zip`)
    zipDirectoryContents(path.join(appRoot, distDir), zipPath)
    log(`[${project.name}] packaged ${distDir}: ${zipPath}`)
  }

  addBuildTag(project.name)
}

/**
 * Packages every affected function app and React app from the context manifest.
 */
function main () {
  banner(`[03] Package affected apps${DRY_RUN ? ' (dry run)' : ''}`)

  const context = loadContext()
  const functionApps = selectAffected(context, project => project.type.functionApp)
  const reactApps = selectAffected(context, project => project.type.reactApp)

  log(`Function apps (${functionApps.length}): ${functionApps.map(project => project.name).join(', ') || 'none'}`)
  log(`React apps (${reactApps.length}): ${reactApps.map(project => project.name).join(', ') || 'none'}`)

  if (functionApps.length === 0 && reactApps.length === 0) {
    banner('[03] No affected apps to package')
    return
  }

  const functionDirectories = {
    dropRoot:   path.join(STAGING_DIR, 'function-apps'),
    configRoot: path.join(STAGING_DIR, 'function-app-configurations'),
    stageRoot:  path.join(STAGE_AREA, 'function-apps'),
  }
  const reactDirectories = { artifactRoot: path.join(STAGING_DIR, 'react-apps') }

  if (functionApps.length > 0) {
    recreateDirectory(functionDirectories.dropRoot)
    recreateDirectory(functionDirectories.configRoot)
    recreateDirectory(functionDirectories.stageRoot)

    for (const project of functionApps) {
      packageFunctionApp(project, functionDirectories)
    }
  }

  if (reactApps.length > 0) {
    recreateDirectory(reactDirectories.artifactRoot)

    for (const project of reactApps) {
      packageReactApp(project, reactDirectories)
    }
  }

  banner(`[03] Packaging complete — ${functionApps.length} function app(s), ${reactApps.length} React app(s)`)
}

main()
