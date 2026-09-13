export interface GitHubRepository {
  readonly url: string
  readonly name: string
}

/** Accept only a GitHub repository root; never pass arbitrary Git transports. */
export function normalizeGitHubRepository(value: string): GitHubRepository {
  const input = value.trim()
  const invalid = () => new TypeError('Enter a public GitHub repository URL or owner/repository.')
  if (/\s/.test(input) || /[\u0000-\u001f\u007f-\u009f\\?#]/.test(input)) throw invalid()
  const repositoryPath = input.replace(/^https:\/\/github\.com\//i, '')
  const match = /^([^/]+)\/([^/]+)\/?$/.exec(repositoryPath)
  if (match === null) throw invalid()
  const owner = match[1]!
  const name = match[2]!.replace(/\.git$/, '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) throw invalid()
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') throw invalid()
  return { url: `https://github.com/${owner}/${name}.git`, name }
}

export function validateCloneDirectoryName(value: string): string {
  const name = value.trim()
  if (
    name.length === 0 || name.length > 100 || name === '.' || name === '..' ||
    /[\u0000-\u001f\u007f-\u009f/\\]/.test(name) || name.startsWith('.codey-clone-')
  ) {
    throw new TypeError('Enter a folder name of up to 100 characters without slashes or control characters.')
  }
  return name
}

export function cloneDestinationPath(parentPath: string, directoryName: string): string {
  return `${parentPath.replace(/\/+$/, '')}/${directoryName}`
}
