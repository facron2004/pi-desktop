<#
.SYNOPSIS
  把 electron-builder 的产物整理成发布资产。

.DESCRIPTION
  `npm run dist` 产出的是 `release/Pi Desktop-<版本>-x64.exe` 这种带空格的文件名，
  发布页上的历史名字是不带空格的 `Pi.Desktop-<版本>-x64.exe`。这里做三件事：
  把解包目录压成免安装版 zip、把文件改名成发布用的名字、算 SHA-256 校验值。

  本地和 CI 跑的是同一份脚本，所以两边的产物完全一致。

.EXAMPLE
  pwsh -File scripts/prepare-release-assets.ps1 -Version 0.11.7 -OutDir release/publish
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$ReleaseDir = 'release',
  [string]$OutDir = 'release/publish'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root $ReleaseDir
$out = Join-Path $root $OutDir

if (-not (Test-Path -LiteralPath $release)) {
  throw "找不到 $release，先跑 npm run dist"
}
if (Test-Path -LiteralPath $out) {
  Remove-Item -LiteralPath $out -Recurse -Force
}
New-Item -ItemType Directory -Path $out | Out-Null

# 免安装版：解包出来的目录压成一个 zip，可执行文件放在压缩包根目录，
# 解压后直接运行 Pi Desktop.exe。
$unpacked = Join-Path $release 'win-unpacked'
if (-not (Test-Path -LiteralPath $unpacked)) {
  throw "找不到 $unpacked，先跑 npm run dist"
}
if (-not ('System.IO.Compression.ZipFile' -as [type])) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
}
$zipSource = Join-Path $release "Pi Desktop-$Version-portable-x64.zip"
if (Test-Path -LiteralPath $zipSource) {
  Remove-Item -LiteralPath $zipSource -Force
}
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $unpacked, $zipSource, [System.IO.Compression.CompressionLevel]::Optimal, $false)

# 发布页上的名字。通用安装版由 electron-builder 在多架构时一并产出，
# 少了它只是这一份不发布，README 的链接需要跟着改。
$assets = [ordered]@{
  "Pi Desktop-$Version.exe"       = "Pi.Desktop-$Version.exe"
  "Pi Desktop-$Version-x64.exe"   = "Pi.Desktop-$Version-x64.exe"
  "Pi Desktop-$Version-arm64.exe" = "Pi.Desktop-$Version-arm64.exe"
  "Pi Desktop-$Version-portable-x64.zip" = "Pi.Desktop-$Version-portable-x64.zip"
}

$published = @()
foreach ($entry in $assets.GetEnumerator()) {
  $source = Join-Path $release $entry.Key
  if (-not (Test-Path -LiteralPath $source)) {
    if ($entry.Key -eq "Pi Desktop-$Version.exe") {
      Write-Warning "这次没有通用安装版（$($entry.Key)），发布页会少一个下载项"
      continue
    }
    throw "缺少发布产物 $source"
  }
  $target = Join-Path $out $entry.Value
  Copy-Item -LiteralPath $source -Destination $target -Force
  $published += $target
}

# 校验值跟发布页上的文件名一致。
$lines = foreach ($file in $published) {
  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  " + (Split-Path -Leaf $file)
}
$sums = Join-Path $out 'SHA256SUMS.txt'
Set-Content -LiteralPath $sums -Value $lines -Encoding ascii

Write-Output "== 发布产物 =="
Get-ChildItem -LiteralPath $out -File | ForEach-Object {
  '{0,-44} {1,10:N1} MB' -f $_.Name, ($_.Length / 1MB)
}
