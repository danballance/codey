const app = require('./app.json')

function withoutDevClient(plugins) {
  return plugins.filter((plugin) => {
    if (typeof plugin === 'string') return plugin !== 'expo-dev-client'
    return !Array.isArray(plugin) || plugin[0] !== 'expo-dev-client'
  })
}

module.exports = () => {
  const config = JSON.parse(JSON.stringify(app))
  if (process.env.CODEY_BUILD_PROFILE === 'poc') {
    config.expo.plugins = withoutDevClient(config.expo.plugins ?? [])
  }
  return config
}

module.exports.withoutDevClient = withoutDevClient
