const theme = new URLSearchParams(window.location.search).get('piDesktopTheme')

if (theme === 'light' || theme === 'dark') {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}
