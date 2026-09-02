import {
  ACTION_PAD_FILE_NAME,
  DEFAULT_LOCAL_CONNECTION_SETTINGS,
  DEFAULT_WORKSPACE_PATH,
  actionPadPathForSettings,
  createLocalConnectionSettings,
  requireConfigDirectory,
  validateConfigDirectory,
  validateLocalConnectionSettings,
  validateWorkspacePath
} from '../local-connection-settings'

describe('local connection settings', () => {
  it('defaults to the shared-storage workspace without a selected config folder', () => {
    expect(DEFAULT_WORKSPACE_PATH).toBe('/storage/emulated/0')
    expect(DEFAULT_LOCAL_CONNECTION_SETTINGS).toEqual({
      version: 1,
      workspacePath: '/storage/emulated/0',
      configDirectory: null
    })
  })

  it('normalizes absolute workspace paths without pretending to resolve the filesystem', () => {
    expect(validateWorkspacePath('  /storage//emulated/0/./projects/  ')).toBe(
      '/storage/emulated/0/projects'
    )
    expect(createLocalConnectionSettings('/')).toEqual({
      version: 1,
      workspacePath: '/',
      configDirectory: null
    })
  })

  it('normalizes an optional absolute config folder', () => {
    expect(validateConfigDirectory(null)).toBeNull()
    expect(validateConfigDirectory('  ')).toBeNull()
    expect(validateConfigDirectory(' /storage//emulated/0/Codey/./ ')).toBe(
      '/storage/emulated/0/Codey'
    )
    expect(createLocalConnectionSettings('/work', '/storage/config')).toEqual({
      version: 1,
      workspacePath: '/work',
      configDirectory: '/storage/config'
    })
    expect(() => validateConfigDirectory('relative/config')).toThrow('absolute')
    expect(() => validateConfigDirectory('/storage/../config')).toThrow('parent-directory')
    expect(() => requireConfigDirectory(null)).toThrow('Choose a Neovim config folder')
  })

  it('rejects empty, relative, parent-traversing, and NUL-containing workspace paths', () => {
    expect(() => validateWorkspacePath('   ')).toThrow('workspace path')
    expect(() => validateWorkspacePath('storage/emulated/0')).toThrow('absolute')
    expect(() => validateWorkspacePath('/storage/../data')).toThrow('parent-directory')
    expect(() => validateWorkspacePath('/storage/\0/data')).toThrow('invalid character')
  })

  it('validates and normalizes the versioned local settings record', () => {
    expect(validateLocalConnectionSettings({
      version: 1,
      workspacePath: ' /storage/emulated/0/work/ ',
      configDirectory: ' /storage/emulated/0/config/ '
    })).toEqual({
      version: 1,
      workspacePath: '/storage/emulated/0/work',
      configDirectory: '/storage/emulated/0/config'
    })
    expect(() => validateLocalConnectionSettings({
      kind: 'remote', host: 'tablet.local', port: 7777
    })).toThrow('version')
    expect(() => validateLocalConnectionSettings(null)).toThrow('local connection settings')
  })

  it('derives the fixed Action Pad path', () => {
    const settings = createLocalConnectionSettings('/work', '/storage/config')
    expect(ACTION_PAD_FILE_NAME).toBe('action-pad.yaml')
    expect(actionPadPathForSettings(settings)).toBe('/storage/config/action-pad.yaml')
    expect(actionPadPathForSettings(createLocalConnectionSettings('/work', '/'))).toBe('/action-pad.yaml')
    expect(() => actionPadPathForSettings(createLocalConnectionSettings('/work'))).toThrow(
      'Choose a Neovim config folder'
    )
  })
})
