import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizeFontFamilies, parseWindowsFontRegistry, querySystemFonts } from '../src/main/fonts'

test('PingFang installed under its Chinese registry name is offered as PingFang SC', () => {
  const fonts = canonicalizeFontFamilies([
    'Microsoft YaHei',
    '苹方',
    'Segoe UI'
  ])
  assert.equal(fonts.includes('PingFang SC'), true)
  assert.equal(fonts.includes('苹方'), false)
  assert.equal(fonts.includes('Microsoft YaHei'), true)
})

test('unweighted PingFang aliases share one family entry', () => {
  const fonts = canonicalizeFontFamilies(['苹方-简', 'PingFang', 'PingFang SC', 'Cascadia Code'])
  assert.deepEqual(fonts.filter((font) => /ping|苹方/i.test(font)), ['PingFang SC'])
  assert.equal(fonts.includes('Cascadia Code'), true)
})

test('PingFang preserves Regular, Medium and Bold while keeping TC and HK separate', () => {
  const fonts = canonicalizeFontFamilies([
    'PingFang SC Regular', 'PingFangSC-Medium', 'PingFang SC Bold', '.PingFang SC',
    '苹方 常规体', '苹方 粗体', '苹方-简体', 'PingFang TC', 'PingFang HK', '苹方-繁'
  ])
  assert.equal(fonts.filter((font) => font === 'PingFang SC').length, 1)
  assert.equal(fonts.includes('PingFang SC Regular'), true)
  assert.equal(fonts.includes('PingFang SC Medium'), true)
  assert.equal(fonts.includes('PingFang SC Bold'), true)
  assert.equal(fonts.filter((font) => font === 'PingFang SC Regular').length, 1)
  assert.equal(fonts.filter((font) => font === 'PingFang SC Medium').length, 1)
  assert.equal(fonts.filter((font) => font === 'PingFang SC Bold').length, 1)
  for (const font of ['PingFang TC', 'PingFang HK', '苹方-繁']) {
    assert.equal(fonts.includes(font), true)
  }
})

test('PingFang styles are offered only when present in the installed names', () => {
  const fonts = canonicalizeFontFamilies(['苹方 中黑体', 'PingFangSC-Medium'])
  assert.deepEqual(fonts, ['PingFang SC', 'PingFang SC Medium'])
})

test('UTF-16 registry exports preserve Chinese families and combine both install scopes', () => {
  const exported = Buffer.from([
    '\uFEFFWindows Registry Editor Version 5.00',
    '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts]',
    '"Microsoft YaHei & Microsoft YaHei UI (TrueType)"="msyh.ttc"',
    '"Microsoft YaHei Bold (TrueType)"="msyhbd.ttc"',
    '"方正舒体 (TrueType)"="FZSTK.TTF"',
    '[HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts]',
    '"苹方 常规体 (TrueType)"="PingFang Regular.ttf"',
    '"苹方 中黑体 (TrueType)"="PingFang Medium.ttf"',
    '"苹方 粗体 (TrueType)"="PingFang Bold.ttf"',
    '"@苹方 (TrueType)"="vertical.ttf"',
    '"A \\"Quoted\\" Family (OpenType)"="quoted.otf"',
    '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts\\Metadata]',
    '"CascadiaCode.ttf"=dword:00000001'
  ].join('\r\n'), 'utf16le').toString('utf16le')
  const fonts = parseWindowsFontRegistry(exported)
  for (const font of [
    'Microsoft YaHei', 'Microsoft YaHei UI', '方正舒体',
    'PingFang SC', 'PingFang SC Regular', 'PingFang SC Medium', 'PingFang SC Bold', 'A "Quoted" Family'
  ]) {
    assert.equal(fonts.includes(font), true, font)
  }
  assert.equal(fonts.length, 8)
})

test('concurrent font queries share the initial scan and the completed cache', async () => {
  const first = querySystemFonts()
  assert.equal(querySystemFonts(), first)
  const fonts = await first
  assert.ok(fonts.length > 0)
  assert.equal(querySystemFonts(), first)
  assert.equal(await querySystemFonts(), fonts)
})
