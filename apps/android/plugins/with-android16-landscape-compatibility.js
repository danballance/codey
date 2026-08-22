const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest
} = require('expo/config-plugins')

const PROPERTY_NAME = 'android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY'

/**
 * Android 16 ignores fixed-orientation requests on large displays by default.
 * This temporary platform opt-out keeps the development client in landscape
 * while API 36 still supports compatibility mode. The runtime capability gate
 * remains authoritative because Android 17 removes this opt-out.
 */
function setAndroid16LandscapeCompatibility(androidManifest) {
  const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(androidManifest)
  const properties = mainActivity.property ?? []
  const existing = properties.find(
    (property) => property.$?.['android:name'] === PROPERTY_NAME
  )

  if (existing === undefined) {
    properties.push({
      $: {
        'android:name': PROPERTY_NAME,
        'android:value': 'true'
      }
    })
  } else {
    existing.$ = {
      ...existing.$,
      'android:name': PROPERTY_NAME,
      'android:value': 'true'
    }
  }

  mainActivity.property = properties
  return androidManifest
}

function withAndroid16LandscapeCompatibility(config) {
  return withAndroidManifest(config, (manifestConfig) => {
    manifestConfig.modResults = setAndroid16LandscapeCompatibility(
      manifestConfig.modResults
    )
    return manifestConfig
  })
}

const plugin = createRunOncePlugin(
  withAndroid16LandscapeCompatibility,
  'with-android16-landscape-compatibility',
  '1.0.0'
)

module.exports = plugin
module.exports.PROPERTY_NAME = PROPERTY_NAME
module.exports.setAndroid16LandscapeCompatibility = setAndroid16LandscapeCompatibility

