import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  devcontainerJson,
  LAUNCH_CONFIG_PREFIX,
  LAUNCH_CONFIGURATIONS,
  RETIRED_FORMATTER_FILES,
  VSCODE_RECOMMENDED_EXTENSIONS
} from './overlay'

/**
 * This repo is generated and maintained by the CLI it ships, so every invariant
 * `mnci doctor` enforces in a generated workspace should hold here too.
 *
 * Nothing checked that, and the gap was not hypothetical. When ESLint took over
 * formatting, `prettier` was pruned from generated workspaces, pruned from
 * `@mnci/eslint-config`, added to `mnci doctor`'s retired list — and left
 * declared in THIS manifest, where it sat as the only remaining dependency on
 * prettier anywhere in the tree. Every gate agreed, because every gate was
 * pointed at the workspaces mnci produces rather than at mnci.
 *
 * The tests below are deliberately about the repo on disk, not about a fixture.
 */

const WORKSPACE_ROOT = join(__dirname, '..', '..', '..')

/**
 * Reads this repo's own root manifest.
 *
 * @returns The parsed root `package.json`.
 * @throws Propagates any Node.js `fs` error raised while reading.
 * @typeParam None - this function has no generic type parameters.
 */
function rootManifest (): {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
} {
  return JSON.parse(readFileSync(join(WORKSPACE_ROOT, 'package.json'), 'utf8')) as ReturnType<
    typeof rootManifest
  >
}

// The same list `mnci doctor`'s `checkNoRetiredFormatter` refuses to find in a
// generated workspace. Duplicated as a literal ON PURPOSE: importing doctor's
// copy would make this test agree with it by construction, so a mistake in that
// list would silently exempt this repo as well.
const RETIRED_FORMATTER_PACKAGES = [
  'prettier',
  'eslint-config-prettier',
  'oxlint',
  'oxfmt',
  '@mnci/oxlint-config'
]

describe('mnci holds itself to the invariants it enforces elsewhere', () => {
  it('carries the devcontainer it generates for everyone else', () => {
    // It did not, for as long as the devcontainer existed. Every generated
    // workspace got a toolchain matching CI while the repo that writes it had
    // none — the same shape as the prettier gap above: the gate pointed at what
    // mnci produces rather than at mnci.
    const path = join(WORKSPACE_ROOT, '.devcontainer/devcontainer.json')
    expect(existsSync(path)).toBe(true)

    const generated = JSON.parse(devcontainerJson('MoNecromanCi')) as { image: string }
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { image: string }
    expect(onDisk.image).toBe(generated.image)
  })

  it('carries the launch configs it generates, so Run and Debug is not empty here either', () => {
    const workspace = JSON.parse(
      readFileSync(join(WORKSPACE_ROOT, 'MoNecromanCi.code-workspace'), 'utf8')
    ) as { launch?: { configurations: { name: string }[] } }

    const names = (workspace.launch?.configurations ?? []).map((entry) => entry.name)
    for (const target of LAUNCH_CONFIGURATIONS) {
      expect(names).toContain(`${LAUNCH_CONFIG_PREFIX}${target}`)
    }
  })

  it('lints itself through the shared config rather than a hand-maintained copy', () => {
    // The whole reason @mnci/eslint-config exists: this repo had drifted to a rich
    // root config while overlay.ts shipped Nx's bare default, so every generated
    // workspace got the worse one and dogfooding hid it. The spread is what makes
    // that drift impossible to reintroduce.
    //
    // Extras layered ON TOP are fine and deliberate (repo-only ignores, TSDoc
    // enforcement); what must never happen is this file ceasing to be the shared
    // config plus extras.
    const config = readFileSync(join(WORKSPACE_ROOT, 'eslint.config.mjs'), 'utf8')

    expect(config).toContain("from '@mnci/eslint-config'")
    expect(config).toContain('...mnci(')
  })

  it('declares no retired formatter in its own root manifest', () => {
    const { dependencies = {}, devDependencies = {} } = rootManifest()
    const declared = RETIRED_FORMATTER_PACKAGES.filter(
      name => dependencies[name] !== undefined || devDependencies[name] !== undefined
    )

    // A declaration is enough on its own to do harm — the binary need never be
    // invoked. `esbenp.prettier-vscode` resolves prettier from the PROJECT's
    // dependencies, so declaring it is precisely what lets an editor reformat
    // on save against an opinion no gate checks.
    expect(declared).toEqual([])
  })

  it('keeps no retired formatter config file on disk', () => {
    const present = RETIRED_FORMATTER_FILES.filter(file =>
      existsSync(join(WORKSPACE_ROOT, file))
    )

    // `applyOverlay` deletes each of these from a generated workspace. This repo
    // predates that cleanup, so it has to be checked rather than assumed.
    expect(present).toEqual([])
  })

  it('recommends no formatter extension from the shared constant', () => {
    // UNCONDITIONAL, and that is the whole point of it being its own test. The
    // first version of this guard asserted the constant *after* an early return
    // for a `.code-workspace` file this repo does not have, so the assertion
    // never ran — re-adding `esbenp.prettier-vscode` left it green. Caught by
    // mutation-testing the guard rather than by reading it, which is the only
    // thing that catches this class.
    for (const extension of ['esbenp.prettier-vscode', 'oxc.oxc-vscode']) {
      expect([...VSCODE_RECOMMENDED_EXTENSIONS]).not.toContain(extension)
    }
  })

  it('recommends no formatter extension in any .code-workspace on disk', () => {
    // The constant above feeds every workspace mnci GENERATES. A checked-in
    // `.code-workspace` is written once and then edited by hand, so it is free
    // to drift from it.
    const files = readdirSync(WORKSPACE_ROOT).filter(name => name.endsWith('.code-workspace'))
    for (const file of files) {
      const contents = readFileSync(join(WORKSPACE_ROOT, file), 'utf8')
      for (const extension of ['esbenp.prettier-vscode', 'oxc.oxc-vscode']) {
        expect(`${file}: ${contents}`).not.toContain(extension)
      }
    }
  })

  it('runs no formatter step in its own root scripts', () => {
    const { scripts = {} } = rootManifest()

    // `format:check` is gone because `lint` reports formatting itself. A second
    // script would run the same binary twice over the same tree — and if it ran
    // a DIFFERENT binary, that binary would be the one nothing else agrees with.
    expect(scripts['format:check']).toBeUndefined()
    expect(scripts.format).toBe('eslint . --fix --cache')
    for (const [name, command] of Object.entries(scripts)) {
      expect(`${name}=${command}`).not.toMatch(/\b(prettier|oxfmt|oxlint)\b/)
    }
  })
})
