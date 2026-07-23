<p align="center">
  <img src="assets/logo.svg" alt="mnci" width="280">
</p>

# MoNecromanCI

An opinionated one-command Nx monorepo, with automatic commit-message-driven
versioning, built as a **thin CLI over what Nx already ships** — no
hand-rolled templates, shared config packages, or custom CI engines.

This repository is itself an Nx monorepo, built and managed by the CLI it
ships — `mnci new`/`mnci add` scaffolded this workspace's own root and both
of its packages.

## Packages

| Package | What it is |
| --- | --- |
| [`@mnci/cli`](packages/cli) | The CLI itself — `mnci new` (scaffold a monorepo) and `mnci add` (delegate to the matching official/community Nx generator for React apps, Node apps, Azure Function apps, npm/Python libraries). |
| [`@mnci/nx-python-pip`](packages/nx-python-pip) | An Nx plugin for pip-native Python projects (Ruff, pytest, PyPA `build`/`twine` — no uv, no Poetry) that `@mnci/cli`'s Python commands delegate to. Has no dependency on `@mnci/cli` itself; usable standalone in any Nx 21+ workspace. |

See each package's own README for the full command/generator/executor
reference.

## Common commands

```sh
npm run build          # build all projects
npm run test           # run all tests
npm run lint            # lint everything
npm run affected        # lint + test + build only what changed
npm run graph            # open the project graph
npm run release:preview  # preview the next automated release — no changes made
```

## Releasing

Versions are computed by `nx release` from **Conventional Commits** since each
package's last release tag (enforced at commit time by commitlint's husky
hook) — nothing is hand-edited. On `main`, CI runs the release automatically;
`npm run release:preview` shows what would happen without changing anything.

## License

MIT — see [LICENSE](LICENSE).
