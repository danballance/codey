import AsyncStorage from '@react-native-async-storage/async-storage'

import { DEFAULT_ENDPOINT, validateEndpoint, type Endpoint } from './endpoint'

const ENDPOINT_STORAGE_KEY = 'codey.android.endpoint.v1'

export interface EndpointStore {
  load(): Promise<Endpoint>
  save(endpoint: Endpoint): Promise<void>
}

export const endpointStore: EndpointStore = {
  async load(): Promise<Endpoint> {
    try {
      const raw = await AsyncStorage.getItem(ENDPOINT_STORAGE_KEY)
      if (raw === null) return DEFAULT_ENDPOINT
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return DEFAULT_ENDPOINT
      const record = parsed as Record<string, unknown>
      if (typeof record.host !== 'string') return DEFAULT_ENDPOINT
      if (typeof record.port !== 'number') return DEFAULT_ENDPOINT
      return validateEndpoint(record.host, record.port)
    } catch {
      return DEFAULT_ENDPOINT
    }
  },

  async save(endpoint: Endpoint): Promise<void> {
    await AsyncStorage.setItem(ENDPOINT_STORAGE_KEY, JSON.stringify(endpoint))
  }
}
