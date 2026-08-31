import { useEffect } from 'react'
import { Text } from 'react-native'
import { cleanup, render } from '@testing-library/react-native'

import { TabletCapabilityGate } from '../TabletCapabilityGate'
import { UnsupportedDeviceScreen } from '../UnsupportedDeviceScreen'
import { tabletCapability } from '../tablet'

afterEach(cleanup)

const renderUnsupported = () => <UnsupportedDeviceScreen onOpenLogs={jest.fn()} />

describe('Android tablet capability', () => {
  it('requires a 600dp-shortest-side landscape window', () => {
    expect(tabletCapability(1_280, 599)).toEqual({
      layout: 'unsupported',
      height: 599
    })
    expect(tabletCapability(1_280, 600)).toEqual({
      layout: 'expanded',
      height: 600
    })
    expect(tabletCapability(599, 1_280).layout).toBe('unsupported')
    expect(tabletCapability(600, 1_280).layout).toBe('unsupported')
    expect(tabletCapability(915, 412).layout).toBe('unsupported')
  })

  it('rejects square windows and preserves width-based landscape tiers', () => {
    expect(tabletCapability(600, 600).layout).toBe('unsupported')
    expect(tabletCapability(840, 840).layout).toBe('unsupported')
    expect(tabletCapability(800, 600).layout).toBe('condensed')
    expect(tabletCapability(839, 600).layout).toBe('condensed')
    expect(tabletCapability(840, 600).layout).toBe('expanded')
    expect(tabletCapability(1_280, 800).layout).toBe('expanded')
  })

  it('never evaluates the client factory for an unsupported window', () => {
    const createClient = jest.fn(() => <Text testID="client">client</Text>)
    const screen = render(
      <TabletCapabilityGate
        capability={tabletCapability(600, 800)}
        renderSupported={createClient}
        renderUnsupported={renderUnsupported}
      />
    )

    expect(screen.getByTestId('unsupported-device-screen')).toBeTruthy()
    expect(screen.getByText('Codey needs a landscape tablet window')).toBeTruthy()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('tears down the client in portrait or square bounds and mounts a fresh client on return', () => {
    const onMount = jest.fn()
    const onUnmount = jest.fn()
    function Client() {
      useEffect(() => {
        onMount()
        return onUnmount
      }, [])
      return <Text testID="client">client</Text>
    }
    const renderSupported = () => <Client />
    const screen = render(
      <TabletCapabilityGate
        capability={tabletCapability(1_280, 800)}
        renderSupported={renderSupported}
        renderUnsupported={renderUnsupported}
      />
    )
    expect(screen.getByTestId('client')).toBeTruthy()
    expect(onMount).toHaveBeenCalledTimes(1)

    screen.rerender(
      <TabletCapabilityGate
        capability={tabletCapability(800, 1_280)}
        renderSupported={renderSupported}
        renderUnsupported={renderUnsupported}
      />
    )
    expect(onUnmount).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('unsupported-device-screen')).toBeTruthy()

    screen.rerender(
      <TabletCapabilityGate
        capability={tabletCapability(1_280, 800)}
        renderSupported={renderSupported}
        renderUnsupported={renderUnsupported}
      />
    )
    expect(screen.getByTestId('client')).toBeTruthy()
    expect(onMount).toHaveBeenCalledTimes(2)

    screen.rerender(
      <TabletCapabilityGate
        capability={tabletCapability(800, 800)}
        renderSupported={renderSupported}
        renderUnsupported={renderUnsupported}
      />
    )
    expect(onUnmount).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('unsupported-device-screen')).toBeTruthy()
  })
})
