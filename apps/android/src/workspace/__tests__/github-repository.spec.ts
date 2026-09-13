import { cloneDestinationPath, normalizeGitHubRepository, validateCloneDirectoryName } from '../github-repository'

describe('GitHub repository input', () => {
  it.each([
    'Owner/repo',
    ' Owner/repo.git ',
    'https://github.com/Owner/repo',
    'https://github.com/Owner/repo.git/',
    'HTTPS://GITHUB.COM/Owner/repo/'
  ])('normalizes %s to the HTTPS clone URL and folder name', (input) => {
    expect(normalizeGitHubRepository(input)).toEqual({
      url: 'https://github.com/Owner/repo.git', name: 'repo'
    })
  })

  it.each([
    '', 'repo', '/Owner/repo', 'http://github.com/Owner/repo',
    'git@github.com:Owner/repo.git', 'https://gitlab.com/Owner/repo',
    'https://token@github.com/Owner/repo', 'https://github.com:443/Owner/repo',
    'https://github.com/Owner/repo?token=secret', 'https://github.com/Owner/repo#readme',
    'https://github.com/Owner/repo/tree/main', 'https://github.com/Owner/repo//',
    '-Owner/repo', 'Owner-/repo', 'Owner/..', 'Owner/...git',
    'Ow ner/repo', 'Owner/re\npo', 'Owner/repo\\name', 'Owner/repo%2fname',
    `${'o'.repeat(40)}/repo`, `Owner/${'r'.repeat(101)}`
  ])('rejects unsupported input %s', (input) => {
    expect(() => normalizeGitHubRepository(input)).toThrow('public GitHub repository')
  })

  it('keeps names with punctuation and validates the local folder independently', () => {
    expect(normalizeGitHubRepository('owner/repo_name.v2-1').name).toBe('repo_name.v2-1')
    expect(validateCloneDirectoryName('  My repository  ')).toBe('My repository')
    expect(cloneDestinationPath('/storage/emulated/0/', 'My repository')).toBe('/storage/emulated/0/My repository')
  })

  it.each(['', '.', '..', 'folder/name', 'folder\\name', 'folder\u0000name', 'folder\u0080name', '.codey-clone-staging', 'x'.repeat(101)])(
    'rejects unsafe local folder %s', (input) => {
      expect(() => validateCloneDirectoryName(input)).toThrow('folder name')
    }
  )
})
