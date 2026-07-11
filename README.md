<p align="center">
  <img src="libs/monecromanci/logo.svg" alt="MoNecromanCI logo" width="160">
</p>

# MoNecromanCI

<p align="center">
  <a href="https://www.npmjs.com/package/monecromanci"><img src="https://img.shields.io/npm/v/monecromanci.svg" alt="npm version"></a>
  <a href="https://github.com/russoedu/MoNecromanCi/actions/workflows/ci.yml"><img src="https://github.com/russoedu/MoNecromanCi/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/russoedu/MoNecromanCi/actions/workflows/ci.yml"><img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/russoedu/MoNecromanCi/badges/.github/badges/coverage.json" alt="coverage"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/monecromanci.svg" alt="license"></a>
</p>

> **MO**no(repo) + **NECROMAN**cy + **CI**. An interactive CLI that summons,
> conjures, raises and validates NX monorepos — Node + TypeScript, Jest,
> ESLint, real VSCode `.ts` debugging, and a complete CI pipeline (Azure DevOps
> **and/or** GitHub Actions), with near-zero per-project configuration.

This repository is both the tool's source (`libs/monecromanci`) and, being
dogfooded, a monorepo *managed by* the tool it builds.

For the full feature tour — the nine project kinds and their Nx tags, every
CLI command, `resurrect`-ing an existing repo, CI/registry options, and how
commit-message-driven releases work — see
**[`libs/monecromanci/README.md`](libs/monecromanci/README.md)**. Release
mechanics specifically (versioning, tagging, first publish, CI auth) are in
[`docs/nx-release.md`](docs/nx-release.md).

## Common commands

```sh
npm run build          # build all projects
npm run test           # run all tests
npm run lint           # lint everything
npm run affected       # lint + test + build only what changed
npm run graph          # open the project graph
```

```sh
npx monecromanci validate   # (ritual)   nx affected -t lint test build, before pushing
npx monecromanci spell      # (scry)     changed projects + a ready-made commit scope
npx monecromanci release    # (foretell) preview the next automated release — no changes made
```

## Debugging

Open `MoNecromanCI Monorepo.code-workspace` in VSCode. Use the **Run and Debug** panel:
breakpoints work in `.ts` test files (and step into internal libs). The
`Orta.vscode-jest` extension also adds a **Debug** lens above each test.

## Adding projects

```sh
npx monecromanci add    # (alias: conjure) function-app | node-app | react-app | vue-app | svelte-app | nextjs-app | internal-lib | publishable-lib | cli-tool
```
