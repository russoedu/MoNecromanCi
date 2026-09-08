import { join } from 'node:path'
import { runShell } from '../../nx'
import { DOTNET_SDK_VERSION } from '../../overlay'
import { addProjectJsonTargets, ensureAdmZip, ensurePlugin, registerProjectCommands } from './shared'

/**
 * The `dotnet new` template mnci passes straight through to the .NET CLI.
 *
 * @remarks
 * Mirrors `NodeFramework`: mnci has no opinion of its own here, it is a thin
 * pass-through to the underlying tool's own template names, the same way
 * `node.ts` passes `--framework` straight to `@nx/node:application` without
 * any framework-specific logic of its own. `console` is the default — the
 * least opinionated shape, matching `node-app`'s `none` default. `webapi` is
 * ASP.NET Core's REST API template; `worker` is the long-running
 * background-service template (the .NET analogue of a Node daemon).
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type DotnetTemplate = 'console' | 'webapi' | 'worker'

/**
 * Fails fast, with an install hint, when the .NET SDK is not on the PATH.
 *
 * @remarks
 * Mirrors `ensureGo` in `add/go.ts`: probed before any scaffold or plugin
 * install so a missing toolchain surfaces as one clear sentence rather than
 * an opaque `dotnet: command not found` from deep inside a shelled-out call.
 *
 * @param workspaceRoot - Absolute path to the workspace (cwd for the probe).
 * @returns Nothing.
 * @throws Error when `dotnet` cannot be run.
 * @typeParam None - this function has no generic type parameters.
 */
function ensureDotnet (workspaceRoot: string): void {
  if (runShell('dotnet', ['--version'], workspaceRoot) !== 0) {
    throw new Error('.NET SDK not found. Install .NET 8+ first: https://dotnet.microsoft.com/download')
  }
}

/**
 * The target framework moniker `dotnet new` scaffolds every C# project
 * against, derived from {@link DOTNET_SDK_VERSION}.
 *
 * @remarks
 * Derived rather than hardcoded a second time, so bumping the SDK constant
 * reaches every newly scaffolded project for free — the same drift
 * `NODE_VERSION` already exists to prevent for Node, applied here before it
 * has the chance to happen twice.
 *
 * @returns A TFM string (e.g. `net10.0`).
 * @throws Never - pure string transformation.
 * @typeParam None - this function has no generic type parameters.
 */
function targetFramework (): string {
  const [major, minor] = DOTNET_SDK_VERSION.split('.', 2)

  return `net${major}.${minor}`
}

/**
 * Converts mnci's kebab-case project name to the PascalCase .NET convention
 * for a project/namespace/assembly identity.
 *
 * @remarks
 * The directory stays kebab-case (`apps/<name>`, matching every other kind);
 * only the `.csproj`'s own name — and the C# namespace `dotnet new` derives
 * from it — changes shape. Mirrors `pythonModuleDirectory`'s kebab-to
 * -language-convention conversion in `python.ts` (there: kebab to
 * `snake_case`; here: kebab to `PascalCase`), each language kind converting
 * to whatever its own ecosystem actually expects rather than mnci imposing
 * one casing convention workspace-wide.
 *
 * @param name - The kebab-case project name (already validated).
 * @returns The PascalCase equivalent `dotnet new` writes as `-n`.
 * @throws Never - pure string transformation.
 * @typeParam None - this function has no generic type parameters.
 */
function pascalCase (name: string): string {
  return name
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * Scaffolds a .NET project with the real `dotnet new` CLI.
 *
 * @remarks
 * `@nx/dotnet` ships no scaffolding generator at all — verified against the
 * real published package (23.2.0), not assumed from documentation: it is
 * purely a project-graph inference plugin, discovering targets from whatever
 * `.csproj` already exists on disk via a bundled MSBuild analyzer. Its own
 * README documents the workflow as `dotnet new <template> -n <Name>`, then
 * `nx build <project>` — there is no Nx generator standing in for the step
 * other kinds delegate to Nx entirely, so this shells out directly instead.
 * The same pattern `@mnci/nx-flutter`'s own generators already use
 * internally for `flutter create`, run from a `GeneratorCallback` because it
 * writes to the real filesystem rather than an Nx `Tree` — here there is no
 * Tree at all, since there is no generator wrapping the call.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param projectRoot - Workspace-relative directory (e.g. `apps/<name>`).
 * @param name - The kebab-case project name (already validated).
 * @param template - The `dotnet new` template.
 * @returns Nothing.
 * @throws Error when the underlying `dotnet new` exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function scaffoldDotnetProject (
  workspaceRoot: string,
  projectRoot: string,
  name: string,
  template: DotnetTemplate,
): void {
  if (
    runShell(
      'dotnet',
      ['new', template, '-n', pascalCase(name), '-o', projectRoot, '--framework', targetFramework()],
      workspaceRoot,
    ) !== 0
  ) {
    throw new Error(`dotnet new ${template} failed for ${projectRoot}`)
  }
}

/**
 * The `package` target for a C# app: publish, then zip, into the drop.
 *
 * @remarks
 * Deliberately runs its own `dotnet publish` rather than depending on
 * `@nx/dotnet`'s inferred `publish` target and zipping wherever it happened
 * to write. That target's exact executor and output layout are decided
 * inside the plugin's bundled MSBuild analyzer — a compiled `.dll` this
 * package cannot introspect the way it inspects the plugin's own JS, and
 * this environment has no live .NET SDK to run it against and observe. An
 * explicit, mnci-controlled output path sidesteps that uncertainty entirely
 * — the same reasoning {@link goPackageTarget} already applies by zipping a
 * fixed `dist/apps/<name>` rather than trusting `@nx-go/nx-go`'s own build
 * target to land somewhere predictable.
 *
 * **Unverified without a real SDK — the first thing to confirm once the
 * gated e2e (which skips this section entirely where `dotnet` is absent) can
 * actually run it.** If `@nx/dotnet`'s inferred `publish` target turns out
 * reliable in practice, depending on it and dropping this project's own
 * `dotnet publish` call would be the simplification to make.
 *
 * @param tag - The drop basename prefix (`csharp-app` or `csharp-function-app`).
 * @param projectRoot - Workspace-relative project directory.
 * @param name - The C# app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function csharpAppPackageTarget (
  tag: string,
  projectRoot: string,
  name: string,
): Record<string, unknown> {
  const outDir = `dist/apps/${name}`
  const zip = `dist/drop/${tag}-${name}.zip`
  const command = `node -e "const cp=require('node:child_process');const r=cp.spawnSync('dotnet',['publish','${projectRoot}','-c','Release','-o','${outDir}'],{stdio:'inherit',shell:true});if(r.status!==0)process.exit(r.status??1);const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');const z=new A();z.addLocalFolder('${outDir}');z.writeZip('${zip}')"`

  return {
    executor: 'nx:run-commands',
    outputs:  [`{workspaceRoot}/${zip}`],
    options:  { command },
  }
}

/**
 * The `start` target for a C# app: `dotnet run`, locally.
 *
 * @remarks
 * `dotnet run` builds and runs from source in one step — unlike
 * {@link csharpAppPackageTarget}'s `publish`, no separate build/`dependsOn`
 * is needed. `continuous: true` marks it as a long-running dev task, the
 * same shape every other kind's custom `start` target uses (see
 * `goStartTarget`).
 *
 * @param projectRoot - Workspace-relative project directory.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function csharpAppStartTarget (projectRoot: string): Record<string, unknown> {
  return {
    executor:   'nx:run-commands',
    continuous: true,
    options:    { command: 'dotnet run', cwd: projectRoot },
  }
}

/**
 * Adds a C# app under `apps/`, scaffolded with the real `dotnet new` CLI.
 *
 * @remarks
 * Ensures the toolchain and the `@nx/dotnet` inference plugin are present,
 * scaffolds the project directly (see {@link scaffoldDotnetProject} for why
 * there is no Nx generator to delegate to), then layers mnci's own
 * `package`/`start` targets on top via a `project.json` this call creates —
 * `@nx/dotnet` writes none, since `build`/`test`/`restore`/etc. are all
 * inferred from the `.csproj` alone.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param template - The `dotnet new` template (defaults to a bare console app,
 * mirroring `node-app`'s `none`-by-default framework choice).
 * @returns Nothing.
 * @throws Error when the SDK is missing, or the plugin install/scaffold fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addCsharpApp (
  workspaceRoot: string,
  name: string,
  template: DotnetTemplate = 'console',
): void {
  ensureDotnet(workspaceRoot)
  ensurePlugin(workspaceRoot, '@nx/dotnet')
  ensureAdmZip(workspaceRoot)

  const projectRoot = `apps/${name}`
  scaffoldDotnetProject(workspaceRoot, projectRoot, name, template)
  addProjectJsonTargets(join(workspaceRoot, projectRoot, 'project.json'), {
    package: csharpAppPackageTarget('csharp-app', projectRoot, name),
    start:   csharpAppStartTarget(projectRoot),
  })
  registerProjectCommands(workspaceRoot, name, { build: true, start: `nx run ${name}:start` })
}
