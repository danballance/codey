const {
  PROPERTY_NAME,
  setAndroid16LandscapeCompatibility
} = require('../with-android16-landscape-compatibility')

function manifestWithMainActivity(properties = []) {
  return {
    manifest: {
      $: {},
      application: [
        {
          $: {},
          activity: [
            {
              $: { 'android:name': '.MainActivity' },
              property: properties
            }
          ]
        }
      ]
    }
  }
}

describe('Android 16 landscape compatibility config plugin', () => {
  it('adds the API 36 restricted-resizability opt-out to MainActivity', () => {
    const manifest = manifestWithMainActivity()

    setAndroid16LandscapeCompatibility(manifest)

    expect(manifest.manifest.application[0].activity[0].property).toContainEqual({
      $: {
        'android:name': PROPERTY_NAME,
        'android:value': 'true'
      }
    })
  })

  it('is idempotent and corrects an existing disabled property', () => {
    const manifest = manifestWithMainActivity([
      {
        $: {
          'android:name': PROPERTY_NAME,
          'android:value': 'false'
        }
      }
    ])

    setAndroid16LandscapeCompatibility(manifest)
    setAndroid16LandscapeCompatibility(manifest)

    const matchingProperties = manifest.manifest.application[0].activity[0].property.filter(
      (property) => property.$['android:name'] === PROPERTY_NAME
    )
    expect(matchingProperties).toHaveLength(1)
    expect(matchingProperties[0].$['android:value']).toBe('true')
  })
})

