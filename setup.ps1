# Forefront Hub setup (Windows). Run by "Setup Forefront Hub.bat"; safe to run again any time.
$ErrorActionPreference = "Stop"
$Hub = $PSScriptRoot
Set-Location $Hub
Write-Host "Setting up Forefront Hub in $Hub" -ForegroundColor Cyan

function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") }

# ---- 1. Node.js
Step "Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Node.js..."
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements | Out-Host
  Refresh-Path
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js didn't install. Install it from https://nodejs.org (LTS) and run setup again." }
Write-Host "Node $(node -v)"

# ---- 2. The estimator (the forefront-estimate skill lives there)
Step "Estimator"
$Est = @($env:ESTIMATOR_DIR, "C:\Games\Estimator", (Join-Path (Split-Path $Hub) "Estimator"), (Join-Path (Split-Path $Hub) "estimator")) |
  Where-Object { $_ -and (Test-Path (Join-Path $_ "skill\forefront-estimate\SKILL.md")) } | Select-Object -First 1
if (-not $Est) { throw "Couldn't find the Estimator folder (looked in C:\Games\Estimator). Tell Claude where it is." }
Write-Host "Estimator: $Est"
if ((Test-Path (Join-Path $Est ".git")) -and (Get-Command git -ErrorAction SilentlyContinue)) {
  $env:GIT_TERMINAL_PROMPT = "0"
  try { & git -C $Est pull --ff-only --quiet *> $null } catch { Write-Host "Couldn't update the estimator (offline?); carrying on." }
}
if (-not (Test-Path (Join-Path $Est "skill\forefront-estimate\scripts\photo_report.py"))) {
  Write-Host "Note: the estimator is missing the photo report script. Start Estimator once (it updates itself) or tell Claude." -ForegroundColor Yellow
}
$Py = Join-Path $Est ".venv\Scripts\python.exe"
if (-not (Test-Path $Py)) { $Py = "py" }

# ---- 3. The hub's packages
Step "Installing the hub (the first time takes a few minutes)"
npm install --no-audit --no-fund --loglevel=error | Out-Host
if ($LASTEXITCODE -ne 0) { throw "npm install failed. Check your internet connection and run setup again." }

# ---- 4. Settings (.env, never uploaded)
Step "Settings"
$EnvFile = Join-Path $Hub ".env"
if (-not (Test-Path $EnvFile)) { Copy-Item (Join-Path $Hub ".env.example") $EnvFile }
$lines = [System.Collections.Generic.List[string]](Get-Content $EnvFile)
function Get-Setting($k) { foreach ($l in $lines) { if ($l -match "^$k=(.*)$") { return $Matches[1].Trim() } }; return "" }
function Set-Setting($k, $v) {
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^$k=") { $lines[$i] = "$k=$v"; return } }
  $lines.Add("$k=$v")
}
Set-Setting "ESTIMATOR_DIR" $Est
if (-not (Get-Setting "JOBS_ROOT")) { Set-Setting "JOBS_ROOT" "C:\Jobs" }
Set-Setting "PYTHON" $Py
if (-not (Get-Setting "HOMEBASE_API_TOKEN")) {
  Write-Host ""
  Write-Host "Paste your Homebase API key (Homebase > Settings > API keys; it starts with hbk_)," -ForegroundColor Yellow
  Write-Host "then press Enter. Right-click pastes in this window." -ForegroundColor Yellow
  $key = (Read-Host "Homebase key").Trim()
  if ($key) { Set-Setting "HOMEBASE_API_TOKEN" $key }
}
[IO.File]::WriteAllLines($EnvFile, $lines)  # UTF-8 without a byte-order mark
New-Item -ItemType Directory -Force -Path (Get-Setting "JOBS_ROOT") | Out-Null

# ---- 5. Desktop icon
Step "Desktop icon"
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath("Desktop"), "Forefront Hub.lnk"))
$lnk.TargetPath = Join-Path $Hub "Start Hub.bat"
$lnk.WorkingDirectory = $Hub
$lnk.IconLocation = Join-Path $Hub "assets\icon.ico"
$lnk.WindowStyle = 7
$lnk.Save()
Write-Host "Added 'Forefront Hub' to your desktop."

# ---- 6. Check
Step "Check"
npm run -s hub -- doctor | Out-Host
Write-Host ""
Write-Host "All set. From now on open the hub with the Forefront Hub icon on your desktop." -ForegroundColor Green
