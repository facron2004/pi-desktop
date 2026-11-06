$ErrorActionPreference = 'Stop'
$root = 'E:\Program\Pi Desktop'
$release = Join-Path $root 'release'

Push-Location $root
try {
  # The version comes from package.json, so a bump is the only edit needed.
  $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
  if ($version -ne '0.9.0') { throw "package.json is $version, expected 0.9.0" }

  Write-Output "== building $version =="
  & npm run dist
  if ($LASTEXITCODE -ne 0) { throw "npm run dist failed with $LASTEXITCODE" }

  $unpacked = Join-Path $release 'win-unpacked'
  if (-not (Test-Path $unpacked)) { throw "missing $unpacked" }

  # The portable copy is the unpacked folder as it stands: the executable sits
  # at the root of the archive, so it can be started straight from a stick.
  $zip = Join-Path $release "Pi Desktop-$version-portable-x64.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Write-Output "== zipping the portable copy =="
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $unpacked, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

  # The published names drop the space, so the checksums match what a reader
  # downloads from the release page.
  $files = @(
    "Pi Desktop-$version.exe",
    "Pi Desktop-$version-x64.exe",
    "Pi Desktop-$version-arm64.exe",
    "Pi Desktop-$version-portable-x64.zip"
  )
  $lines = foreach ($name in $files) {
    $path = Join-Path $release $name
    if (-not (Test-Path $path)) { throw "missing $path" }
    $hash = (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  " + ($name -replace ' ', '.')
  }
  $sums = Join-Path $release 'SHA256SUMS.txt'
  Set-Content -Path $sums -Value $lines -Encoding ascii
  Write-Output "== checksums =="
  Get-Content $sums
} finally {
  Pop-Location
}
