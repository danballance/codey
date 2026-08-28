const path = require('node:path')

// Resolve through Expo's dependency rather than relying on pnpm hoisting it.
const upstream = require(require.resolve('@expo/metro-config/babel-transformer', {
  paths: [path.dirname(require.resolve('expo/metro-config'))]
}))

module.exports = {
  ...upstream,
  transform(options) {
    if (!/\.ya?ml$/i.test(options.filename)) return upstream.transform(options)
    return upstream.transform({
      ...options,
      src: `module.exports = ${JSON.stringify(options.src)};`
    })
  }
}
