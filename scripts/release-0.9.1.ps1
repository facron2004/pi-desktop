$ErrorActionPreference = 'Stop'
$root = 'E:\Program\Pi Desktop'
$release = Join-Path $root 'release'

Push-Location $root
try {
  $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
  if ($version -ne '0.9.1') { throw "package.json is $version, expected 0.9.1" }

  Write-Output "== building $version =="
  & npm run dist
  if ($LASTEXITCODE -ne 0) { throw "npm run dist failed with $LASTEXITCODE" }

  $unpacked = Join-Path $release 'win-unpacked'
  if (-not (Test-Path $unpacked)) { throw "missing $unpacked" }

  $zip = Join-Path $release "Pi Desktop-$version-portable-x64.zip"
  if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
  Write-Output '== zipping the portable copy =='
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $unpacked, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

  $files = @(
    "Pi Desktop-$version.exe",
    "Pi Desktop-$version-x64.exe",
    "Pi Desktop-$version-arm64.exe",
    "Pi Desktop-$version-portable-x64.zip"
  )
  $lines = foreach ($name in $files) {
    $path = Join-Path $release $name
    if (-not (Test-Path $path)) { throw "missing $path" }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  " + ($name -replace ' ', '.')
  }
  $sums = Join-Path $release 'SHA256SUMS.txt'
  Set-Content -LiteralPath $sums -Value $lines -Encoding ascii
  Write-Output '== checksums =='
  Get-Content -LiteralPath $sums
} finally {
  Pop-Location
}
