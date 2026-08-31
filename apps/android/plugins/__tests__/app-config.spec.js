const { withoutDevClient } = require('../../app.config')

describe('Android dynamic app config', () => {
  it('removes only the development client plugin for standalone POC builds', () => {
    expect(withoutDevClient([
      './plugins/with-codey-nvim-poc',
      ['expo-dev-client', { launchMode: 'most-recent' }],
      'expo-status-bar'
    ])).toEqual([
      './plugins/with-codey-nvim-poc',
      'expo-status-bar'
    ])
  })
})
