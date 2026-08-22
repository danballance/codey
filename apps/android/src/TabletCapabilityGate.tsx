import type { ReactNode } from 'react'

import { UnsupportedDeviceScreen } from './UnsupportedDeviceScreen'
import type { TabletCapability } from './tablet'

interface TabletCapabilityGateProps {
  readonly capability: TabletCapability
  readonly renderSupported: () => ReactNode
}

/**
 * The lazy render callback is the construction boundary for every native and
 * session object. It is deliberately never evaluated below the tablet limit.
 */
export function TabletCapabilityGate({
  capability,
  renderSupported
}: TabletCapabilityGateProps) {
  return capability.supported ? renderSupported() : <UnsupportedDeviceScreen />
}
