# Releasing publishable libraries & CLI tools

This monorepo uses **`nx release`** with **independent** versioning driven by
**Conventional Commits**. Only projects tagged `type:publishable-lib` (libraries
and CLI tools) are released; internal libs and apps are never published.

## How versions are decided (auto-bump)

You do **not** hand-edit `version` in any `package.json`. `nx release` reads the
Conventional Commit messages since each project's last release tag and bumps:

| Commit type            | Bump   |
| ---------------------- | ------ |
| `fix: …`               | patch  |
| `feat: …`              | minor  |
| `feat!: …` / `BREAKING CHANGE` | major |

Commit messages are enforced by commitlint (`commitlint.config.mjs`) via a husky
`commit-msg` hook, so the history stays releasable. Scope a commit to a project
with `fix(my-lib): …`.

## Local commands

```sh
npm run release            # interactive: version + changelog + (optional) publish
npm run release:version    # bump versions + write changelogs from commits
npm run release:publish    # publish what changed to the configured registry
npx nx release --dry-run   # preview everything, change nothing
```

## What gets published

`build` emits `dist/` and runs `tools/generate-dist-package.mjs`, which writes a
correct `dist/package.json`: it resolves real dependency versions from the **root**
package.json (all deps live there) and from internal workspace packages. This is
why published packages declare their dependencies even though project
`package.json` files keep `dependencies: {}`. Publishing runs `npm publish ./dist`.

## First release

For a project that has never been released, set its starting version once:

```sh
npx nx release version 1.0.0 --projects=my-lib --first-release
```

## CI

On `main` (non-PR builds), CI runs `nx release version --yes`
then publishes affected publishable projects to the public npm registry. See the publish
step (`04-publish-libs`, or the GitHub Actions `publish` job).
