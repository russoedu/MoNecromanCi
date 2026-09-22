/**
 * Everything a rollup-bundled library needs repaired before it builds, types and publishes correctly.
 *
 * @remarks
 * The deliberate public API of this slice: a sibling reaches it only
 * through this barrel, never by a path into the files below.
 *
 * It owns the concept rather than any one consumer: `project-scaffolding`
 * applies these repairs as it generates a library, `workspace-upgrade` applies
 * them across an existing workspace, and `workspace-diagnostics` reads the same
 * predicates to report what is missing. Before this slice existed, the two
 * latter reached into `project-scaffolding` for logic that was never part of
 * scaffolding's outcome.
 */

// The repairs themselves.
export { repairPublishableManifest, repairPublishableManifests } from './repair-publishable-manifest.use-case'
export {
  repairDeclarationSpecifiers,
  repairRollupSourceMaps,
  upgradeDeclarationSpecifierPlugins,
} from './repair-rollup-config.use-case'

// Building blocks: the read and the pure predicates behind those repairs, which
// `mnci doctor` needs in order to report without changing anything.
export { resolveRollupConfigText } from './rollup-config.repository'
export {
  canRepairRollupConfig,
  hasDeclarationSpecifierPlugin,
  hasDirectoryAwareDeclarationSpecifiers,
  hasRollupSourceMaps,
} from './rollup-config.algorithm'
