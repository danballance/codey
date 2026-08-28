import defaultYaml from '../default.yaml'
import { ACTION_PAD_MENU, DEFAULT_ACTION_PAD_CONFIG } from '../config'
import {
  ACTION_PAD_CONFIG_MAX_BYTES,
  ActionPadConfigError,
  isActionPadConfigShape,
  parseActionPadConfig,
  resolveActionPadConfig,
  serializeActionPadConfig,
  validateActionPadConfig,
  type ActionMenuDefinitionButton,
  type ActionPadConfig
} from '../document'

// Jest runs in Node; avoid introducing Node globals into the Android typecheck.
const { createHash } = jest.requireActual<{
  createHash(algorithm: 'sha256'): {
    update(text: string, encoding: 'utf8'): { digest(encoding: 'hex'): string }
  }
}>('node:crypto')

const inputButton: ActionMenuDefinitionButton = {
  id: 'input', label: 'Input', tap: { type: 'input', nvimInput: '<Esc>', after: 'root' }
}

function config(buttons: readonly ActionMenuDefinitionButton[] = [inputButton]): ActionPadConfig {
  return {
    version: 1,
    rootMenuId: 'home',
    menus: [{ id: 'home', label: 'Home', groups: [{ id: 'actions', buttons }] }]
  }
}

function candidateWithButton(button: unknown) {
  return {
    version: 1,
    rootMenuId: 'home',
    menus: [{ id: 'home', label: 'Home', groups: [{ id: 'actions', buttons: [button] }] }]
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]))
  }
  return value
}

describe('action pad YAML document', () => {
  it('loads the bundled source synchronously and preserves all current menus and buttons', () => {
    expect(typeof defaultYaml).toBe('string')
    expect(DEFAULT_ACTION_PAD_CONFIG.menus.map((menu) => menu.id)).toEqual([
      'home', 'command', 'leader', 'motions', 'text-objects', 'up-navigation',
      'down-navigation', 'search', 'window', 'code', 'yank', 'delete'
    ])
    const groups = DEFAULT_ACTION_PAD_CONFIG.menus.flatMap((menu) => menu.groups)
    expect(groups).toHaveLength(24)
    expect(groups.flatMap((group) => group.buttons)).toHaveLength(90)
    expect(resolveActionPadConfig(parseActionPadConfig(defaultYaml))).toEqual(ACTION_PAD_MENU)
    expect(parseActionPadConfig(serializeActionPadConfig(DEFAULT_ACTION_PAD_CONFIG))).toEqual(DEFAULT_ACTION_PAD_CONFIG)
  })

  it('matches every original menu field and ordering against the frozen TypeScript migration baseline', () => {
    // Derived independently from MENU_DEFINITIONS at commit
    // 60c294052a02aa641944ff778e41ccaf6b2901c5, with registry keys added as menu IDs.
    // SHA-256 covers UTF-8 JSON with recursively sorted object keys; array order,
    // exact strings and omitted/present optional fields are preserved. Deliberate
    // starter changes require an explicitly reviewed update to this baseline.
    expect(DEFAULT_ACTION_PAD_CONFIG).toMatchObject({ version: 1, rootMenuId: 'home' })
    expect(DEFAULT_ACTION_PAD_CONFIG.menus.map((menu) => [
      menu.id,
      createHash('sha256').update(JSON.stringify(canonicalValue(menu)), 'utf8').digest('hex')
    ])).toEqual([
      ['home', '0def47dcecac1ad1ca063b454784bd7ed2a78d9fc49682dfac20d441b404b73f'],
      ['command', '0d98467f4078eecc3435d79e909b23b0fbf5434f8bb089345184598aa9320ad7'],
      ['leader', '2ecdaa5a848be57e49d17e2e78367fd871f89527c16a37a2d556739ee16a53a0'],
      ['motions', '22a16eafd913045d515b31d9c63c8fb8226cdaaff2e3f3c3d30eb93654fb8e6e'],
      ['text-objects', '63731a53ea7d14c6409868061427da40fe409d78a8dda138d961c0b1c73cdd61'],
      ['up-navigation', 'f5093ee15a2611bbc863cee55d016f74ba3e80c85280c1600657fe660dda1bd9'],
      ['down-navigation', '72c1181eb32edc6afa31d6e5e0c7ca027fc3e07d32c9848ba15fe2cec4eafc1f'],
      ['search', '8fcde459d215e11c024e3fcb6933a3149a28c021f54410a7e815664be92980a3'],
      ['window', '730132e728ff4a6481a8cf14f1800ce4ec5f056cebc0ec9cddf6a9c5457a1766'],
      ['code', 'd3f9e868a2579eb2d2842dee06f9c1576e079f1ca368872abf7b0bdbcf2fa9bf'],
      ['yank', '717be5fe9d0cf6e7515370c6ce4db24ff0f57493ec3222953fb5227a5e13ee95'],
      ['delete', 'a44e7b503fb39142e59bd2b536ffcf1c4da41eda4a945e763b857fd9d917319b']
    ])
  })

  it('round trips Unicode, numeric-looking labels, punctuation and exact input whitespace', () => {
    const value = config([
      {
        id: 'numeric', label: '2', accessibilityLabel: 'Two', accessibilityHint: 'Hold: # text',
        styles: { size: '1/4' },
        tap: { type: 'input', nvimInput: '  <Esc>:echo "it\'s # λ"<CR>\n\t  ', after: 'stay' },
        longPress: { type: 'keyboard', after: 'root' }
      },
      { id: 'hold', label: '⬆ 😀', styles: {}, longPress: { type: 'input', nvimInput: '{}: # \\ 2', after: 'root' } },
      { id: 'back', label: 'Back', tap: { type: 'back', after: 'stay' } }
    ])
    const text = serializeActionPadConfig(value)

    expect(text).toContain("label: '2'")
    expect(parseActionPadConfig(text)).toEqual(value)
    expect(serializeActionPadConfig(parseActionPadConfig(text))).toBe(text)
  })

  it('normalizes formatting without changing array order or filling optional fields', () => {
    const yaml = '# user comment\n' + JSON.stringify(config([{ id: 'hold', label: 'Hold', longPress: { type: 'back', after: 'root' } }]))
    const value = parseActionPadConfig(yaml)
    const normalized = serializeActionPadConfig(value)

    expect(normalized).not.toContain('# user comment')
    expect(normalized).not.toContain('tap:')
    expect(normalized).not.toContain('styles:')
    expect(parseActionPadConfig(normalized)).toEqual(value)
  })

  it.each([
    ['duplicate keys', 'version: 1\nversion: 1\nrootMenuId: home\nmenus: []'],
    ['multiple documents', JSON.stringify(config()) + '\n---\nversion: 1'],
    ['aliases', 'version: 1\nrootMenuId: &root home\nmenus: [*root]'],
    ['an unresolved alias', 'version: 1\nrootMenuId: *missing\nmenus: []'],
    ['explicit tags', 'version: 1\nrootMenuId: !!str home\nmenus: []'],
    ['custom tags', 'version: 1\nrootMenuId: !exec home\nmenus: []'],
    ['YAML 1.1', '%YAML 1.1\n---\nversion: 1\nrootMenuId: home\nmenus: []'],
    ['invalid syntax', 'version: 1\nmenus: ['],
    ['complex keys', '? [a, b]\n: value']
  ])('rejects %s as a document error', (_name, yaml) => {
    expect(() => parseActionPadConfig(yaml)).toThrow(ActionPadConfigError)
    try {
      parseActionPadConfig(yaml)
    } catch (error) {
      expect((error as ActionPadConfigError).issues[0]?.path).toBe('yaml')
    }
  })

  it('bounds UTF8 file size and YAML nesting before converting to application objects', () => {
    expect(() => parseActionPadConfig('#' + '😀'.repeat(ACTION_PAD_CONFIG_MAX_BYTES / 4))).toThrow('1 MiB')
    expect(() => parseActionPadConfig('['.repeat(40) + ']'.repeat(40))).toThrow('too deeply nested')
    expect(() => serializeActionPadConfig(config([
      { ...inputButton, tap: { type: 'input', nvimInput: 'x'.repeat(ACTION_PAD_CONFIG_MAX_BYTES), after: 'root' } }
    ]))).toThrow('1 MiB')
  })
})

describe('action pad document validation', () => {
  it.each([
    [{ ...inputButton, label: 2 }, 'label'],
    [{ ...inputButton, label: '   ' }, 'label'],
    [{ ...inputButton, typo: true }, 'typo'],
    [{ ...inputButton, styles: { color: 'red' } }, 'styles.color'],
    [{ ...inputButton, styles: { size: '1/3' } }, 'styles.size'],
    [{ ...inputButton, tap: { type: 'input', nvimInput: 2, after: 'root' } }, 'tap.nvimInput'],
    [{ ...inputButton, tap: { type: 'input', nvimInput: '', after: 'root' } }, 'tap.nvimInput'],
    [{ ...inputButton, tap: { type: 'input', nvimInput: 'x', after: 'back' } }, 'tap.after'],
    [{ ...inputButton, tap: { type: 'input', nvimInput: 'x', menuId: 'home', after: 'root' } }, 'tap.menuId'],
    [{ ...inputButton, tap: { type: 'back', nvimInput: 'x', after: 'root' } }, 'tap.nvimInput'],
    [{ ...inputButton, tap: { type: 'shell', after: 'root' } }, 'tap.type'],
    [{ id: 'empty', label: 'Empty' }, 'tap']
  ])('returns a specific path for an invalid button (%s)', (button, suffix) => {
    const value = candidateWithButton(button)
    const issues = validateActionPadConfig(value)

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `menus[0].groups[0].buttons[0].${suffix}` })
    ]))
    expect(() => parseActionPadConfig(JSON.stringify(value))).toThrow(ActionPadConfigError)
  })

  it('requires a supported schema version and a root that exists', () => {
    expect(validateActionPadConfig({ ...config(), version: 2 })).toEqual([
      expect.objectContaining({ path: 'version' })
    ])
    expect(validateActionPadConfig({ ...config(), rootMenuId: 'missing' })).toEqual([
      expect.objectContaining({ path: 'rootMenuId', message: 'Missing action menu definition: missing' })
    ])
    expect(validateActionPadConfig({ ...config(), extra: 'typo' })).toEqual([
      expect.objectContaining({ path: 'extra' })
    ])
  })

  it('scopes identifier uniqueness to menus, groups within a menu and buttons within a group', () => {
    const home = config().menus[0]!
    expect(validateActionPadConfig({ ...config(), menus: [home, home] })).toEqual([
      expect.objectContaining({ path: 'menus[1].id' })
    ])
    expect(validateActionPadConfig({ ...config(), menus: [{ ...home, groups: [home.groups[0], home.groups[0]] }] })).toEqual([
      expect.objectContaining({ path: 'menus[0].groups[1].id' })
    ])
    expect(validateActionPadConfig(config([inputButton, inputButton]))).toEqual([
      expect.objectContaining({ path: 'menus[0].groups[0].buttons[1].id' })
    ])
    expect(validateActionPadConfig({ ...config(), menus: [
      { ...home, groups: [...home.groups, { id: 'another', buttons: [inputButton] }] },
      { ...home, id: 'another' }
    ] })).toEqual([])
  })

  it('validates references and cycles in unreachable menus and both gesture slots', () => {
    const missing = { id: 'orphan', label: 'Orphan', groups: [{ id: 'actions', buttons: [{
      id: 'hold', label: 'Hold', longPress: { type: 'menu', menuId: 'missing', after: 'stay' }
    }] }] }
    expect(validateActionPadConfig({ ...config(), menus: [...config().menus, missing] })).toEqual([
      expect.objectContaining({ path: 'menus[1].groups[0].buttons[0].longPress.menuId', message: 'Missing action menu definition: missing' })
    ])
    const cycle = { ...missing, groups: [{ id: 'actions', buttons: [{
      id: 'hold', label: 'Hold', longPress: { type: 'menu', menuId: 'orphan', after: 'root' }
    }] }] }
    expect(validateActionPadConfig({ ...config(), menus: [...config().menus, cycle] })).toEqual([
      expect.objectContaining({ path: 'menus[1].groups[0].buttons[0].longPress.menuId', message: 'Cyclic action menu reference: orphan -> orphan' })
    ])
  })

  it('permits empty groups, unlinked menus and whitespace input without inventing interactions', () => {
    expect(validateActionPadConfig({ ...config(), menus: [
      ...config().menus,
      { id: 'empty', label: 'Empty', groups: [] },
      { id: 'group', label: 'Group', groups: [{ id: 'empty', buttons: [] }] }
    ] })).toEqual([])
    expect(validateActionPadConfig(config([{ ...inputButton, tap: { type: 'input', nvimInput: ' ', after: 'stay' } }]))).toEqual([])
  })

  it('recovers structurally safe incomplete drafts without making them valid active configurations', () => {
    const draft = { version: 1, rootMenuId: '', menus: [
      { id: '', label: '', groups: [{ id: '', buttons: [{ id: '', label: '' }] }] },
      { id: '', label: '', groups: [] }
    ] }
    const brokenReference = config([{ ...inputButton, tap: { type: 'menu', menuId: 'missing', after: 'stay' } }])
    const cycle = config([{ ...inputButton, tap: { type: 'menu', menuId: 'home', after: 'stay' } }])

    for (const value of [draft, brokenReference, cycle]) {
      expect(isActionPadConfigShape(value)).toBe(true)
      expect(validateActionPadConfig(value).length).toBeGreaterThan(0)
    }
    for (const value of [null, [], { ...draft, menus: [null] }, candidateWithButton({ ...inputButton, styles: { size: 'wide' } })]) {
      expect(isActionPadConfigShape(value)).toBe(false)
    }
  })

  it('rejects oversized lists without traversing an unbounded stored draft', () => {
    const value = { ...config(), menus: Array.from({ length: 129 }, (_, index) => ({
      id: `menu-${index}`, label: 'Menu', groups: []
    })) }

    expect(validateActionPadConfig(value)).toEqual([
      expect.objectContaining({ path: 'menus', message: 'Must contain at most 128 items.' })
    ])
    expect(isActionPadConfigShape(value)).toBe(false)
  })
})
