import {
  attachDiagnosticCause,
  diagnosticOriginOf,
  markDiagnosticOrigin
} from '../origin'

describe('diagnostic origins', () => {
  it('preserves the first origin and finds it through nested causes', () => {
    const transport = new Error('native write failed')
    markDiagnosticOrigin(transport, 'transport.tcp.write')
    markDiagnosticOrigin(transport, 'rpc.client')
    const rpc = attachDiagnosticCause(new Error('RPC write failed'), transport)
    const controller = attachDiagnosticCause(new Error('Connection failed'), rpc)

    expect(diagnosticOriginOf(controller)).toBe('transport.tcp.write')
    expect(diagnosticOriginOf(transport)).toBe('transport.tcp.write')
  })

  it('handles frozen errors and cyclic cause graphs without throwing', () => {
    const frozen = Object.freeze(new Error('frozen native error'))
    expect(() => markDiagnosticOrigin(frozen, 'transport.local.open')).not.toThrow()
    expect(diagnosticOriginOf(frozen)).toBe('transport.local.open')

    const first = new Error('first')
    const second = attachDiagnosticCause(new Error('second'), first)
    attachDiagnosticCause(first, second)
    expect(diagnosticOriginOf(second)).toBeUndefined()
  })
})
