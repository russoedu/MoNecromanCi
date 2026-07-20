import { assertValidProjectName } from './names'

describe('assertValidProjectName', () => {
  it('accepts lowercase letters, digits and hyphens starting with a letter', () => {
    for (const name of ['demo', 'my-project', 'a1', 'react-app-2']) {
      expect(() => assertValidProjectName(name, 'Project name')).not.toThrow()
    }
  })

  it('rejects an empty name — the gap where an explicit empty flag bypassed promptText\'s own check', () => {
    expect(() => assertValidProjectName('', 'Project name')).toThrow('Project name \'\' is invalid')
  })

  it('rejects a name starting with a digit (would be an invalid Python module identifier)', () => {
    expect(() => assertValidProjectName('3d-tools', 'Project name')).toThrow('Project name')
  })

  it('rejects path-traversal / path-separator input', () => {
    for (const name of ['../etc', 'a/b', '/absolute', '.']) {
      expect(() => assertValidProjectName(name, 'Project name')).toThrow('Project name')
    }
  })

  it('rejects shell metacharacters (defense in depth alongside the cross-spawn fix)', () => {
    for (const name of ['x; touch pwned', 'a`b`', '$(whoami)', 'name with spaces']) {
      expect(() => assertValidProjectName(name, 'Project name')).toThrow('Project name')
    }
  })

  it('rejects uppercase (npm scope/package-name and Python-identifier conventions are lowercase)', () => {
    expect(() => assertValidProjectName('MyProject', 'Project name')).toThrow('Project name')
  })

  it('includes the offending label and value in the error message', () => {
    expect(() => assertValidProjectName('Bad Name', 'Workspace name')).toThrow('Workspace name \'Bad Name\' is invalid')
  })
})
