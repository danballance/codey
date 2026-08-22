const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidColors,
  withAndroidStyles
} = require('expo/config-plugins')

const DARK_SPLASH_COLOR = '#090b10'
const SPLASH_COLOR_RESOURCE = 'splashscreen_background'
const SPLASH_THEME = 'Theme.App.SplashScreen'

function setDarkSplashColor(colors) {
  return AndroidConfig.Colors.setColorItem(
    {
      $: { name: SPLASH_COLOR_RESOURCE },
      _: DARK_SPLASH_COLOR
    },
    colors
  )
}

function setDarkSplashTheme(styles) {
  return AndroidConfig.Styles.setStylesItem({
    parent: { name: SPLASH_THEME },
    item: {
      $: { name: 'android:windowBackground' },
      _: `@color/${SPLASH_COLOR_RESOURCE}`
    },
    xml: styles
  })
}

function withDarkAndroidSplash(config) {
  const withColor = withAndroidColors(config, (colorsConfig) => {
    colorsConfig.modResults = setDarkSplashColor(colorsConfig.modResults)
    return colorsConfig
  })
  return withAndroidStyles(withColor, (stylesConfig) => {
    stylesConfig.modResults = setDarkSplashTheme(stylesConfig.modResults)
    return stylesConfig
  })
}

const plugin = createRunOncePlugin(
  withDarkAndroidSplash,
  'with-dark-android-splash',
  '1.0.0'
)

module.exports = plugin
module.exports.DARK_SPLASH_COLOR = DARK_SPLASH_COLOR
module.exports.SPLASH_COLOR_RESOURCE = SPLASH_COLOR_RESOURCE
module.exports.setDarkSplashColor = setDarkSplashColor
module.exports.setDarkSplashTheme = setDarkSplashTheme
