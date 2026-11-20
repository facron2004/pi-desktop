/**
 * Two applications share one executable: the normal Pi Desktop window, and the
 * installer/uninstaller that must run before (or after) an installation
 * exists. The choice is made before any startup work, because the normal entry
 * takes a single-instance lock, secures user data and starts tray services that
 * a setup process must not touch.
 */
const args = process.argv.slice(1)
const setupMode =
  args.includes('--setup') ||
  args.includes('--uninstall') ||
  process.env.PI_SETUP === '1' ||
  Boolean(process.env.PORTABLE_EXECUTABLE_FILE)

if (setupMode) {
  void import('./setup/main')
} else {
  void import('./app-main')
}
