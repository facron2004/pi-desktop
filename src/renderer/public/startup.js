// Build the mark before the application bundle is evaluated.
(() => {
  const mask = document.getElementById('startup-matrix')
  const tiles = document.createDocumentFragment()
  const step = 886 / 16
  const inset = step * 0.09
  for (let row = 0; row < 16; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      const tile = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      tile.setAttribute('x', String(column * step + inset))
      tile.setAttribute('y', String(row * step + inset))
      tile.setAttribute('width', String(step - inset * 2))
      tile.setAttribute('height', String(step - inset * 2))
      tile.setAttribute('fill', 'white')
      tile.setAttribute('class', 'startup-screen__tile')
      tile.style.animationDelay = `${-(row + column) * 52 - (row % 3) * 90}ms`
      tiles.append(tile)
    }
  }
  mask.append(tiles)

  // Animation frames can wait for the pending app module in a hidden window.
  // The loading screen's markup and styles are already ready to be shown.
  window.pi.app.startupReady()
})()
