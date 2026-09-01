import {
  DEFAULT_CONNECTION_TARGET,
  DEFAULT_LOCAL_TARGET,
  DEFAULT_LOCAL_WORKSPACE_PATH,
  DEFAULT_REMOTE_TARGET,
  actionPadEndpointForTarget,
  connectionTargetLabel,
  createLocalConnectionTarget,
  createRemoteConnectionTarget,
  validateConnectionTarget,
  validateWorkspacePath
} from '../connection-target'
import { DEFAULT_ENDPOINT } from '../endpoint'

describe('connection targets', () => {
  it('defaults to a local shared-storage workspace and retains the remote default', () => {
    expect(DEFAULT_LOCAL_WORKSPACE_PATH).toBe('/storage/emulated/0')
    expect(DEFAULT_CONNECTION_TARGET).toBe(DEFAULT_LOCAL_TARGET)
    expect(DEFAULT_REMOTE_TARGET).toEqual({ kind: 'remote', ...DEFAULT_ENDPOINT })
  })

  it('normalizes absolute workspace paths without pretending to resolve the filesystem', () => {
    expect(validateWorkspacePath('  /storage//emulated/0/./projects/  ')).toBe(
      '/storage/emulated/0/projects'
    )
    expect(createLocalConnectionTarget('/')).toEqual({ kind: 'local', workspacePath: '/' })
  })

  it('rejects empty, relative, parent-traversing, and NUL-containing workspace paths', () => {
    expect(() => validateWorkspacePath('   ')).toThrow('workspace path')
    expect(() => validateWorkspacePath('storage/emulated/0')).toThrow('absolute')
    expect(() => validateWorkspacePath('/storage/../data')).toThrow('parent-directory')
    expect(() => validateWorkspacePath('/storage/\0/data')).toThrow('invalid character')
  })

  it('uses the existing endpoint validation for remote targets', () => {
    expect(createRemoteConnectionTarget(' tablet.local ', '7777')).toEqual({
      kind: 'remote',
      host: 'tablet.local',
      port: 7777
    })
    expect(() => createRemoteConnectionTarget('bad host', 7777)).toThrow('hostname')
    expect(() => createRemoteConnectionTarget('tablet.local', 0)).toThrow('Port')
    expect(() => validateConnectionTarget({ kind: 'something-else' })).toThrow(
      'connection target'
    )
  })

  it('provides user-facing labels, including an unambiguous IPv6 endpoint', () => {
    expect(connectionTargetLabel({ kind: 'local', workspacePath: '/work' })).toBe(
      'Local (/work)'
    )
    expect(connectionTargetLabel({ kind: 'remote', host: '127.0.0.1', port: 6666 })).toBe(
      'Remote (127.0.0.1:6666)'
    )
    expect(connectionTargetLabel({ kind: 'remote', host: '::1', port: 6666 })).toBe(
      'Remote ([::1]:6666)'
    )
  })

  it('keeps the local Action Pad path preference stable across workspace changes', () => {
    expect(actionPadEndpointForTarget({ kind: 'local', workspacePath: '/first' })).toEqual({
      host: '@local',
      port: 1
    })
    expect(actionPadEndpointForTarget({ kind: 'local', workspacePath: '/second' })).toEqual({
      host: '@local',
      port: 1
    })
    expect(actionPadEndpointForTarget({ kind: 'remote', host: 'remote.test', port: 7777 })).toEqual({
      host: 'remote.test',
      port: 7777
    })
  })
})
