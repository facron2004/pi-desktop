# Pi Desktop app icon

The application icon is the three-colour geometric Pi mark supplied by the
project owner (`三色几何派标志`). The blue `#002090`, coral `#CF4F3D` and golden
`#E4B135` shapes are kept exactly as drawn; the transparent canvas is the only
background, so the mark reads on both light and dark taskbars.

`icon-geometric.png` is the 1254×1254 master. `icon-geometric.ico` holds PNG frames at
16, 24, 32, 48, 64, 128 and 256 pixels for Windows (the 32px frame is what the
tray reads). `icon.png` is the 512×512 copy used by electron-builder on the
other platforms. `scripts/make-icon.mjs` regenerates `icon.png` from the master;
the .ico is built from the same master so every size keeps the same geometry.
