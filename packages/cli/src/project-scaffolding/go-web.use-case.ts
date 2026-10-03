import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileExists, readJson, toJson, writeFileEnsured } from '../file-system'
import { logger } from '../terminal'

/**
 * The targets of a Go app that compile Go, and so need the embedded frontend to exist.
 *
 * @remarks
 * `//go:embed` fails at compile time when its files are missing, so on a fresh checkout
 * `go vet`, `go test` and `golangci-lint` of the package fail as well as `go build`.
 * A committed placeholder cannot fix that: the staging step replaces the directory, and
 * git would then show the placeholder as modified for ever. So every one of these
 * depends on `stage-web` instead, which Nx caches, so it does work only when the React
 * code changed. `package`, `package-all` and `package-native` are not listed because
 * they already depend on a target that is.
 */
const TARGETS_NEEDING_THE_FRONTEND = ['build', 'test', 'lint', 'start', 'build-all', 'build-native'] as const

/** The address the generated server listens on, and the one Vite proxies `/api` to in development. */
const DEFAULT_ADDRESS = '127.0.0.1:8080'

/** The slice of a `project.json` this module reads and writes. */
interface WebWiredProject {
  implicitDependencies?: string[]
  targets?:              Record<string, { dependsOn?: unknown[] } & Record<string, unknown>>
}

/**
 * The Go source that embeds the staged frontend and serves it.
 *
 * @remarks
 * `all:` so a file whose name starts with `.` or `_` is embedded too (a bundler can emit
 * one). An unknown path falls back to `index.html`, so a client-side route survives a
 * reload. `fs.Sub` roots the files at the frontend, not at `web/`.
 */
export const GO_WEB_SOURCE = `package main

import (
\t"embed"
\t"io/fs"
\t"net/http"
\t"path"
)

// The built frontend. The stage-web target copies it into web/ before Go compiles.
//
//go:embed all:web
var webFiles embed.FS

// webHandler serves the built frontend. A path that is not a file falls back to
// index.html, so a client-side route survives a reload.
func webHandler() http.Handler {
\troot, err := fs.Sub(webFiles, "web")
\tif err != nil {
\t\tpanic(err)
\t}
\tfiles := http.FileServer(http.FS(root))

\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\tname := path.Clean(r.URL.Path)[1:]
\t\tif name != "" {
\t\t\tif _, err := fs.Stat(root, name); err != nil {
\t\t\t\tr.URL.Path = "/"
\t\t\t}
\t\t}
\t\tfiles.ServeHTTP(w, r)
\t})
}
`

/**
 * The `main.go` of an app that serves its frontend.
 *
 * @remarks
 * `version` is what `build-all` stamps with `-X main.version`, so it is declared here,
 * and logged so it is used (the `unused` linter rejects a variable nothing reads).
 */
export const GO_WEB_MAIN = `package main

import (
\t"log"
\t"net/http"
\t"os"
)

var version = "dev"

func main() {
\taddress := os.Getenv("ADDR")
\tif address == "" {
\t\taddress = "${DEFAULT_ADDRESS}"
\t}
\tmux := http.NewServeMux()
\tmux.Handle("/", webHandler())
\tlog.Printf("%s serving on http://%s", version, address)
\tlog.Fatal(http.ListenAndServe(address, mux))
}
`

/** The test of an app that serves its frontend: the embed holds a page, for a file and for a route. */
export const GO_WEB_MAIN_TEST = `package main

import (
\t"net/http"
\t"net/http/httptest"
\t"strings"
\t"testing"
)

func TestWebHandlerServesTheBuiltFrontend(t *testing.T) {
\tfor _, target := range []string{"/", "/a/client/side/route"} {
\t\trecorder := httptest.NewRecorder()
\t\twebHandler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
\t\tif recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "<html") {
\t\t\tt.Fatalf("GET %s: %d %q", target, recorder.Code, recorder.Body.String())
\t\t}
\t}
}
`

/**
 * Checks that `apps/<web>` is a React app, before anything is generated.
 *
 * @remarks
 * A React app is the only kind with a `vite.config.*`, so that file is what identifies it.
 * The error says how to create one, because the usual cause is the order of the commands.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param web - The directory name of the React app, under `apps/`.
 * @returns Nothing.
 * @throws Error when `apps/<web>` is missing or is not a React app.
 * @typeParam None - this function has no generic type parameters.
 */
export function assertWebApp (workspaceRoot: string, web: string): void {
  const directory = join(workspaceRoot, 'apps', web)
  const isReactApp = fileExists(join(directory, 'package.json')) &&
    readdirSync(directory).some(entry => entry.startsWith('vite.config.'))
  if (!isReactApp) {
    throw new Error(`--web ${web}: no React app at apps/${web}. Add it first with \`mnci add react-app ${web}\`.`)
  }
}

/**
 * The Nx project name of a React app.
 *
 * @remarks
 * Not the directory name: the workspace is a TypeScript solution, so a package is named
 * `@scope/name`, and `dependsOn` and `implicitDependencies` match on the real name.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param web - The directory name of the React app, under `apps/`.
 * @returns The name Nx knows the project by.
 * @throws Error when the app's `package.json` is not valid JSON.
 * @typeParam None - this function has no generic type parameters.
 */
export function webProjectName (workspaceRoot: string, web: string): string {
  const manifest = readJson<{ name?: string; nx?: { name?: string } }>(join(workspaceRoot, 'apps', web, 'package.json'))

  return manifest.nx?.name ?? manifest.name ?? web
}

/**
 * Adds a `/api` proxy to a Vite config's `server` block, so the dev server reaches the Go server.
 *
 * @remarks
 * A string edit of a generated file, so it is conservative: it does nothing when the
 * config already mentions `/api` or has no `server: {` block to put it in, and the
 * caller says so rather than guessing.
 *
 * @param viteConfigPath - Absolute path to the app's Vite config.
 * @returns Whether the file changed.
 * @throws Propagates any `fs` error reading or writing the file.
 * @typeParam None - this function has no generic type parameters.
 */
function addApiProxy (viteConfigPath: string): boolean {
  const source = readFileSync(viteConfigPath, 'utf8')
  if (source.includes("'/api'") || source.includes('"/api"')) {
    return false
  }
  const patched = source.replace(/server:\s*\{/, serverBlock => `${serverBlock}\n    proxy: { '/api': 'http://${DEFAULT_ADDRESS}' },`)
  if (patched === source) {
    return false
  }
  writeFileEnsured(viteConfigPath, patched)

  return true
}

/**
 * Wires a Go app to the React app it embeds and serves.
 *
 * @remarks
 * - **`stage-web`** copies the React app's `dist` into the git-ignored `apps/<name>/web/`,
 *   after that app's `build`, so `//go:embed` can reach it (an embed pattern cannot leave
 *   its package directory). Its output is declared and its inputs are the React build's
 *   outputs, so Nx caches it and a change to the React code reaches the binary.
 * - **Every target that compiles Go depends on it**, see {@link TARGETS_NEEDING_THE_FRONTEND}.
 * - **`implicitDependencies`** makes the React app a dependency in the project graph, so a
 *   change to it marks the Go app affected, while a change to the Go app does not rebuild it.
 * - **`dev`** runs the Vite dev server and the Go server together, with the `/api` proxy
 *   added to the Vite config.
 * - The app's `main.go` is replaced by a small server (the generated one is a hello world),
 *   with `web.go` and a test that the embed holds a page.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The Go app's project name.
 * @param web - The directory name of the React app, under `apps/`.
 * @returns Nothing.
 * @throws Error when the Go app's `project.json` is missing or not valid JSON.
 * @typeParam None - this function has no generic type parameters.
 */
export function wireGoAppToWeb (workspaceRoot: string, name: string, web: string): void {
  const projectJsonPath = join(workspaceRoot, 'apps', name, 'project.json')
  const project = readJson<WebWiredProject>(projectJsonPath)
  const webName = webProjectName(workspaceRoot, web)
  const targets = project.targets ?? {}
  for (const target of TARGETS_NEEDING_THE_FRONTEND) {
    if (targets[target] !== undefined) {
      targets[target].dependsOn = [...new Set([...(targets[target].dependsOn ?? []), 'stage-web'])]
    }
  }
  targets['stage-web'] = {
    executor:  'nx:run-commands',
    dependsOn: [{ projects: [webName], target: 'build' }],
    inputs:    [{ dependentTasksOutputFiles: '**/*' }],
    outputs:   [`{workspaceRoot}/apps/${name}/web`],
    options:   {
      command: `node -e "const fs=require('node:fs');fs.rmSync('apps/${name}/web',{recursive:true,force:true});fs.cpSync('apps/${web}/dist','apps/${name}/web',{recursive:true})"`,
    },
  }
  targets.dev = {
    executor: 'nx:run-commands',
    options:  { commands: [`nx run ${webName}:serve`, `nx run ${name}:start`], parallel: true },
  }
  writeFileEnsured(
    projectJsonPath,
    toJson({ ...project, implicitDependencies: [...new Set([...(project.implicitDependencies ?? []), webName])], targets }),
  )
  const directory = join(workspaceRoot, 'apps', name)
  writeFileEnsured(join(directory, '.gitignore'), '/web/\n')
  writeFileEnsured(join(directory, 'web.go'), GO_WEB_SOURCE)
  writeFileEnsured(join(directory, 'main.go'), GO_WEB_MAIN)
  writeFileEnsured(join(directory, 'main_test.go'), GO_WEB_MAIN_TEST)

  const viteConfig = readdirSync(join(workspaceRoot, 'apps', web)).find(entry => entry.startsWith('vite.config.'))
  if (viteConfig === undefined || !addApiProxy(join(workspaceRoot, 'apps', web, viteConfig))) {
    logger.warn(
      `Could not add the /api proxy to apps/${web}'s Vite config: add \`server: { proxy: { '/api': 'http://${DEFAULT_ADDRESS}' } }\` yourself, so \`nx run ${name}:dev\` reaches the Go server.`,
    )
  }
}
