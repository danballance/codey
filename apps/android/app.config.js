const app = {
  expo: {
    name: 'Codey',
    slug: 'codey-android',
    version: '0.1.0',
    platforms: ['android'],
    orientation: 'landscape',
    userInterfaceStyle: 'dark',
    backgroundColor: '#090b10',
    scheme: 'codey',
    android: {
      package: 'dev.codey.android',
      versionCode: 1,
      softwareKeyboardLayoutMode: 'resize',
      permissions: ['INTERNET'],
      predictiveBackGestureEnabled: false
    },
    plugins: [
      './plugins/with-dark-android-splash',
      './plugins/with-codey-nvim-runtime',
      'expo-system-ui',
      ['expo-status-bar', { hidden: false, style: 'light' }],
      ['expo-dev-client', { launchMode: 'most-recent' }]
    ]
  }
}

function withoutDevClient(plugins) {
  return plugins.filter((plugin) => {
    if (typeof plugin === 'string') return plugin !== 'expo-dev-client'
    return !Array.isArray(plugin) || plugin[0] !== 'expo-dev-client'
  })
}

module.exports = () => {
  const config = JSON.parse(JSON.stringify(app))
  if (process.env.CODEY_BUILD_PROFILE === 'standalone') {
    config.expo.plugins = withoutDevClient(config.expo.plugins ?? [])
  }
  return config
}

module.exports.withoutDevClient = withoutDevClient
