const {
  ALL_FILES_PERMISSION,
  BUNDLED_NVIM_NATIVE_LIBRARIES,
  BUNDLED_NVIM_NATIVE_LIBRARY_NAMES,
  DEV_CLIENT_NATIVE_MODULES,
  UNUSED_EXPO_PERMISSIONS,
  configureGradleProperties,
  configureManifest,
  configureStandaloneSettingsGradle,
  parseNativeLibrariesLock
} = require('../with-codey-nvim-runtime')

const DO_NOT_STRIP_PROPERTY = 'android.packagingOptions.doNotStrip'

describe('bundled NeoVim Android config plugin', () => {
  it('derives the do-not-strip patterns from a strict sorted native-library lock', () => {
    expect(BUNDLED_NVIM_NATIVE_LIBRARY_NAMES).toHaveLength(42)
    expect(BUNDLED_NVIM_NATIVE_LIBRARY_NAMES).toEqual(
      [...BUNDLED_NVIM_NATIVE_LIBRARY_NAMES].sort()
    )
    expect(BUNDLED_NVIM_NATIVE_LIBRARIES).toEqual(
      BUNDLED_NVIM_NATIVE_LIBRARY_NAMES.map((libraryName) => `**/${libraryName}`)
    )

    expect(() => parseNativeLibrariesLock('libz.so\nliba.so\n', 'test.lock'))
      .toThrow('test.lock: native library entries must be bytewise sorted')
    expect(() => parseNativeLibrariesLock('liba.so\nliba.so\n', 'test.lock'))
      .toThrow('test.lock: native library entries must be unique')
    expect(() => parseNativeLibrariesLock('../liba.so\n', 'test.lock'))
      .toThrow('test.lock:1: invalid native library filename: ../liba.so')
  })

  it('sets the API floor, arm64 ABI, and extracted native-library packaging', () => {
    const result = configureGradleProperties([
      { type: 'property', key: 'reactNativeArchitectures', value: 'x86_64' },
      {
        type: 'property',
        key: 'org.gradle.jvmargs',
        value: '-Xmx2048m -Dfile.encoding=UTF-8 -XX:MaxMetaspaceSize=512m'
      }
    ])

    expect(result).toEqual(expect.arrayContaining([
      {
        type: 'property',
        key: 'org.gradle.jvmargs',
        value: '-Xmx2048m -Dfile.encoding=UTF-8 -XX:MaxMetaspaceSize=1024m'
      },
      { type: 'property', key: 'android.minSdkVersion', value: '30' },
      { type: 'property', key: 'reactNativeArchitectures', value: 'arm64-v8a' },
      { type: 'property', key: 'expo.useLegacyPackaging', value: 'true' }
    ]))
    expect(result.filter((item) => item.key === 'org.gradle.jvmargs')).toHaveLength(1)
    expect(configureGradleProperties(result)).toEqual(result)
  })

  it('preserves existing do-not-strip entries and adds every bundled NeoVim library once', () => {
    const existingEntries = ['**/libalready-preserved.so', 'lib/arm64-v8a/libvendor.so']
    const unrelatedEntry = { type: 'comment', value: 'keep this record' }
    const initial = [
      unrelatedEntry,
      {
        type: 'property',
        key: DO_NOT_STRIP_PROPERTY,
        value: ` ${existingEntries[0]}, , ${existingEntries[0]}, ${existingEntries[1]} `
      },
      {
        type: 'property',
        key: DO_NOT_STRIP_PROPERTY,
        value: ' **/libandroid-support.so, **/libandroid-support.so '
      }
    ]

    const result = configureGradleProperties(initial)
    const property = result.find((item) => item.key === DO_NOT_STRIP_PROPERTY)
    const entries = property.value.split(',')

    expect(result.filter((item) => item.key === DO_NOT_STRIP_PROPERTY)).toHaveLength(1)
    expect(result).toContain(unrelatedEntry)
    expect(entries).toEqual([...existingEntries, ...BUNDLED_NVIM_NATIVE_LIBRARIES])
    expect(new Set(entries).size).toBe(entries.length)

    const repeated = configureGradleProperties(result)
    expect(repeated).toEqual(result)
  })

  it('adds only the required broad access and forces native-library extraction', () => {
    const manifest = {
      manifest: {
        $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
        'uses-permission': [
          { $: { 'android:name': 'android.permission.INTERNET' } },
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
    expect(manifest.manifest['uses-permission']).toContainEqual({
      $: { 'android:name': 'android.permission.INTERNET' }
    })
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

  it('excludes the development client graph from standalone native autolinking', () => {
    const result = configureStandaloneSettingsGradle('before\nexpoAutolinking.useExpoModules()\nafter')

    expect(result).toContain('expoAutolinking.exclude = [')
    for (const moduleName of DEV_CLIENT_NATIVE_MODULES) {
      expect(result).toContain(`'${moduleName}'`)
    }
    expect(result).toContain('expoAutolinking.useExpoModules()')
    expect(configureStandaloneSettingsGradle(result)).toBe(result)
  })
})
