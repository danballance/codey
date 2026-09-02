const createConfig = require('../../app.config')
const { withoutDevClient } = createConfig

const originalBuildProfile = process.env.CODEY_BUILD_PROFILE

afterEach(() => {
  if (originalBuildProfile === undefined) {
    delete process.env.CODEY_BUILD_PROFILE
  } else {
    process.env.CODEY_BUILD_PROFILE = originalBuildProfile
  }
})

describe('Android dynamic app config', () => {
  it('removes only the development client plugin for standalone builds', () => {
    expect(withoutDevClient([
      './plugins/with-codey-nvim-runtime',
      ['expo-dev-client', { launchMode: 'most-recent' }],
      'expo-status-bar'
    ])).toEqual([
      './plugins/with-codey-nvim-runtime',
      'expo-status-bar'
    ])
  })

  it('uses the standalone profile without removing Internet access', () => {
    process.env.CODEY_BUILD_PROFILE = 'standalone'

    const config = createConfig()

    expect(config.expo.plugins).not.toContain('expo-dev-client')
    expect(config.expo.plugins).not.toContainEqual(
      expect.arrayContaining(['expo-dev-client'])
    )
    expect(config.expo.android.permissions).toContain('INTERNET')
  })

  it('keeps the development client outside the standalone profile', () => {
    process.env.CODEY_BUILD_PROFILE = 'development'

    const config = createConfig()

    expect(config.expo.plugins).toContainEqual(
      expect.arrayContaining(['expo-dev-client'])
    )
    expect(config.expo.android.permissions).toContain('INTERNET')
  })
})
