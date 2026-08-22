const {
  DARK_SPLASH_COLOR,
  SPLASH_COLOR_RESOURCE,
  setDarkSplashColor,
  setDarkSplashTheme
} = require('../with-dark-android-splash')

describe('dark Android splash config plugin', () => {
  it('replaces the generated white launch background', () => {
    const colors = {
      resources: {
        color: [
          {
            $: { name: SPLASH_COLOR_RESOURCE },
            _: '#FFFFFF'
          }
        ]
      }
    }

    setDarkSplashColor(colors)

    expect(colors.resources.color).toContainEqual({
      $: { name: SPLASH_COLOR_RESOURCE },
      _: DARK_SPLASH_COLOR
    })
  })

  it('adds the launch color when the template does not define it', () => {
    const colors = { resources: {} }

    setDarkSplashColor(colors)

    expect(colors.resources.color).toEqual([
      {
        $: { name: SPLASH_COLOR_RESOURCE },
        _: DARK_SPLASH_COLOR
      }
    ])
  })

  it('points the actual launch theme at the dark color instead of the white template image', () => {
    const styles = {
      resources: {
        style: [
          {
            $: { name: 'Theme.App.SplashScreen', parent: 'AppTheme' },
            item: [
              {
                $: { name: 'android:windowBackground' },
                _: '@drawable/splashscreen_logo'
              }
            ]
          }
        ]
      }
    }

    setDarkSplashTheme(styles)

    expect(styles.resources.style[0].item).toContainEqual({
      $: { name: 'android:windowBackground' },
      _: `@color/${SPLASH_COLOR_RESOURCE}`
    })
  })
})
