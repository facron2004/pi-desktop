import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanAppEnv, parseSetupArgs } from '../src/main/setup/args'

test('in-app update flags always enable silent mode even without /S', () => {
  const fromAppUpdate = parseSetupArgs([
    '--updated',
    '/S',
    '--force-run',
    '--install-dir=C:\\Users\\Facron\\AppData\\Local\\Programs\\Pi Desktop'
  ])
  assert.equal(fromAppUpdate.silent, true)
  assert.equal(fromAppUpdate.updated, true)
  assert.equal(fromAppUpdate.forceRun, true)
  assert.equal(fromAppUpdate.uninstall, false)
  assert.equal(fromAppUpdate.installDir, 'C:\\Users\\Facron\\AppData\\Local\\Programs\\Pi Desktop')

  // Even if NSIS or a caller drops /S, --updated or --force-run stays headless.
  assert.equal(parseSetupArgs(['--updated']).silent, true)
  assert.equal(parseSetupArgs(['--force-run']).silent, true)
})

test('strips surrounding quotes around --install-dir', () => {
  const parsed = parseSetupArgs(['--updated', '--install-dir="D:\\My Apps\\Pi Desktop"'])
  assert.equal(parsed.installDir, 'D:\\My Apps\\Pi Desktop')
})

test('interactive installer and uninstaller stay non-silent by default', () => {
  const fresh = parseSetupArgs(['--setup'])
  assert.equal(fresh.silent, false)
  assert.equal(fresh.uninstall, false)
  assert.equal(fresh.updated, false)

  const uninstallUi = parseSetupArgs(['--uninstall'])
  assert.equal(uninstallUi.silent, false)
  assert.equal(uninstallUi.uninstall, true)

  const quietUninstall = parseSetupArgs(['--uninstall', '--silent'])
  assert.equal(quietUninstall.silent, true)
  assert.equal(quietUninstall.uninstall, true)
})

test('cleanAppEnv strips setup and portable self-extractor markers while preserving normal env', () => {
  const cleaned = cleanAppEnv({
    PATH: 'C:\\Windows',
    LOCALAPPDATA: 'C:\\Users\\Facron\\AppData\\Local',
    PORTABLE_EXECUTABLE_FILE: 'C:\\Temp\\Pi Desktop-0.11.5-x64.exe',
    PORTABLE_EXECUTABLE_DIR: 'C:\\Temp',
    PORTABLE_EXECUTABLE_APP_FILENAME: 'Pi Desktop',
    PI_SETUP: '1',
    PI_SETUP_SOURCE: 'C:\\Temp\\staged'
  })

  assert.equal(cleaned.PATH, 'C:\\Windows')
  assert.equal(cleaned.LOCALAPPDATA, 'C:\\Users\\Facron\\AppData\\Local')
  assert.equal('PORTABLE_EXECUTABLE_FILE' in cleaned, false)
  assert.equal('PORTABLE_EXECUTABLE_DIR' in cleaned, false)
  assert.equal('PORTABLE_EXECUTABLE_APP_FILENAME' in cleaned, false)
  assert.equal('PI_SETUP' in cleaned, false)
  assert.equal('PI_SETUP_SOURCE' in cleaned, false)
})
