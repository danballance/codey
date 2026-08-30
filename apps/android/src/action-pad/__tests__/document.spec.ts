import defaultYaml from '../default.yaml'
import { DEFAULT_ACTION_PAD_CONFIG } from '../config'
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
  id: 'input', label: 'Input', styles: { size: '1/2' },
  tap: { type: 'input', nvimInput: '<Esc>', after: 'root' }
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
    expect(resolveActionPadConfig(parseActionPadConfig(defaultYaml)).id).toBe(DEFAULT_ACTION_PAD_CONFIG.rootMenuId)
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
      ['home', 'ffe1e7af5487b51ac855182339cce696bc819e8dd12db72fa9c74e036c035c6d'],
      ['command', '8a4ba1d167a6a77b46b2f43afced7806f72ad0e96cef8999752be6f436dda8ef'],
      ['leader', 'e5bfc04f3305e6a1b51e47133adb07c2f458eb6a63fca9b816aab6725cf7dc87'],
      ['motions', '45b4cebeae35790fb2118839fc5ad2f4ef465eb8e382cf564d2ea29fb2ab19f0'],
      ['text-objects', '92e25dab00be6afddeebc5d03c9bc76b7697de8df23c4f431b8e768f6c4f8ca3'],
      ['up-navigation', '27e5424635e74175666eef165ff0043afd4fe60c8a79690cc243d1f0fe202708'],
      ['down-navigation', '25cd67a174db8cb412a7793f21ae32b16b3a2d4bf8ca985647a32a6341c65e57'],
      ['search', '0170c59a3f5a4eb9406b25f8692b1132637459d5a8560e4e3138e675b5082e46'],
      ['window', 'bcf20a092c04d28f4618814eeaff75f46a5d8bad521963952e98cff64259f0af'],
      ['code', 'b3b3fcadbee7daf4e7c4aec090076b622c41f2fee5fee685cd8bbd9cc8296167'],
      ['yank', '6cc2db7425c8978a7fde6405aa964d30882a0dfe0fa7458b767849792ed2ca05'],
      ['delete', '97b27baf8be48c272ae1bf114d6938a098ba882fa2cb7c9b95df2a7b60e3b056']
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
      { id: 'hold', label: '⬆ 😀 \uf07c \u{f01c9}', styles: { size: '1/2' }, longPress: { type: 'input', nvimInput: '{}: # \\ 2', after: 'root' } },
      { id: 'back', label: 'Back', styles: { size: '1/2' }, tap: { type: 'back', after: 'stay' } }
    ])
    const text = serializeActionPadConfig(value)

    expect(text).toContain("label: '2'")
    expect(parseActionPadConfig(text)).toEqual(value)
    expect(serializeActionPadConfig(parseActionPadConfig(text))).toBe(text)
  })

  it('round trips styled label runs without merging boundaries or changing typography', () => {
    const label = [
      { text: '\uf07c ', fontSize: 22, bold: false, color: '#9ece6a' },
      { text: 'Save', fontSize: 15, bold: true, color: '#E0AF68' },
      { text: ' ', fontSize: 10, bold: false },
      { text: 'all 😀 \u{f01c9}', fontSize: 12, bold: false },
      { text: '!', fontSize: 18, bold: true }
    ] as const
    const value = config([{ ...inputButton, label }])

    const source = serializeActionPadConfig(value)
    const parsed = parseActionPadConfig(source)
    const resolved = resolveActionPadConfig(parsed)

    expect(source).toContain('fontSize: 22')
    expect(source).toContain("color: '#9ece6a'")
    expect(parsed).toEqual(value)
    expect(parsed.menus[0]?.groups[0]?.buttons[0]?.label).toEqual(label)
    expect(resolved.groups[0]?.buttons[0]?.label).toEqual(label)
    expect(serializeActionPadConfig(parsed)).toBe(source)
  })

  it('round trips every button size, appearances and optional colour overrides', () => {
    const sizes = ['1/1', '1/2', '1/3', '1/4', '1/5'] as const
    const value = config(sizes.map((size, index) => ({
      ...inputButton,
      id: `button-${index}`,
      styles: index === 0
        ? { size, appearance: 'outline' as const, backgroundColor: 'transparent', outlineColor: '#ABCDEF' }
        : { size }
    })))

    const source = serializeActionPadConfig(value)
    expect(parseActionPadConfig(source)).toEqual(value)
    expect(source).toContain("appearance: 'outline'")
    expect(source).toContain("backgroundColor: 'transparent'")
    expect(source).toContain("outlineColor: '#ABCDEF'")
  })

  it('keeps legacy labels as scalar strings when normalizing and serializing', () => {
    const source = serializeActionPadConfig(config())
    const parsed = parseActionPadConfig(source)

    expect(source).toContain("label: 'Input'")
    expect(typeof parsed.menus[0]?.groups[0]?.buttons[0]?.label).toBe('string')
    expect(serializeActionPadConfig(parsed)).toBe(source)
  })

  it('round trips group interactions without changing their destination IDs', () => {
    const value: ActionPadConfig = {
      version: 1,
      rootMenuId: 'home',
      menus: [
        {
          id: 'home', label: 'Home', groups: [{ id: 'actions', buttons: [{
            id: 'delete', label: 'Delete',
            styles: { size: '1/2' },
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
    const yaml = '# user comment\n' + JSON.stringify(config([{
      id: 'hold', label: 'Hold', styles: { size: '1/2' }, longPress: { type: 'back', after: 'root' }
    }]))
    const value = parseActionPadConfig(yaml)
    const normalized = serializeActionPadConfig(value)

    expect(normalized).not.toContain('# user comment')
    expect(normalized).not.toContain('tap:')
    expect(normalized).toContain("size: '1/2'")
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
    [{ id: 'missing-styles', label: 'Missing styles', tap: inputButton.tap }, 'styles'],
    [{ ...inputButton, styles: {} }, 'styles.size'],
    [{ ...inputButton, styles: { color: 'red' } }, 'styles.color'],
    [{ ...inputButton, styles: { size: '2/3' } }, 'styles.size'],
    [{ ...inputButton, tap: { type: 'input', nvimInput: 2, after: 'root' } }, 'tap.nvimInput'],
    [{ ...inputButton, tap: { type: 'input', nvimInput: '', after: 'root' } }, 'tap.nvimInput'],
    [{ ...inputButton, tap: { type: 'input', nvimInput: 'x', after: 'back' } }, 'tap.after'],
    [{ ...inputButton, tap: { type: 'input', nvimInput: 'x', menuId: 'home', after: 'root' } }, 'tap.menuId'],
    [{ ...inputButton, tap: { type: 'input', nvimInput: 'x', groupId: 'actions', after: 'root' } }, 'tap.groupId'],
    [{ ...inputButton, tap: { type: 'menu', menuId: 'child', groupId: 'actions', after: 'root' } }, 'tap.groupId'],
    [{ ...inputButton, tap: { type: 'group', menuId: 'child', groupId: 'actions', nvimInput: 'x', after: 'root' } }, 'tap.nvimInput'],
    [{ ...inputButton, tap: { type: 'back', nvimInput: 'x', after: 'root' } }, 'tap.nvimInput'],
    [{ ...inputButton, tap: { type: 'shell', after: 'root' } }, 'tap.type'],
    [{ id: 'empty', label: 'Empty', styles: { size: '1/2' } }, 'tap']
  ])('returns a specific path for an invalid button (%s)', (button, suffix) => {
    const value = candidateWithButton(button)
    const issues = validateActionPadConfig(value)

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `menus[0].groups[0].buttons[0].${suffix}` })
    ]))
    expect(() => parseActionPadConfig(JSON.stringify(value))).toThrow(ActionPadConfigError)
  })

  it.each([
    [[], 'label'],
    [[{ text: 'Text', fontSize: 15, bold: false, italic: true }], 'label[0].italic'],
    [[{ text: 'Text', fontSize: 13, bold: false }], 'label[0].fontSize'],
    [[{ text: 'Text', fontSize: 15, bold: 'false' }], 'label[0].bold'],
    [[{ text: 2, fontSize: 15, bold: false }], 'label[0].text'],
    [[{ text: '', fontSize: 15, bold: false }], 'label[0].text'],
    [[{ text: '  ', fontSize: 15, bold: false }], 'label'],
    [Array.from({ length: 65 }, () => ({ text: 'x', fontSize: 15, bold: false })), 'label']
  ])('rejects an invalid styled label at its exact run path (%s)', (label, suffix) => {
    const value = candidateWithButton({ ...inputButton, label })

    expect(validateActionPadConfig(value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `menus[0].groups[0].buttons[0].${suffix}` })
    ]))
    expect(() => parseActionPadConfig(JSON.stringify(value))).toThrow(ActionPadConfigError)
  })

  it.each([
    [{ ...inputButton, styles: { size: '1/2', appearance: 'raised' } }, 'styles.appearance'],
    [{ ...inputButton, styles: { size: '1/2', backgroundColor: '#fff' } }, 'styles.backgroundColor'],
    [{ ...inputButton, styles: { size: '1/2', outlineColor: '#12345678' } }, 'styles.outlineColor'],
    [{ ...inputButton, styles: { size: '1/2', backgroundColor: 'red' } }, 'styles.backgroundColor'],
    [{ ...inputButton, label: [{ text: 'Text', fontSize: 15, bold: false, color: 'transparent' }] }, 'label[0].color'],
    [{ ...inputButton, label: [{ text: 'Text', fontSize: 15, bold: false, color: '#abc' }] }, 'label[0].color']
  ])('rejects invalid appearance and colour values at %s', (button, suffix) => {
    const value = candidateWithButton(button)
    expect(validateActionPadConfig(value)).toContainEqual(expect.objectContaining({
      path: `menus[0].groups[0].buttons[0].${suffix}`
    }))
    expect(() => serializeActionPadConfig(value as ActionPadConfig)).toThrow(ActionPadConfigError)
  })

  it('allows whitespace separator runs when the combined rich label has visible text', () => {
    expect(validateActionPadConfig(config([{
      ...inputButton,
      label: [
        { text: 'Save', fontSize: 15, bold: true },
        { text: '   ', fontSize: 10, bold: false },
        { text: 'all', fontSize: 15, bold: false }
      ]
    }]))).toEqual([])
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
      id: 'hold', label: 'Hold', styles: { size: '1/2' },
      longPress: { type: 'menu', menuId: 'missing', after: 'stay' }
    }] }] }
    expect(validateActionPadConfig({ ...config(), menus: [...config().menus, missing] })).toEqual([
      expect.objectContaining({ path: 'menus[1].groups[0].buttons[0].longPress.menuId', message: 'Missing action menu definition: missing' })
    ])
    const cycle = { ...missing, groups: [{ id: 'actions', buttons: [{
      id: 'hold', label: 'Hold', styles: { size: '1/2' },
      longPress: { type: 'menu', menuId: 'orphan', after: 'root' }
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
            styles: { size: '1/2' },
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
            styles: { size: '1/2' },
            tap: { type: 'group', menuId: 'child', groupId: 'options', after: 'stay' }
          }] }]
        },
        {
          id: 'child', label: 'Child', groups: [{ id: 'options', buttons: [{
            id: 'home', label: 'Home', styles: { size: '1/2' },
            tap: { type: 'menu', menuId: 'home', after: 'stay' }
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
      { id: '', label: '', groups: [{ id: '', buttons: [{ id: '', label: '', styles: { size: '1/2' } }] }] },
      { id: '', label: '', groups: [] }
    ] }
    const brokenReference = config([{ ...inputButton, tap: { type: 'menu', menuId: 'missing', after: 'stay' } }])
    const cycle = config([{ ...inputButton, tap: { type: 'menu', menuId: 'home', after: 'stay' } }])
    const incompleteGroup = config([{
      ...inputButton,
      tap: { type: 'group', menuId: '', groupId: '', after: 'stay' }
    }])
    const missingStyles = {
      id: inputButton.id,
      label: inputButton.label,
      tap: inputButton.tap
    }
    const emptyRunDraft = config([{
      ...inputButton,
      label: [{ text: '', fontSize: 15, bold: false }]
    }])
    const incompleteColorDrafts = [
      config([{ ...inputButton, styles: { size: '1/2', backgroundColor: '#' } }]),
      config([{ ...inputButton, styles: { size: '1/2', outlineColor: '#123' } }]),
      config([{ ...inputButton, label: [{ text: 'Text', fontSize: 15, bold: false, color: '' }] }])
    ]

    for (const value of [draft, brokenReference, cycle, incompleteGroup, emptyRunDraft, ...incompleteColorDrafts]) {
      expect(isActionPadConfigShape(value)).toBe(true)
      expect(validateActionPadConfig(value).length).toBeGreaterThan(0)
    }
    for (const value of [
      null,
      [],
      { ...draft, menus: [null] },
      candidateWithButton(missingStyles),
      candidateWithButton({ ...inputButton, label: [] }),
      candidateWithButton({ ...inputButton, styles: {} }),
      candidateWithButton({ ...inputButton, styles: { size: 'wide' } })
    ]) {
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

  it('counts styled label runs toward the total configuration complexity limit', () => {
    const home = config().menus[0]!
    const value = {
      ...config(),
      menus: [{
        ...home,
        groups: [{
          id: 'actions',
          buttons: Array.from({ length: 910 }, (_, index) => ({
            ...inputButton,
            id: `input-${index}`,
            label: Array.from({ length: 10 }, () => ({ text: 'x', fontSize: 15, bold: false }))
          }))
        }]
      }]
    }

    expect(validateActionPadConfig(value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('label runs') })
    ]))
    expect(isActionPadConfigShape(value)).toBe(false)
  })
})
