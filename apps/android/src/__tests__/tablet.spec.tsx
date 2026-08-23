import { useEffect } from 'react'
import { Text } from 'react-native'
import { cleanup, render } from '@testing-library/react-native'

import { TabletCapabilityGate } from '../TabletCapabilityGate'
import { tabletCapability } from '../tablet'

afterEach(cleanup)

describe('Android tablet capability', () => {
  it('uses the 600dp shortest-side boundary in both orientations', () => {
    expect(tabletCapability(1_280, 599)).toMatchObject({
      supported: false,
      layout: 'unsupported',
      orientation: 'landscape'
    })
    expect(tabletCapability(1_280, 600)).toMatchObject({
      supported: true,
      layout: 'expanded',
      orientation: 'landscape'
    })
    expect(tabletCapability(599, 1_280)).toMatchObject({
      supported: false,
      layout: 'unsupported',
      orientation: 'portrait'
    })
    expect(tabletCapability(600, 1_280)).toMatchObject({
      supported: true,
      layout: 'condensed',
      orientation: 'portrait'
    })
  })

  it('rejects phone-sized windows and preserves width-based tablet tiers', () => {
    expect(tabletCapability(915, 412).supported).toBe(false)
    expect(tabletCapability(412, 915).supported).toBe(false)
    expect(tabletCapability(600, 800)).toMatchObject({
      supported: true,
      layout: 'condensed',
      orientation: 'portrait'
    })
    expect(tabletCapability(800, 600).layout).toBe('condensed')
    expect(tabletCapability(839, 600).layout).toBe('condensed')
    expect(tabletCapability(840, 600).layout).toBe('expanded')
    expect(tabletCapability(1_280, 800).layout).toBe('expanded')
  })

  it('treats square windows as portrait/stacked layouts', () => {
    expect(tabletCapability(600, 600)).toMatchObject({
      supported: true,
      layout: 'condensed',
      orientation: 'portrait'
    })
    expect(tabletCapability(840, 840)).toMatchObject({
      supported: true,
      layout: 'expanded',
      orientation: 'portrait'
    })
  })

  it('never evaluates the supported client factory for an unsupported window', () => {
    const createClient = jest.fn(() => <Text testID="client">client</Text>)
    const screen = render(
      <TabletCapabilityGate
        capability={tabletCapability(915, 412)}
        renderSupported={createClient}
      />
    )

    expect(screen.getByTestId('unsupported-device-screen')).toBeTruthy()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('unmounts the supported subtree when multi-window bounds become unsupported', () => {
    const onUnmount = jest.fn()
    function Client() {
      useEffect(() => onUnmount, [])
      return <Text testID="client">client</Text>
    }
    const screen = render(
      <TabletCapabilityGate
        capability={tabletCapability(1_280, 800)}
        renderSupported={() => <Client />}
      />
    )
    expect(screen.getByTestId('client')).toBeTruthy()

    screen.rerender(
      <TabletCapabilityGate
        capability={tabletCapability(915, 412)}
        renderSupported={() => <Client />}
      />
    )
    expect(onUnmount).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('unsupported-device-screen')).toBeTruthy()
  })
})
