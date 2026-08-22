export interface Endpoint {
  readonly host: string
  readonly port: number
}

export const DEFAULT_ENDPOINT: Endpoint = Object.freeze({
  host: '192.168.1.20',
  port: 6666
})

export function validateEndpoint(hostValue: string, portValue: string | number): Endpoint {
  const host = hostValue.trim()
  if (host.length === 0 || host.length > 253 || !/^[a-zA-Z0-9._:%-]+$/.test(host)) {
    throw new TypeError('Enter a valid hostname or IP address')
  }

  const port = typeof portValue === 'number' ? portValue : Number(portValue.trim())
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError('Port must be an integer from 1 to 65535')
  }

  return { host, port }
}
