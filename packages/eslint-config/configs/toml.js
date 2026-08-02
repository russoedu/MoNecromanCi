import toml from 'eslint-plugin-toml'
import { named } from './named.js'

/**
 * TOML — parsing only, deliberately.
 *
 * @remarks
 * `mnci` writes `pyproject.toml` for every Python project and nothing read those
 * files, so a malformed one was reported by no tool at all: `pip`/`hatchling`
 * would fail much later, during a build, with a worse message.
 *
 * **`flat/base`, not `flat/standard`, and the difference is the whole decision.**
 * `flat/standard` is almost entirely formatting — `indent`, `key-spacing`,
 * `quoted-keys`, `array-bracket-spacing`, `padding-line-between-tables` — which is
 * outside this config's scope (formatting is Prettier's job) and, measured against
 * the real thing, actively harmful: it reports **six** `toml/array-bracket-spacing`
 * errors on the `pyproject.toml` that `@mnci/nx-python-pip` itself generates. Every
 * Python workspace would have failed `npm run lint` out of the box, on a file the
 * user never wrote — the same defect shape as the `react-lib` rollup config and the
 * vitest dependency-checks bug.
 *
 * `flat/base` registers the parser and no style rules, so a syntax error becomes a
 * **fatal parse error** and everything else is left alone. That is the same trade
 * the YAML block already makes, where a duplicate key in a CI file is a hard
 * failure. Verified both directions against a real generated `pyproject.toml`
 * (clean) and a malformed one (fatal).
 *
 * Prettier has no TOML support, so nothing else was going to own these files. Note
 * this means TOML formatting is unenforced — deliberately, since the alternative
 * measured worse.
 */
export default named('mnci/toml/base', toml.configs['flat/base'])
