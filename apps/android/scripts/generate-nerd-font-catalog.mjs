#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const NERD_FONTS_VERSION = '3.4.0'
export const NERD_FONT_GLYPHNAMES_URL =
  'https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/glyphnames.json'
export const NERD_FONT_GLYPHNAMES_SHA256 =
  'e2d10d23f5bff0bd6f0676e9b01d9789fcdc656de7b498a2955c27716ea4439c'

const EXPECTED_NAME_COUNT = 10_764
const EXPECTED_GLYPH_COUNT = 10_386
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(SCRIPT_DIRECTORY, '../src/fonts/nerd-font-glyphs.json')

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function buildCatalog(source) {
  const checksum = createHash('sha256').update(source).digest('hex')
  if (checksum !== NERD_FONT_GLYPHNAMES_SHA256) {
    throw new Error(
      `glyphnames.json SHA-256 mismatch: expected ${NERD_FONT_GLYPHNAMES_SHA256}, received ${checksum}`
    )
  }

  let document
  try {
    document = JSON.parse(source.toString('utf8'))
  } catch (error) {
    throw new Error('glyphnames.json is not valid JSON', { cause: error })
  }

  if (!isRecord(document) || !isRecord(document.METADATA)) {
    throw new Error('glyphnames.json must contain a METADATA object')
  }
  if (document.METADATA.version !== NERD_FONTS_VERSION) {
    throw new Error(
      `glyphnames.json version mismatch: expected ${NERD_FONTS_VERSION}, received ${String(document.METADATA.version)}`
    )
  }

  const entries = Object.entries(document)
    .filter(([name]) => name !== 'METADATA')
    .sort(([left], [right]) => compareStrings(left, right))
  if (entries.length !== EXPECTED_NAME_COUNT) {
    throw new Error(
      `glyph name count mismatch: expected ${EXPECTED_NAME_COUNT}, received ${entries.length}`
    )
  }

  const groups = new Map()
  for (const [name, value] of entries) {
    if (name.length === 0 || !isRecord(value)) {
      throw new Error(`invalid glyph row: ${name || '<empty name>'}`)
    }
    if (typeof value.char !== 'string' || [...value.char].length !== 1) {
      throw new Error(`glyph ${name} must contain exactly one Unicode scalar`)
    }
    if (typeof value.code !== 'string' || !/^[0-9a-f]+$/i.test(value.code)) {
      throw new Error(`glyph ${name} has an invalid hexadecimal code point`)
    }

    const codepoint = Number.parseInt(value.code, 16)
    if (value.char.codePointAt(0) !== codepoint) {
      throw new Error(`glyph ${name} character does not match code point ${value.code}`)
    }

    const group = groups.get(codepoint)
    if (group === undefined) {
      groups.set(codepoint, { glyph: value.char, names: [name] })
    } else {
      group.names.push(name)
    }
  }

  if (groups.size !== EXPECTED_GLYPH_COUNT) {
    throw new Error(
      `unique glyph count mismatch: expected ${EXPECTED_GLYPH_COUNT}, received ${groups.size}`
    )
  }

  return [...groups.values()]
    .map(({ glyph, names }) => [glyph, ...names])
    .sort((left, right) => compareStrings(left[1], right[1]))
}

async function loadSource(localPath) {
  if (localPath !== undefined) {
    return readFile(path.resolve(process.cwd(), localPath))
  }

  const response = await fetch(NERD_FONT_GLYPHNAMES_URL)
  if (!response.ok) {
    throw new Error(
      `failed to download glyphnames.json: ${response.status} ${response.statusText}`
    )
  }
  return Buffer.from(await response.arrayBuffer())
}

export async function generateCatalog(localPath) {
  const source = await loadSource(localPath)
  const catalog = buildCatalog(source)
  await writeFile(OUTPUT_PATH, `${JSON.stringify(catalog)}\n`, 'utf8')
  return catalog
}

async function main() {
  const arguments_ = process.argv.slice(2)
  if (arguments_[0] === '--') {
    arguments_.shift()
  }
  if (arguments_.length > 1) {
    throw new Error('usage: generate-nerd-font-catalog.mjs [local-glyphnames.json]')
  }

  const catalog = await generateCatalog(arguments_[0])
  const aliasCount = catalog.reduce((count, row) => count + row.length - 2, 0)
  process.stdout.write(
    `Generated ${path.relative(process.cwd(), OUTPUT_PATH)} with ${catalog.length} glyphs and ${aliasCount} aliases.\n`
  )
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
