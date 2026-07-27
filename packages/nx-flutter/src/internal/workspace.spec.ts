import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing'
import type { Tree } from '@nx/devkit'
import {
  addWorkspaceMember,
  ensureWorkspaceRoot,
  memberAnalysisOptions,
  ROOT_ANALYSIS_OPTIONS,
  ROOT_PUBSPEC,
} from './workspace'

let tree: Tree

beforeEach(() => {
  tree = createTreeWithEmptyWorkspace()
})

describe('ensureWorkspaceRoot', () => {
  it('writes the root pubspec and analyser config on a fresh workspace', () => {
    ensureWorkspaceRoot(tree, 'demo_workspace')

    const pubspec = tree.read(ROOT_PUBSPEC, 'utf8') ?? ''
    expect(pubspec).toContain('name: demo_workspace')
    expect(pubspec).toContain('publish_to: none')
    // The SDK floor is what makes pub workspaces available at all.
    expect(pubspec).toContain('sdk: ^3.6.0')
    expect(pubspec).toContain('workspace:')
    expect(tree.read(ROOT_ANALYSIS_OPTIONS, 'utf8')).toContain(
      'include: package:flutter_lints/flutter.yaml'
    )
  })

  it("preserves a user's own edits to either root file on a later add", () => {
    tree.write(ROOT_PUBSPEC, 'name: hand_written\nworkspace:\n')
    tree.write(ROOT_ANALYSIS_OPTIONS, '# my rules\n')

    ensureWorkspaceRoot(tree, 'demo_workspace')

    expect(tree.read(ROOT_PUBSPEC, 'utf8')).toBe('name: hand_written\nworkspace:\n')
    expect(tree.read(ROOT_ANALYSIS_OPTIONS, 'utf8')).toBe('# my rules\n')
  })
})

/** The `workspace:` entries currently listed in the root pubspec. */
function members(): string[] {
  const contents = tree.read(ROOT_PUBSPEC, 'utf8') ?? ''
  return contents
    .split('\n')
    .filter(line => /^\s+-\s/.test(line))
    .map(line => line.replace(/^\s*-\s*/, '').trim())
}

describe('addWorkspaceMember', () => {
  beforeEach(() => {
    ensureWorkspaceRoot(tree, 'demo_workspace')
  })

  it('registers a project so pub resolves it through the root, not standalone', () => {
    addWorkspaceMember(tree, 'apps/web')

    expect(members()).toEqual(['apps/web'])
  })

  it('keeps entries sorted as projects accumulate, so the file stays diff-friendly', () => {
    addWorkspaceMember(tree, 'packages/shared')
    addWorkspaceMember(tree, 'apps/web')
    addWorkspaceMember(tree, 'libs/core')

    expect(members()).toEqual(['apps/web', 'libs/core', 'packages/shared'])
  })

  it('is idempotent — re-adding the same project does not duplicate the entry', () => {
    addWorkspaceMember(tree, 'apps/web')
    addWorkspaceMember(tree, 'apps/web')

    expect(members()).toEqual(['apps/web'])
  })

  it('throws a diagnosable error when the root pubspec has no workspace block', () => {
    tree.write(ROOT_PUBSPEC, 'name: not_written_by_mnci\n')

    expect(() => addWorkspaceMember(tree, 'apps/web')).toThrow(/no `workspace:` block/)
  })
})

describe('memberAnalysisOptions', () => {
  it('points a two-deep project back at the root config', () => {
    expect(memberAnalysisOptions(2)).toContain('include: ../../analysis_options.yaml')
  })

  it('scales the relative path with directory depth', () => {
    expect(memberAnalysisOptions(1)).toContain('include: ../analysis_options.yaml')
    expect(memberAnalysisOptions(3)).toContain('include: ../../../analysis_options.yaml')
  })
})
