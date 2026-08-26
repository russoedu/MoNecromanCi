/**
 * Gives every config block a `name`, including the ones that come from an
 * upstream preset.
 *
 * @remarks
 * ESLint 9 added `name` and the config inspector (`eslint --inspect-config`)
 * reports it, so a name is how someone finds the block that turned a rule on.
 * That matters more here than in a hand-written config: an mnci workspace has
 * ONE root config which is three lines long, and the ~29 blocks behind it come
 * from a package. Without names the inspector lists them by index, and
 * "config 17" is not something anyone can act on.
 *
 * Every block this package authors sets its own `name` inline. This helper is
 * for the presets it spreads — `eslint-plugin-yml`'s `flat/recommended`,
 * `eslint-plugin-toml`'s `flat/base`, `eslint-config-prettier` — none of which
 * name their blocks, so they would otherwise be the only anonymous entries in
 * the resolved config. An upstream `name` is kept if one exists, so this stops
 * relabelling anything the day those projects add their own.
 *
 * @param prefix - Name to give the blocks, e.g. `'mnci/yaml/recommended'`.
 * A multi-block preset gets `prefix/0`, `prefix/1`, … since the blocks are
 * distinguishable only by position.
 * @param blocks - The preset's config blocks.
 * @returns The same blocks, each with a `name`.
 */
export function named (prefix, blocks) {
  return blocks.map((block, index) => ({
    ...block,
    name: block.name ?? (blocks.length === 1 ? prefix : `${prefix}/${index}`)
  }))
}
