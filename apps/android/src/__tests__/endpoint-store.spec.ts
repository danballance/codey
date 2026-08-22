jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn()
  }
}))

import AsyncStorage from '@react-native-async-storage/async-storage'

import { DEFAULT_ENDPOINT } from '../endpoint'
import { endpointStore } from '../endpoint-store'

const getItem = jest.mocked(AsyncStorage.getItem)
const setItem = jest.mocked(AsyncStorage.setItem)

describe('persisted endpoint', () => {
  it('loads a valid host and port and saves normalized JSON', async () => {
    getItem.mockResolvedValueOnce('{"host":"tablet-host","port":7777}')
    await expect(endpointStore.load()).resolves.toEqual({ host: 'tablet-host', port: 7777 })

    await endpointStore.save({ host: '192.168.0.20', port: 6666 })
    expect(setItem).toHaveBeenCalledWith(
      'codey.android.endpoint.v1',
      '{"host":"192.168.0.20","port":6666}'
    )
  })

  it('falls back safely for missing, malformed, or invalid persisted values', async () => {
    getItem.mockResolvedValueOnce(null)
    await expect(endpointStore.load()).resolves.toBe(DEFAULT_ENDPOINT)

    getItem.mockResolvedValueOnce('{broken')
    await expect(endpointStore.load()).resolves.toBe(DEFAULT_ENDPOINT)

    getItem.mockResolvedValueOnce('{"host":"bad host","port":0}')
    await expect(endpointStore.load()).resolves.toBe(DEFAULT_ENDPOINT)
  })
})
