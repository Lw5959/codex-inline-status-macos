[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexInlineStatus'),
    [switch]$CheckOnly,
    [ValidateRange(1024, 65535)][int]$Port = 9335
)
$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)

function Test-LocalCdp([int]$CandidatePort) {
    $response = $null; $reader = $null
    try {
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$CandidatePort/json/list")
        $request.Proxy = $null; $request.AllowAutoRedirect = $false; $request.Timeout = 1000; $request.ReadWriteTimeout = 1000
        $response = $request.GetResponse(); $reader = New-Object IO.StreamReader($response.GetResponseStream())
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

function Start-NativeApplication([string]$AppId, [string]$Arguments) {
    if (-not ('CodexStatusKit.Activation' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace CodexStatusKit {
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IApplicationActivationManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
  }
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  public class ApplicationActivationManager { }
  public static class Activation {
    public static uint Start(string id, string args) {
      var instance = new ApplicationActivationManager();
      try {
        uint processId;
        int result = ((IApplicationActivationManager)instance).ActivateApplication(id, args, 2, out processId);
        Marshal.ThrowExceptionForHR(result);
        return processId;
      } finally { Marshal.FinalReleaseComObject(instance); }
    }
  }
}
'@
    }
    return [CodexStatusKit.Activation]::Start($AppId, $Arguments)
}

try {
    $package = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object @{ Expression = { [version]$_.Version }; Descending = $true } | Select-Object -First 1
    if (-not $package) { throw 'The official OpenAI.Codex App package is not installed for this Windows user.' }
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
    $application = @($manifest.Package.Applications.Application) | Where-Object { $_.Executable -match '(?i)(?:ChatGPT|Codex)\.exe$' } | Select-Object -First 1
    if (-not $application) { $application = @($manifest.Package.Applications.Application) | Select-Object -First 1 }
    if (-not $application.Id) { throw 'The installed package has no identifiable application entry.' }
    $appId = $package.PackageFamilyName + '!' + $application.Id
    $executableName = [IO.Path]::GetFileName([string]$application.Executable)
    if ([string]::IsNullOrWhiteSpace($executableName) -or $executableName -notmatch '^[a-zA-Z0-9._-]+\.exe$') {
        throw 'The installed package executable cannot be identified safely.'
    }
    $officialPathPattern = '(?i)\\WindowsApps\\' + [regex]::Escape([string]$package.Name) + '_[^\\]+\\'
    $session = (Get-Process -Id $PID).SessionId
    $mainProcesses = @(Get-CimInstance Win32_Process -Filter "Name = '$executableName'" | Where-Object {
        $_.SessionId -eq $session -and $_.ExecutablePath -match $officialPathPattern -and
            ($_.CommandLine -notmatch '(?:^|\s)--type(?:=|\s)')
    })
    $candidatePorts = @($Port)
    foreach ($process in $mainProcesses) {
        if ($process.CommandLine -match '--remote-debugging-port(?:=|\s+)(\d+)') {
            $foundPort = [int]$Matches[1]
            if ($foundPort -ge 1024 -and $foundPort -le 65535) { $candidatePorts += $foundPort }
        }
    }
    $connectedPort = $null
    foreach ($candidatePort in @($candidatePorts | Select-Object -Unique)) {
        if (Test-LocalCdp $candidatePort) { $connectedPort = $candidatePort; break }
    }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    $nodeVersion = if ($node) { & $node.Source --version 2>$null } else { $null }
    $nodeReady = "$nodeVersion" -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22
    $starter = Join-Path $InstallRoot 'start-inline-status.ps1'
    $python = Join-Path $InstallRoot 'TokenPulse\.venv\Scripts\python.exe'
    if ($CheckOnly) {
        [pscustomobject]@{ version = '1.3.5'; checkOnly = $true; packageVersion = "$($package.Version)";
            appId = $appId; executableName = $executableName; appRunning = [bool]$mainProcesses.Count; existingCdpPort = $connectedPort;
            desiredPort = $Port; node = $nodeVersion; nodeReady = [bool]$nodeReady;
            starterExists = [bool](Test-Path -LiteralPath $starter -PathType Leaf);
            pythonExists = [bool](Test-Path -LiteralPath $python -PathType Leaf);
            action = $(if ($connectedPort) { 'attach-existing' } elseif ($mainProcesses.Count) { 'leave-running-app-unchanged' } else { 'activate-official-app-then-attach' }) } | ConvertTo-Json -Depth 4
        exit 0
    }
    if (-not $nodeReady -or -not (Test-Path -LiteralPath $starter -PathType Leaf) -or -not (Test-Path -LiteralPath $python -PathType Leaf)) {
        throw 'Install the source kit first; Node.js 22+ and the private Python environment are required.'
    }
    & $python -B -c 'import sys; sys.path.insert(0,sys.argv[1]); import native_status_backend; sys.exit(0 if sys.version_info >= (3,11) else 1)' $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'The installed Python backend is unavailable. Run the installer again.' }
    if (-not $connectedPort -and $mainProcesses.Count) {
        Write-Host 'Codex is already running without a usable local debug endpoint. It was left running. Close it yourself, then use this launcher next time.'
        exit 2
    }
    if (-not $connectedPort) {
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($listener) { throw "Local port $Port is occupied by another listener. Choose another -Port; no process was stopped." }
        [void](Start-NativeApplication $appId "--remote-debugging-port=$Port --remote-debugging-address=127.0.0.1")
        $connectedPort = $Port
    }
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $worker = Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden', '-File', ('"' + $starter + '"'), '-Port', "$connectedPort") -WindowStyle Hidden -Wait -PassThru
    if ($worker.ExitCode -ne 0) {
        Write-Warning 'The official App was left running, but status attachment was not confirmed. See Documents\ChatGPT-Tools\inline-status-state.'
        exit 2
    }
    Write-Host 'Status attachment completed. Existing official login settings were not changed.'
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
