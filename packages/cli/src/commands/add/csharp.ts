import { join } from 'node:path'
import { runShell } from '../../nx'
import { DOTNET_SDK_VERSION } from '../../overlay'
import { promptText } from '../../prompts'
import { writeFileEnsured } from '../../util/fsx'
import { logger } from '../../util/logger'
import {
  addProjectJsonTargets,
  defaultScope,
  ensureAdmZip,
  ensurePlugin,
  registerProjectCommands,
  type AddOptions,
} from './shared'

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
 * @param identity - The project/namespace/assembly identity `dotnet new`
 * writes as `-n` — PascalCase for an app, `<PascalScope>.<PascalName>` for a
 * publishable lib (see {@link addCsharpLib}).
 * @param template - The `dotnet new` template. A bare `string`, not
 * {@link DotnetTemplate}: that type is the user-facing app choice
 * (mirroring `NodeFramework`), while a lib's template (`classlib`) is fixed
 * and internal — never something `csharp-lib` exposes a flag for.
 * @returns Nothing.
 * @throws Error when the underlying `dotnet new` exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function scaffoldDotnetProject (
  workspaceRoot: string,
  projectRoot: string,
  identity: string,
  template: string,
): void {
  if (
    runShell(
      'dotnet',
      ['new', template, '-n', identity, '-o', projectRoot, '--framework', targetFramework()],
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
  scaffoldDotnetProject(workspaceRoot, projectRoot, pascalCase(name), template)
  addProjectJsonTargets(join(workspaceRoot, projectRoot, 'project.json'), {
    package: csharpAppPackageTarget('csharp-app', projectRoot, name),
    start:   csharpAppStartTarget(projectRoot),
  })
  registerProjectCommands(workspaceRoot, name, { build: true, start: `nx run ${name}:start` })
}

/**
 * Converts a workspace scope (`@demo`, `@my-org`) to the PascalCase prefix a
 * NuGet `PackageId` conventionally uses (`Demo`, `MyOrg`).
 *
 * @remarks
 * NuGet has no `@scope/name` convention the way npm does — package IDs are
 * flat, dot-separated strings (`Company.Product`), so the workspace scope is
 * folded into the project's own identity at `dotnet new` time
 * (`<PascalScope>.<PascalName>`) rather than written into any manifest field
 * afterwards. `dotnet new classlib -n Demo.Sdk` sets the assembly name, the
 * root namespace AND the default `PackageId` all in one step, which is also
 * why {@link addCsharpLib} needs no post-generation manifest repair the way
 * `npm-lib` does — there is no separate "importPath" field to get wrong.
 *
 * @param scope - The workspace scope, e.g. `@demo`.
 * @returns The PascalCase prefix, e.g. `Demo`.
 * @throws Never - pure string transformation.
 * @typeParam None - this function has no generic type parameters.
 */
function pascalScope (scope: string): string {
  return pascalCase(scope.replace(/^@/, ''))
}

/**
 * Adds a publishable C# library under `packages/`: `dotnet new classlib`.
 *
 * @remarks
 * The scope is resolved exactly the way `addNpmLib` resolves it: an explicit
 * `--scope` wins; otherwise the flag path (`kindProvided`) defaults it
 * silently, while the interactive/bare path prompts for it (with the
 * workspace's own scope as the default) — one shared UX across every
 * publishable-lib kind, not a C#-specific decision.
 *
 * No `package`/zip target, unlike {@link addCsharpApp}: a publishable lib's
 * distribution path is `nx release` (NuGet publish), the same as
 * `npm-lib`/`python-lib`, never the `dist/drop` zip convention that exists
 * for apps. `@nx/dotnet` already infers a `pack` target from the `.csproj`
 * alone, so there is nothing extra to wire here — see the `nx release`
 * integration this still needs (tracked separately, since a `.csproj` lib
 * has no `package.json` for Nx's default `versionActions` to read, the same
 * failure mode already fixed for `go-lib`).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param options - The CLI flags.
 * @param kindProvided - Whether `kind` was passed as a flag (vs. prompted) —
 * gates whether the scope is prompted for or silently defaulted.
 * @returns A promise that resolves when the scaffold has finished.
 * @throws Error when the SDK is missing, or the plugin install/scaffold fails.
 * @typeParam None - this function has no generic type parameters.
 */
export async function addCsharpLib (
  workspaceRoot: string,
  name: string,
  options: AddOptions,
  kindProvided: boolean,
): Promise<void> {
  ensureDotnet(workspaceRoot)
  ensurePlugin(workspaceRoot, '@nx/dotnet')

  const scope =
    options.scope ??
    (kindProvided
      ? defaultScope(workspaceRoot)
      : await promptText('NuGet package scope for the published library', defaultScope(workspaceRoot)))

  const projectRoot = `packages/${name}`
  scaffoldDotnetProject(
    workspaceRoot,
    projectRoot,
    `${pascalScope(scope)}.${pascalCase(name)}`,
    'classlib',
  )
  registerProjectCommands(workspaceRoot, name, { build: true })
}

/**
 * Adds an internal (never-published) C# library under `libs/`.
 *
 * @remarks
 * No scope prefix, unlike {@link addCsharpLib}: a `PackageId` only means
 * anything for something that gets published, and this never does — the
 * same reasoning `internal-lib`'s plain `@nx/js:lib --bundler=tsc` needs no
 * `--importPath` either. `build: false` in the `registerProjectCommands`
 * call for the same reason: consistent with `go-internal-lib`, an
 * internal-only library gets no root `<name>:build` script of its own.
 *
 * **Consuming it is a manual step, deliberately not automated here.**
 * `mnci add`'s own signature has no "consumer" argument for this kind (that
 * is `python-vendor`'s narrower job, wiring one named consumer at a time) —
 * every other internal-lib kind resolves automatically once generated
 * (TS via `node_modules` symlinks, Go via one shared module, Dart via the
 * pub workspace's plain version constraint), but C#'s `<ProjectReference>`
 * has no such implicit resolution: it is an explicit edit to the consuming
 * `.csproj`, which `dotnet add <consumer> reference <lib>` makes in one
 * command. The step is named for the user rather than skipped silently, the
 * same courtesy {@link addGoInternalLib}'s `goModulePath` message already
 * extends for Go's import path.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when the SDK is missing, or the plugin install/scaffold fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addCsharpInternalLib (workspaceRoot: string, name: string): void {
  ensureDotnet(workspaceRoot)
  ensurePlugin(workspaceRoot, '@nx/dotnet')

  const projectRoot = `libs/${name}`
  const identity = pascalCase(name)
  scaffoldDotnetProject(workspaceRoot, projectRoot, identity, 'classlib')
  registerProjectCommands(workspaceRoot, name, { build: false })
  logger.step(
    `Reference it from a consumer with: dotnet add <consumer>.csproj reference ${projectRoot}/${identity}.csproj`,
  )
}

/**
 * The `host.json` every generated Azure Functions app writes, C# included.
 *
 * @remarks
 * Identical to `NODE_FUNCTION_APP_HOST_JSON` — the extension bundle format is
 * the Functions runtime schema, not a language concern — duplicated rather
 * than imported across a `node.ts`/`csharp.ts` boundary that would otherwise
 * read as one language depending on another's internals for something
 * neither actually owns.
 */
const CSHARP_FUNCTION_APP_HOST_JSON = `{
  "version": "2.0",
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[4.*, 5.0.0)"
  }
}
`

/**
 * The isolated-worker `.csproj`, overwriting whatever the base `console`
 * scaffold wrote.
 *
 * @remarks
 * `dotnet new` ships no Azure Functions template of its own — verified
 * against Microsoft's own current (2026) isolated-worker guide, not assumed:
 * a Functions app is an ordinary console app whose project file opts into
 * the `Azure.Functions.Sdk` MSBuild project SDK, the same "scaffold the base
 * shape, then overlay the Functions-specific files" split every other
 * `*-function-app` kind already uses (see `addNodeFunctionApp`).
 *
 * `Azure.Functions.Sdk` is the CURRENT recommended project shape (superseding
 * the older explicit `Microsoft.Azure.Functions.Worker.Sdk` package
 * reference plus hand-set `AzureFunctionsVersion`/`OutputType` properties):
 * it auto-configures both, is shorter, and is what Microsoft's own migration
 * guide moves existing projects TO — so new projects should start there
 * rather than at the thing that guide migrates away from.
 *
 * **Unverified without a real SDK — the same caveat as
 * {@link csharpAppPackageTarget}.** The package versions below are current
 * as measured against Microsoft's own docs at the time this was written; a
 * real `dotnet restore` is what the gated e2e (task tracked separately)
 * exists to confirm once it can run against a live SDK.
 *
 * @returns The `.csproj` XML content.
 * @throws Never - pure string formatting.
 * @typeParam None - this function has no generic type parameters.
 */
function csharpFunctionAppCsproj (): string {
  return `<Project Sdk="Azure.Functions.Sdk/1.0.0">
  <PropertyGroup>
    <TargetFramework>${targetFramework()}</TargetFramework>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.Azure.Functions.Worker" Version="2.52.0" />
    <PackageReference Include="Microsoft.Azure.Functions.Worker.Extensions.Http.AspNetCore" Version="2.1.0" />
  </ItemGroup>
</Project>
`
}

/**
 * The isolated-worker `Program.cs`, overwriting the base scaffold's `Main`.
 *
 * @remarks
 * `FunctionsApplication.CreateBuilder` + `ConfigureFunctionsWebApplication`
 * is the current `IHostApplicationBuilder` pattern (requires the 2.x worker
 * package, which {@link csharpFunctionAppCsproj} pins) — the ASP.NET Core
 * integration that lets a trigger use the ordinary `HttpRequest`/
 * `IActionResult` types in {@link csharpFunctionAppHello} rather than the
 * isolated-worker-specific `HttpRequestData`/`HttpResponseData` pair.
 */
const CSHARP_FUNCTION_APP_PROGRAM = `using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.Hosting;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

builder.Build().Run();
`

/**
 * The HTTP-triggered sample function written into a generated C# function app.
 *
 * @remarks
 * Mirrors `NODE_FUNCTION_APP_HELLO`'s role: a minimal, real handler so the
 * generated app is runnable rather than an empty shell, using the
 * ASP.NET-Core-integrated `HttpRequest`/`IActionResult` shape ASP.NET Core
 * integration.
 *
 * @param identity - The project's PascalCase identity, used as the namespace.
 * @returns The C# source for the sample function class.
 * @throws Never - pure string formatting.
 * @typeParam None - this function has no generic type parameters.
 */
function csharpFunctionAppHello (identity: string): string {
  return `using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Functions.Worker;

namespace ${identity};

public class Hello
{
    [Function("Hello")]
    public IActionResult Run([HttpTrigger(AuthorizationLevel.Anonymous, "get")] HttpRequest req)
    {
        return new OkObjectResult("Hello from mnci.");
    }
}
`
}

/**
 * The `start` target for a C# function app: `dotnet run`, locally.
 *
 * @remarks
 * `Azure.Functions.Sdk` wires `dotnet run` to start the Functions host
 * directly when Azure Functions Core Tools (`func`) is installed — the same
 * assumption `nodeFunctionAppStartTarget`'s `func start` already makes, just
 * invoked through `dotnet` rather than `func` itself, since that is what
 * the project's own tooling now integrates with.
 *
 * @param projectRoot - Workspace-relative project directory.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function csharpFunctionAppStartTarget (projectRoot: string): Record<string, unknown> {
  return {
    executor:   'nx:run-commands',
    continuous: true,
    options:    { command: 'dotnet run', cwd: projectRoot },
  }
}

/**
 * Adds a C# Azure Function app: an isolated-worker overlay on the base
 * console scaffold.
 *
 * @remarks
 * Structurally the same split as `addNodeFunctionApp`/`addPythonFunctionApp`:
 * scaffold the plain app, then overwrite/add exactly the files a Functions
 * app needs (`.csproj`, `Program.cs`, one sample HTTP trigger, `host.json`).
 * No scope/`PackageId` concept, unlike {@link addCsharpLib} — a function app
 * is never NuGet-published, matching every other `*-function-app` kind.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when the SDK is missing, or the plugin install/scaffold fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addCsharpFunctionApp (workspaceRoot: string, name: string): void {
  ensureDotnet(workspaceRoot)
  ensurePlugin(workspaceRoot, '@nx/dotnet')
  ensureAdmZip(workspaceRoot)

  const projectRoot = `apps/${name}`
  const identity = pascalCase(name)
  scaffoldDotnetProject(workspaceRoot, projectRoot, identity, 'console')

  const absoluteRoot = join(workspaceRoot, projectRoot)
  writeFileEnsured(join(absoluteRoot, `${identity}.csproj`), csharpFunctionAppCsproj())
  writeFileEnsured(join(absoluteRoot, 'Program.cs'), CSHARP_FUNCTION_APP_PROGRAM)
  writeFileEnsured(join(absoluteRoot, 'Hello.cs'), csharpFunctionAppHello(identity))
  writeFileEnsured(join(absoluteRoot, 'host.json'), CSHARP_FUNCTION_APP_HOST_JSON)

  addProjectJsonTargets(join(absoluteRoot, 'project.json'), {
    package: csharpAppPackageTarget('csharp-function-app', projectRoot, name),
    start:   csharpFunctionAppStartTarget(projectRoot),
  })
  registerProjectCommands(workspaceRoot, name, { build: true, start: `nx run ${name}:start` })
}
