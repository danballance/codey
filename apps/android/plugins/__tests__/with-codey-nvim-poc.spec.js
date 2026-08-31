const {
  ALL_FILES_PERMISSION,
  DEV_CLIENT_NATIVE_MODULES,
  UNUSED_EXPO_PERMISSIONS,
  configureGradleProperties,
  configureManifest,
  configurePocSettingsGradle
} = require('../with-codey-nvim-poc')

describe('bundled NeoVim Android config plugin', () => {
  it('sets the API floor, arm64 ABI, and extracted native-library packaging', () => {
    const result = configureGradleProperties([
      { type: 'property', key: 'reactNativeArchitectures', value: 'x86_64' }
    ])

    expect(result).toEqual(expect.arrayContaining([
      { type: 'property', key: 'android.minSdkVersion', value: '30' },
      { type: 'property', key: 'reactNativeArchitectures', value: 'arm64-v8a' },
      { type: 'property', key: 'expo.useLegacyPackaging', value: 'true' }
    ]))
  })

  it('adds only the required broad access and forces native-library extraction', () => {
    const manifest = {
      manifest: {
        $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
        'uses-permission': [
          { $: { 'android:name': ALL_FILES_PERMISSION } },
          { $: { 'android:name': ALL_FILES_PERMISSION } }
        ],
        application: [{ $: { 'android:name': '.MainApplication' } }]
      }
    }

    configureManifest(manifest)

    expect(manifest.manifest['uses-permission'].filter(
      (permission) => permission.$['android:name'] === ALL_FILES_PERMISSION
    )).toHaveLength(1)
    for (const permissionName of UNUSED_EXPO_PERMISSIONS) {
      expect(manifest.manifest['uses-permission']).toContainEqual({
        $: {
          'android:name': permissionName,
          'tools:node': 'remove'
        }
      })
    }
    expect(manifest.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools')
    expect(manifest.manifest.application[0].$['android:extractNativeLibs']).toBe('true')
  })

  it('excludes the development client graph from POC native autolinking', () => {
    const result = configurePocSettingsGradle('before\nexpoAutolinking.useExpoModules()\nafter')

    expect(result).toContain('expoAutolinking.exclude = [')
    for (const moduleName of DEV_CLIENT_NATIVE_MODULES) {
      expect(result).toContain(`'${moduleName}'`)
    }
    expect(result).toContain('expoAutolinking.useExpoModules()')
    expect(configurePocSettingsGradle(result)).toBe(result)
  })
})
