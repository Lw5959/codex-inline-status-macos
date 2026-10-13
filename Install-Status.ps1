[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexInlineStatus'),
    [switch]$CheckOnly,
    [switch]$NoStart,
    [ValidateRange(1024, 65535)][int]$Port = 9335
)

$ErrorActionPreference = 'Stop'
$Version = '1.3.5'
$BundleRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$SourceNames = @('native_statusbar.js', 'native_status_injector.mjs', 'native_status_backend.py',
    'codex_status_backend.py', 'turn_elapsed_meter.py', 'start-inline-status.ps1',
    'visible_stream_observer.js', 'visible_stream_meter.mjs', 'visible_tokenizer.mjs')

function Test-Python($Candidate) {
    if (-not $Candidate) { return $null }
    try {
        $text = & $Candidate.Path @($Candidate.Prefix) -B -c "import sys; print('%d.%d.%d' % sys.version_info[:3]); sys.exit(0 if sys.version_info >= (3,11) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0 -and "$text" -match '^3\.\d+\.\d+$') {
            return [pscustomobject]@{ Path = $Candidate.Path; Prefix = @($Candidate.Prefix); Version = "$text" }
        }
    } catch {}
    return $null
}

function Find-Python([string]$ExistingPython) {
    $candidates = @()
    if (Test-Path -LiteralPath $ExistingPython -PathType Leaf) {
        $candidates += [pscustomobject]@{ Path = $ExistingPython; Prefix = @() }
    }
    foreach ($name in @('python.exe', 'py.exe')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and $command.Source -notmatch '\\Microsoft\\WindowsApps\\python\.exe$') {
            $prefix = @(); if ($name -eq 'py.exe') { $prefix = @('-3') }
            $candidates += [pscustomobject]@{ Path = $command.Source; Prefix = $prefix }
        }
    }
    $uvRoots = @((Join-Path $env:APPDATA 'uv\python'), (Join-Path $env:LOCALAPPDATA 'uv\python'),
        (Join-Path $env:USERPROFILE '.local\share\uv\python'))
    foreach ($uvRoot in $uvRoots) {
        if (-not (Test-Path -LiteralPath $uvRoot -PathType Container)) { continue }
        foreach ($directory in @(Get-ChildItem -LiteralPath $uvRoot -Directory -Filter 'cpython-3.*' | Sort-Object Name -Descending)) {
            foreach ($relative in @('python.exe', 'install\python.exe')) {
                $candidatePath = Join-Path $directory.FullName $relative
                if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
                    $candidates += [pscustomobject]@{ Path = $candidatePath; Prefix = @() }
                }
            }
        }
    }
    foreach ($candidate in $candidates) {
        $valid = Test-Python $candidate
        if ($valid) { return $valid }
    }
    return $null
}

function Test-BackendImport($Python, [string]$BackendRoot, [string]$TokenSource) {
    & $Python.Path @($Python.Prefix) -B -c "import sys; sys.path[:0]=sys.argv[1:]; import native_status_backend; print('backend import OK')" $BackendRoot $TokenSource
    if ($LASTEXITCODE -ne 0) { throw 'Python could not import the status backend; no App was started.' }
}

function Get-TargetPath([string]$Relative) {
    $target = [IO.Path]::GetFullPath((Join-Path $InstallRoot $Relative))
    if (-not $target.StartsWith($InstallRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A package path escapes the installation directory.'
    }
    return $target
}

function Assert-NoReparsePath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "A redirected path is not accepted for installation: $cursor"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Test-LocalCdp([int]$CandidatePort) {
    $response = $null; $reader = $null
    try {
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$CandidatePort/json/list")
        $request.Proxy = $null; $request.AllowAutoRedirect = $false
        $request.Timeout = 1000; $request.ReadWriteTimeout = 1000
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $targets = $reader.ReadToEnd() | ConvertFrom-Json
        foreach ($target in @($targets)) {
            $page = [uri]$target.url; $socket = [uri]$target.webSocketDebuggerUrl
            if ($target.type -eq 'page' -and $page.Scheme -eq 'app' -and $page.AbsolutePath -eq '/index.html' -and
                $socket.Scheme -eq 'ws' -and $socket.Host -in @('127.0.0.1', 'localhost', '[::1]', '::1') -and
                $socket.Port -eq $CandidatePort -and [string]::IsNullOrEmpty($socket.UserInfo)) { return $true }
        }
    } catch {} finally { if ($reader) { $reader.Dispose() }; if ($response) { $response.Dispose() } }
    return $false
}

try {
    if ($InstallRoot -eq [IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\') -or
        $InstallRoot.StartsWith([IO.Path]::GetFullPath($env:SystemRoot), [StringComparison]::OrdinalIgnoreCase) -or
        $InstallRoot -match '\\WindowsApps(?:\\|$)' -or
        $InstallRoot.StartsWith((Join-Path $env:USERPROFILE '.codex'), [StringComparison]::OrdinalIgnoreCase) -or
        $InstallRoot -eq $BundleRoot) { throw 'Choose a separate status-bar installation directory.' }
    Assert-NoReparsePath $InstallRoot
    $files = @()
    foreach ($name in $SourceNames) {
        $source = Join-Path (Join-Path $BundleRoot 'src') $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing package source: src\$name" }
        $files += [pscustomobject]@{ Source = $source; Relative = $name }
    }
    $tokenSource = Join-Path $BundleRoot 'TokenPulse\src'
    if (-not (Test-Path -LiteralPath (Join-Path $tokenSource 'token_pulse\__init__.py') -PathType Leaf)) {
        throw 'Missing TokenPulse source package.'
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $tokenSource -Recurse -File)) {
        if ($file.FullName -match '\\__pycache__\\' -or $file.Extension -in @('.pyc', '.pyo')) { continue }
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not accepted as package source.' }
        $relative = $file.FullName.Substring($tokenSource.Length).TrimStart('\')
        $files += [pscustomobject]@{ Source = $file.FullName; Relative = ('TokenPulse\src\' + $relative) }
    }
    foreach ($relative in @('Launch-Codex.ps1', 'README.md', 'LICENSE', 'TokenPulse\LICENSE',
        'src\DSH-MIT-LICENSE.txt', 'src\JS-TIKTOKEN-LICENSE.txt', 'src\BASE64-JS-LICENSE.txt')) {
        $source = Join-Path $BundleRoot $relative
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            $destination = $relative -replace '^src\\', ''
            $files += [pscustomobject]@{ Source = $source; Relative = $destination }
        }
    }
    foreach ($file in $files) {
        if (((Get-Item -LiteralPath $file.Source).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not accepted as package source.' }
        Assert-NoReparsePath (Get-TargetPath $file.Relative)
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    $nodeVersion = $null
    if ($nodeCommand) {
        $nodeVersion = & $nodeCommand.Source --version 2>$null
        if ($LASTEXITCODE -ne 0 -or "$nodeVersion" -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { $nodeVersion = $null }
    }
    $venvPython = Join-Path $InstallRoot 'TokenPulse\.venv\Scripts\python.exe'
    Assert-NoReparsePath $venvPython
    $python = Find-Python $venvPython
    $reuseVenv = $python -and $python.Path -eq $venvPython
    $hasCdp = Test-LocalCdp $Port
    if ($CheckOnly) {
        [pscustomobject]@{ version = $Version; checkOnly = $true; source = $BundleRoot; installRoot = $InstallRoot;
            node = $nodeVersion; python = $(if ($python) { $python.Version } else { $null });
            pythonExecutable = $(if ($python) { $python.Path } else { $null }); reuseVenv = [bool]$reuseVenv;
            fileCount = $files.Count; files = @($files.Relative); existingCdp = $hasCdp;
            wouldHotAttach = [bool]($hasCdp -and -not $NoStart); ready = [bool]($nodeVersion -and $python) } | ConvertTo-Json -Depth 5
        exit 0
    }
    if (-not $nodeVersion) { throw 'Install Node.js 22 or newer, then run this installer again. No Node downloads are performed.' }
    if (-not $python) { throw 'Install Python 3.11 or newer, then run this installer again. No Python downloads are performed.' }
    Test-BackendImport $python (Join-Path $BundleRoot 'src') $tokenSource
    foreach ($name in @('native_status_injector.mjs', 'visible_stream_meter.mjs', 'visible_tokenizer.mjs')) {
        & $nodeCommand.Source --check (Join-Path (Join-Path $BundleRoot 'src') $name)
        if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $name" }
    }
    $backupRoot = Join-Path $InstallRoot ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    Assert-NoReparsePath $backupRoot
    foreach ($file in $files) {
        $target = Get-TargetPath $file.Relative
        if (Test-Path -LiteralPath $target) {
            if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or
                ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Unsafe existing target: $target" }
            $backup = Join-Path $backupRoot $file.Relative
            Assert-NoReparsePath $backupRoot
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backup))
            Copy-Item -LiteralPath $target -Destination $backup
        }
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        Copy-Item -LiteralPath $file.Source -Destination $target -Force
    }
    if (-not $reuseVenv) {
        if (Test-Path -LiteralPath (Join-Path $InstallRoot 'TokenPulse\.venv')) {
            throw 'The existing .venv is unusable. It was preserved; choose a new installation directory or repair that Python environment.'
        }
        & $python.Path @($python.Prefix) -B -m venv --without-pip (Join-Path $InstallRoot 'TokenPulse\.venv')
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the private Python environment.' }
    }
    $installedPython = [pscustomobject]@{ Path = $venvPython; Prefix = @() }
    $siteText = & $venvPython -B -c "import sysconfig; print(sysconfig.get_paths()['purelib'])"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace("$siteText")) { throw 'Cannot locate the private site-packages directory.' }
    $sitePath = [IO.Path]::GetFullPath("$siteText")
    $venvRoot = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'TokenPulse\.venv'))
    if (-not $sitePath.StartsWith($venvRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected Python environment path.' }
    $pthPath = Join-Path $sitePath 'codex_inline_tokenpulse.pth'
    Assert-NoReparsePath $pthPath
    if (Test-Path -LiteralPath $pthPath -PathType Leaf) {
        Assert-NoReparsePath $backupRoot
        [void][IO.Directory]::CreateDirectory($backupRoot)
        Copy-Item -LiteralPath $pthPath -Destination (Join-Path $backupRoot 'codex_inline_tokenpulse.pth')
    }
    [IO.File]::WriteAllText($pthPath, ((Join-Path $InstallRoot 'TokenPulse\src') + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
    Test-BackendImport $installedPython $InstallRoot (Join-Path $InstallRoot 'TokenPulse\src')
    Write-Host "Codex status source $Version installed: $InstallRoot"
    Write-Host "Overwritten files were backed up under: $backupRoot"
    if (-not $NoStart -and $hasCdp) {
        $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $worker = Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-WindowStyle', 'Hidden', '-File', ('"' + (Join-Path $InstallRoot 'start-inline-status.ps1') + '"'), '-Port', "$Port") -WindowStyle Hidden -Wait -PassThru
        if ($worker.ExitCode -ne 0) { Write-Warning 'Installed, but attachment was not confirmed. Next time, close Codex yourself and use the supplied launcher.' }
    } elseif (-not $NoStart) {
        Write-Host 'Installed. No existing local Codex debug endpoint was found; next time use the supplied launcher. No App was restarted.'
    }
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
