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
    expect(groups).toHaveLength(30)
    expect(groups.flatMap((group) => group.buttons)).toHaveLength(86)
    expect(ACTION_PAD_MENU.id).toBe(DEFAULT_ACTION_PAD_CONFIG.rootMenuId)
    expect(resolveActionPadConfig(parseActionPadConfig(defaultYaml))).toEqual(ACTION_PAD_MENU)
    expect(parseActionPadConfig(serializeActionPadConfig(DEFAULT_ACTION_PAD_CONFIG))).toEqual(DEFAULT_ACTION_PAD_CONFIG)
  })

  it('matches every starter menu field and ordering against the frozen group-action baseline', () => {
    // SHA-256 values were regenerated for the reviewed group-scoped starter redesign.
    // SHA-256 covers UTF-8 JSON with recursively sorted object keys; array order,
    // exact strings and omitted/present optional fields are preserved. Deliberate
    // starter changes require an explicitly reviewed update to this baseline.
    expect(DEFAULT_ACTION_PAD_CONFIG).toMatchObject({ version: 1, rootMenuId: 'home' })
    expect(DEFAULT_ACTION_PAD_CONFIG.menus.map((menu) => [
      menu.id,
      createHash('sha256').update(JSON.stringify(canonicalValue(menu)), 'utf8').digest('hex')
    ])).toEqual([
      ['home', '2d5da93ae7fed7d67e0a0a86fdfe28f7df24c6dff971c61cddc2f4c1a5a02a1a'],
      ['command', '5dbb45f334d1b984364e295869fec236710dcff74d82e9745a5fd5d7f2d85b99'],
      ['leader', 'e1d1d2526d1c3a8c5a88dffe970b0da0818e31c24259a45c5d83dd1d158c3d9c'],
      ['motions', '16a4ca6e395d3470a0819726b88db8b343e2aa8fd0bd3083d93ac203ba8c0226'],
      ['text-objects', 'fbc671fff3163f643ee74876f3834d51148a3ac50cb879cd940d7063f034f081'],
      ['up-navigation', '013cf3c74d05b01f793fa30fb0beb411da710ebcacc227915fc6fff5ed79f47e'],
      ['down-navigation', '63970675b9cd721a34dccb5838dbc30ccaf9c3c85900f3d3f6ead517c75f6697'],
      ['search', '35134ecdb52130bde3a4d9b1558ee5d9cff1495b9b4073648ec3f1037fad459c'],
      ['window', 'f038cfc67aadc61760fb6fac02c33e52e9109b3ec791224dd31add67beff8c5b'],
      ['code', '19181a40404e1a9baf087945800f6d91030fbdff667f6e2613cd5f2976c6b1c0'],
      ['yank', '41c05672f76daef01ea7caf249e3c8f7751deef01f7ada94d8130f677d8fd07f'],
      ['delete', '662b5ff932c3719f6186228f73cc76f6770d13bd7358668ad1a82da50046aa1a']
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
      { id: 'hold', label: '⬆ 😀 \uf07c \u{f01c9}', styles: {}, longPress: { type: 'input', nvimInput: '{}: # \\ 2', after: 'root' } },
      { id: 'back', label: 'Back', tap: { type: 'back', after: 'stay' } }
    ])
    const text = serializeActionPadConfig(value)

    expect(text).toContain("label: '2'")
    expect(parseActionPadConfig(text)).toEqual(value)
    expect(serializeActionPadConfig(parseActionPadConfig(text))).toBe(text)
  })

  it('round trips group interactions without changing their destination IDs', () => {
    const value: ActionPadConfig = {
      version: 1,
      rootMenuId: 'home',
      menus: [
        {
          id: 'home', label: 'Home', groups: [{ id: 'actions', buttons: [{
            id: 'delete', label: 'Delete',
            tap: { type: 'group', menuId: 'delete', groupId: 'options', after: 'stay' }
          }] }]
        },
        {
          id: 'delete', label: 'Delete', groups: [{ id: 'options', buttons: [inputButton] }]
        }
      ]
    }

    const source = serializeActionPadConfig(value)

    expect(source).toContain("type: 'group'")
    expect(parseActionPadConfig(source)).toEqual(value)
    expect(serializeActionPadConfig(parseActionPadConfig(source))).toBe(source)
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
    [{ ...inputButton, tap: { type: 'input', nvimInput: 'x', groupId: 'actions', after: 'root' } }, 'tap.groupId'],
    [{ ...inputButton, tap: { type: 'menu', menuId: 'child', groupId: 'actions', after: 'root' } }, 'tap.groupId'],
    [{ ...inputButton, tap: { type: 'group', menuId: 'child', groupId: 'actions', nvimInput: 'x', after: 'root' } }, 'tap.nvimInput'],
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

  it('validates both group destination IDs and prohibits same-menu group links', () => {
    const target = { id: 'target', label: 'Target', groups: [{ id: 'options', buttons: [inputButton] }] }
    const linked = (menuId: string, groupId: string): ActionPadConfig => ({
      ...config(),
      menus: [
        {
          ...config().menus[0]!,
          groups: [{ id: 'actions', buttons: [{
            id: 'open', label: 'Open',
            tap: { type: 'group', menuId, groupId, after: 'stay' }
          }] }]
        },
        target
      ]
    })

    expect(validateActionPadConfig(linked('missing', 'options'))).toEqual([
      expect.objectContaining({
        path: 'menus[0].groups[0].buttons[0].tap.menuId',
        message: 'Missing action menu definition: missing'
      })
    ])
    expect(validateActionPadConfig(linked('target', 'missing'))).toEqual([
      expect.objectContaining({
        path: 'menus[0].groups[0].buttons[0].tap.groupId',
        message: 'Missing action group definition: target/missing'
      })
    ])
    expect(validateActionPadConfig(linked('home', 'actions'))).toEqual([
      expect.objectContaining({
        path: 'menus[0].groups[0].buttons[0].tap.menuId',
        message: 'Group interactions must target a different menu.'
      })
    ])
  })

  it('rejects cycles made from a mixture of full-menu and group links', () => {
    const value: ActionPadConfig = {
      version: 1,
      rootMenuId: 'home',
      menus: [
        {
          id: 'home', label: 'Home', groups: [{ id: 'actions', buttons: [{
            id: 'cluster', label: 'Cluster',
            tap: { type: 'group', menuId: 'child', groupId: 'options', after: 'stay' }
          }] }]
        },
        {
          id: 'child', label: 'Child', groups: [{ id: 'options', buttons: [{
            id: 'home', label: 'Home', tap: { type: 'menu', menuId: 'home', after: 'stay' }
          }] }]
        }
      ]
    }

    expect(validateActionPadConfig(value)).toEqual([
      expect.objectContaining({
        path: 'menus[1].groups[0].buttons[0].tap.menuId',
        message: 'Cyclic action menu/group reference: home -> child -> home'
      })
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
    const incompleteGroup = config([{
      ...inputButton,
      tap: { type: 'group', menuId: '', groupId: '', after: 'stay' }
    }])

    for (const value of [draft, brokenReference, cycle, incompleteGroup]) {
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
