# Keystone setup (Windows). Run by "Setup Keystone.bat"; safe to run again any time.
$ErrorActionPreference = "Stop"
$Hub = $PSScriptRoot
Set-Location $Hub
Write-Host "Setting up Keystone in $Hub" -ForegroundColor Cyan

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
$env:GIT_TERMINAL_PROMPT = "0"
$Skill = "skill\forefront-estimate\scripts\photo_report.py"
function Is-Estimator($d) { $d -and ((Test-Path (Join-Path $d "estimator\cli.py")) -or (Test-Path (Join-Path $d "Setup Estimator.bat"))) }

# Your Estimator app: where Setup Estimator put it (its own Python already has the PDF packages).
$roots = @("C:\Games", (Split-Path $Hub), [Environment]::GetFolderPath("MyDocuments"), [Environment]::GetFolderPath("Desktop"), (Join-Path $env:USERPROFILE "Downloads"), $env:USERPROFILE) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$found = @($env:ESTIMATOR_DIR) + @(foreach ($r in $roots) { Get-ChildItem -Path $r -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName; Get-ChildItem -Path $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } } })
$App = $found | Where-Object { (Is-Estimator $_) -and ($_ -ne (Join-Path $Hub "estimator")) } | Select-Object -First 1
if ($App) {
  Write-Host "Estimator app: $App"
  if ((Test-Path (Join-Path $App ".git")) -and (Get-Command git -ErrorAction SilentlyContinue)) {
    try { & git -C $App pull --ff-only --quiet *> $null } catch { }
  }
} else { Write-Host "Didn't find the Estimator app on this PC; Keystone keeps its own copy of the skill." }

# The skill: the app's copy when it is current, else Keystone's own copy of the estimator repo (kept up to date).
$Est = if ($App -and (Test-Path (Join-Path $App $Skill))) { $App } else { Join-Path $Hub "estimator" }
if ($Est -eq (Join-Path $Hub "estimator")) {
  if (Test-Path (Join-Path $Est ".git")) { try { & git -C $Est pull --ff-only --quiet *> $null } catch { } }
  else {
    Write-Host "Downloading the estimating skill..."
    & git clone --quiet https://github.com/Hpatter9/estimator.git $Est
  }
}
if (-not (Test-Path (Join-Path $Est $Skill))) { throw "Couldn't get the estimating skill from GitHub (Hpatter9/estimator). Check the GitHub sign-in and run setup again." }
Write-Host "Skill: $Est\skill\forefront-estimate"

# Python for the skill's scripts: the Estimator app's own, else a small one for Keystone.
$Py = if ($App) { Join-Path $App ".venv\Scripts\python.exe" } else { "" }
if (-not ($Py -and (Test-Path $Py))) {
  $Py = Join-Path $Hub ".venv-py\Scripts\python.exe"
  if (-not (Test-Path $Py)) {
    if (-not (Get-Command py -ErrorAction SilentlyContinue) -and -not (Get-Command python -ErrorAction SilentlyContinue)) {
      Write-Host "Installing Python..."
      winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements | Out-Host
      Refresh-Path
    }
    $base = if (Get-Command py -ErrorAction SilentlyContinue) { "py" } else { "python" }
    Write-Host "Setting up Python for the estimate PDFs..."
    if ($base -eq "py") { & py -3 -m venv (Join-Path $Hub ".venv-py") } else { & python -m venv (Join-Path $Hub ".venv-py") }
    if (-not (Test-Path $Py)) { throw "Couldn't set up Python. Install Python 3.12 from python.org and run setup again." }
  }
  & $Py -m pip install --quiet --disable-pip-version-check reportlab pdfplumber pillow | Out-Host
}
Write-Host "Python: $Py"

# ---- 3. Keystone's packages
Step "Installing Keystone (the first time takes a few minutes)"
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
$lnk = $ws.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath("Desktop"), "Keystone.lnk"))
$lnk.TargetPath = Join-Path $Hub "Start Keystone.bat"
$lnk.WorkingDirectory = $Hub
$lnk.IconLocation = Join-Path $Hub "assets\keystone.ico"
$lnk.WindowStyle = 7
$lnk.Save()
Remove-Item ([IO.Path]::Combine([Environment]::GetFolderPath("Desktop"), "Forefront Hub.lnk")) -ErrorAction SilentlyContinue
Write-Host "Added 'Keystone' to your desktop."

# ---- 6. Check
Step "Check"
npm run -s hub -- doctor | Out-Host
Write-Host ""
Write-Host "All set. From now on open Keystone with the Keystone icon on your desktop." -ForegroundColor Green
