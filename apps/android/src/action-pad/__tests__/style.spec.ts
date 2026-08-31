import {
  ACTION_BUTTON_LAYOUT_UNITS,
  ACTION_BUTTON_SIZE_OPTIONS,
  DEFAULT_ACTION_BUTTON_LABEL_COLOR,
  isActionButtonHexColor,
  isActionButtonLabelColor,
  isActionButtonStyleColor,
  mergeActionButtonStyles,
  resolveActionButtonLabelColor,
  resolveActionButtonStyles
} from '../style'

describe('action button style utilities', () => {
  it('defines ordered five-way fractional metadata on a shared 60-unit grid', () => {
    expect(ACTION_BUTTON_LAYOUT_UNITS).toBe(60)
    expect(ACTION_BUTTON_SIZE_OPTIONS).toEqual([
      { value: '1/1', label: 'Whole', units: 60, width: '100%' },
      { value: '1/2', label: 'Half', units: 30, width: '48%' },
      { value: '1/3', label: 'Third', units: 20, width: '30.6666%' },
      { value: '1/4', label: 'Quarter', units: 15, width: '22%' },
      { value: '1/5', label: 'Fifth', units: 12, width: '16.8%' }
    ])
  })

  it('accepts only full six-digit hex colours plus transparent for button chrome', () => {
    for (const color of ['#123456', '#abcdef', '#ABCDEF', '#aBc123']) {
      expect(isActionButtonHexColor(color)).toBe(true)
      expect(isActionButtonStyleColor(color)).toBe(true)
      expect(isActionButtonLabelColor(color)).toBe(true)
    }
    expect(isActionButtonStyleColor('transparent')).toBe(true)
    expect(isActionButtonLabelColor('transparent')).toBe(false)
    for (const color of ['', '#fff', '#12345678', 'red', 'rgb(1, 2, 3)', 'Transparent', ' #123456']) {
      expect(isActionButtonHexColor(color)).toBe(false)
    }
  })

  it('resolves appearance defaults, explicit overrides and invalid draft fallbacks', () => {
    expect(resolveActionButtonStyles({ size: '1/3' })).toEqual({
      size: '1/3', units: 20, width: '30.6666%', appearance: 'filled',
      backgroundColor: '#24283b', outlineColor: 'transparent'
    })
    expect(resolveActionButtonStyles({ size: '1/5', appearance: 'outline' })).toEqual({
      size: '1/5', units: 12, width: '16.8%', appearance: 'outline',
      backgroundColor: 'transparent', outlineColor: '#353b52'
    })
    expect(resolveActionButtonStyles({
      size: '1/1', appearance: 'outline', backgroundColor: '#ABCDEF', outlineColor: 'transparent'
    })).toMatchObject({ backgroundColor: '#ABCDEF', outlineColor: 'transparent' })
    expect(resolveActionButtonStyles({
      size: '1/2', appearance: 'outline', backgroundColor: '#abc', outlineColor: 'red'
    })).toMatchObject({ backgroundColor: 'transparent', outlineColor: '#353b52' })
    expect(resolveActionButtonLabelColor('#9ece6a')).toBe('#9ece6a')
    expect(resolveActionButtonLabelColor('transparent')).toBe(DEFAULT_ACTION_BUTTON_LABEL_COLOR)
  })

  it('merges independent controls and removes reset optional fields', () => {
    const original = {
      size: '1/2', appearance: 'outline', backgroundColor: '#123456', outlineColor: '#654321'
    } as const
    expect(mergeActionButtonStyles(original, { size: '1/5' })).toEqual({
      size: '1/5', appearance: 'outline', backgroundColor: '#123456', outlineColor: '#654321'
    })
    expect(mergeActionButtonStyles(original, {
      appearance: undefined, backgroundColor: undefined, outlineColor: undefined
    })).toEqual({ size: '1/2' })
    expect(original).toEqual({
      size: '1/2', appearance: 'outline', backgroundColor: '#123456', outlineColor: '#654321'
    })
  })
})
