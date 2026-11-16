# BrosAi installer for Windows
# Downloads the latest release binary and adds it to your user PATH.
$ErrorActionPreference = "Stop"

$repo = "saonbd1/brosai-cli"
$installDir = Join-Path $env:LOCALAPPDATA "brosai"
$binPath = Join-Path $installDir "brosai.exe"

New-Item -ItemType Directory -Force -Path $installDir | Out-Null

# Resolve latest release tag
$tag = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name
Write-Host "Downloading brosai $tag ..."

Invoke-WebRequest -Uri "https://github.com/$repo/releases/download/$tag/brosai.exe" -OutFile $binPath

# Add to user PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$installDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
  Write-Host "Added $installDir to your user PATH (restart your terminal to pick it up)."
}

Write-Host "Installed: $binPath"
Write-Host "Run 'brosai' to start — the setup wizard will guide you on first run."
