[CmdletBinding()]
param([ValidateRange(1024, 65535)][int]$Port = 9335)

$ErrorActionPreference = 'Stop'

function Get-InlineStateRoot([string]$DocumentsRoot) {
  if ([string]::IsNullOrWhiteSpace($DocumentsRoot)) { throw 'Documents folder is unavailable.' }
  return Join-Path $DocumentsRoot 'ChatGPT-Tools\inline-status-state'
}

function Get-InlineFingerprint([string]$InstallRoot) {
  $hashes = foreach ($name in @('native_statusbar.js', 'native_status_injector.mjs', 'native_status_backend.py', 'codex_status_backend.py', 'turn_elapsed_meter.py', 'visible_stream_observer.js', 'visible_stream_meter.mjs', 'visible_tokenizer.mjs')) {
    $stream = $null
    $sha = $null
    try {
      $stream = [IO.File]::OpenRead([IO.Path]::Combine($InstallRoot, $name))
      $sha = [Security.Cryptography.SHA256]::Create()
      [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
    } finally {
      if ($stream) { $stream.Dispose() }
      if ($sha) { $sha.Dispose() }
    }
  }
  return $hashes -join ':'
}

function Read-InlineJson([string]$Path) {
  try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Write-InlineJson([string]$Path, $Value) {
  $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  $encoding = New-Object Text.UTF8Encoding($true)
  try {
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), $encoding)
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $Path) }
  } finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

function Test-InlineOwnedProcess($Process, [string]$InjectorPath, [string]$RunId, [int]$ExpectedPort) {
  try {
    if (-not $Process -or $Process.Name -ne 'node.exe' -or [string]::IsNullOrWhiteSpace($Process.CommandLine)) { return $false }
    if ($RunId -notmatch '^[a-zA-Z0-9_-]{1,80}$') { return $false }
    $escaped = [regex]::Escape([IO.Path]::GetFullPath($InjectorPath))
    $command = [string]$Process.CommandLine
    $pathMatches = $command -match ('(?:^|\s)(?:"' + $escaped + '"|' + $escaped + ')(?=\s|$)')
    $runMatches = $command -match ('(?:^|\s)--run-id(?:=|\s+)' + [regex]::Escape($RunId) + '(?=\s|$)')
    $portMatches = $command -match ('(?:^|\s)--port(?:=|\s+)' + $ExpectedPort + '(?=\s|$)')
    return $pathMatches -and $runMatches -and $portMatches
  } catch { return $false }
}

function ConvertTo-InlineUtc($Value) {
  # ConvertFrom-Json returns ISO timestamps as strings in PS5 and DateTime in PS7.
  # Preserve typed UTC values instead of reparsing their culture-dependent string form.
  if ($Value -is [datetimeoffset]) { return $Value.UtcDateTime }
  if ($Value -is [datetime]) {
    if ($Value.Kind -eq [DateTimeKind]::Unspecified) { return [datetime]::SpecifyKind($Value, [DateTimeKind]::Utc) }
    return $Value.ToUniversalTime()
  }
  if ($Value -is [string]) {
    $parsed = [datetimeoffset]::MinValue
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    if ([datetimeoffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
      return $parsed.UtcDateTime
    }
  }
  throw 'Invalid health timestamp.'
}

function Test-InlineHealthFresh($Previous, $Health, [int]$ExpectedPort, [datetime]$Now = [datetime]::UtcNow) {
  try {
    $age = ((ConvertTo-InlineUtc $Now) - (ConvertTo-InlineUtc $Health.checkedAt)).TotalSeconds
    return $Previous.port -eq $ExpectedPort -and -not [string]::IsNullOrWhiteSpace($Previous.runId) -and
      $Previous.runId -eq $Health.runId -and $Health.running -eq $true -and
      $Health.rendererCount -gt 0 -and $age -ge 0 -and $age -le 15
  } catch { return $false }
}

function Get-InlineHealthPhase($Previous, $Health, [int]$ExpectedPort, [datetime]$Now = [datetime]::UtcNow) {
  if (-not (Test-InlineHealthFresh $Previous $Health $ExpectedPort $Now)) { return 'unverified' }
  try {
    if ($Health.bindingCount -gt 0) {
      if ($Health.status -eq 'attached') { return 'attached' }
      if ($Health.status -eq 'attached-no-data') { return 'attached-no-data' }
      if ($Health.status -eq 'attached-partial-data') { return 'partial' }
    }
    if ($Health.status -eq 'waiting-for-conversation' -and $Health.bindingCount -eq 0) { return 'waiting' }
  } catch {}
  return 'unavailable'
}

function Test-InlineRuntimeReusable($Previous, $Health, $Process, [string]$InjectorPath, [string]$Fingerprint, [int]$ExpectedPort, [datetime]$Now = [datetime]::UtcNow) {
  try {
    if ($Previous.codeFingerprint -ne $Fingerprint) { return $false }
    if ([int]$Previous.pid -ne [int]$Process.ProcessId) { return $false }
    if (-not (Test-InlineOwnedProcess $Process $InjectorPath $Previous.runId $ExpectedPort)) { return $false }
    return (Get-InlineHealthPhase $Previous $Health $ExpectedPort $Now) -in @('attached', 'attached-no-data', 'partial', 'waiting')
  } catch { return $false }
}

function Test-InlineTargetList($Targets, [int]$ExpectedPort) {
  foreach ($target in @($Targets)) {
    try {
      $page = [uri]$target.url
      $socket = [uri]$target.webSocketDebuggerUrl
      if ($target.type -eq 'page' -and $page.Scheme -eq 'app' -and $page.AbsolutePath -eq '/index.html' -and
        $socket.Scheme -eq 'ws' -and $socket.Host -in @('127.0.0.1', 'localhost', '[::1]', '::1') -and
        $socket.Port -eq $ExpectedPort -and [string]::IsNullOrEmpty($socket.UserInfo)) { return $true }
    } catch {}
  }
  return $false
}

function Test-InlineCdp([int]$CandidatePort, [int]$TimeoutMilliseconds = 1000) {
  $response = $null
  $reader = $null
  try {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$CandidatePort/json/list")
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = [Math]::Max(1, [Math]::Min(1000, $TimeoutMilliseconds))
    $request.ReadWriteTimeout = $request.Timeout
    $response = $request.GetResponse()
    if ([int]$response.StatusCode -ne 200) { return $false }
    $reader = New-Object IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)
    return Test-InlineTargetList ($reader.ReadToEnd() | ConvertFrom-Json) $CandidatePort
  } catch { return $false }
  finally {
    if ($reader) { $reader.Dispose() }
    if ($response) { $response.Dispose() }
  }
}

function Wait-InlineCdp([int]$CandidatePort, [int]$TimeoutSeconds = 30,
  [scriptblock]$Probe = { param($p, $ms) Test-InlineCdp $p $ms },
  [scriptblock]$Clock = { [datetime]::UtcNow },
  [scriptblock]$Delay = { param($ms) Start-Sleep -Milliseconds $ms }) {
  $deadline = (& $Clock).AddSeconds($TimeoutSeconds)
  while ((& $Clock) -lt $deadline) {
    $remaining = [Math]::Max(1, [int]($deadline - (& $Clock)).TotalMilliseconds)
    try { if (& $Probe $CandidatePort ([Math]::Min(1000, $remaining))) { return $true } } catch {}
    $remaining = [int]($deadline - (& $Clock)).TotalMilliseconds
    if ($remaining -gt 0) { & $Delay ([Math]::Min(500, $remaining)) }
  }
  return $false
}

function Get-InlineProcess([int]$ProcessId) {
  if ($ProcessId -le 0) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Stop-InlineOwnedProcess($Previous, [string]$InjectorPath) {
  if (-not $Previous) { return $false }
  $existing = Get-InlineProcess ([int]$Previous.pid)
  if (-not (Test-InlineOwnedProcess $existing $InjectorPath $Previous.runId ([int]$Previous.port))) { return $false }
  Stop-Process -Id $existing.ProcessId -ErrorAction Stop
  Wait-Process -Id $existing.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
  return $true
}

function Show-InlinePhase([string]$Phase, $Health, [string]$StateRoot) {
  switch ($Phase) {
    'attached' { Write-Host ("已核实内嵌状态条，数量：{0}。" -f $Health.bindingCount); return 0 }
    'attached-no-data' { Write-Host ("已核实内嵌状态条，数量：{0}；尚无可测统计。" -f $Health.bindingCount); return 0 }
    'partial' { Write-Host ("已核实部分内嵌状态条，数量：{0}；部分页面或统计暂不可用。" -f $Health.bindingCount); return 0 }
    'waiting' { Write-Host '已连接官方 App，正在等待可识别的对话输入区；尚未确认状态条显示。'; return 2 }
    default { Write-Host ("尚未核实状态条接入。诊断目录：{0}" -f $StateRoot); return 2 }
  }
}

function Invoke-InlineStatusStart([string]$InstallRoot, [int]$CandidatePort) {
  $stateRoot = Get-InlineStateRoot ([Environment]::GetFolderPath('MyDocuments'))
  New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
  $statePath = Join-Path $stateRoot 'runtime.json'
  $healthPath = Join-Path $stateRoot 'health.json'
  $errorPath = Join-Path $stateRoot 'launcher-error.log'
  $injector = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'native_status_injector.mjs'))
  $mutex = New-Object Threading.Mutex($false, 'Local\CodexInlineStatusLaunch')
  $acquired = $false
  $launchedState = $null
  try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { Write-Host '另一个状态条启动或移除操作正在进行；未启动第二个后台。'; return 2 }
    $fingerprint = Get-InlineFingerprint $InstallRoot
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'TokenPulse\.venv\Scripts\python.exe') -PathType Leaf)) { throw '缺少 TokenPulse Python 环境。' }
    if (-not (Wait-InlineCdp $CandidatePort 30)) {
      Write-Host ("30 秒内未找到官方 App 的本机接入端口 {0}。请先用启用 CDP 的官方 App 入口打开；此脚本不会启动、关闭或重启 App。" -f $CandidatePort)
      return 2
    }
    $previous = Read-InlineJson $statePath
    $existing = $null
    if ($previous) { try { $existing = Get-InlineProcess ([int]$previous.pid) } catch {} }
    $health = Read-InlineJson $healthPath
    if (Test-InlineRuntimeReusable $previous $health $existing $injector $fingerprint $CandidatePort) {
      return Show-InlinePhase (Get-InlineHealthPhase $previous $health $CandidatePort) $health $stateRoot
    }
    [void](Stop-InlineOwnedProcess $previous $injector)
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $runId = [guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path $stateRoot ("injector-{0}.log" -f $runId)
    $stderrPath = Join-Path $stateRoot ("injector-{0}-error.log" -f $runId)
    $arguments = '"' + $injector + '" --port ' + $CandidatePort + ' --report "' + $healthPath + '" --run-id ' + $runId
    $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $state = [ordered]@{ schemaVersion = 1; pid = $process.Id; port = $CandidatePort; injector = $injector; runId = $runId;
      codeFingerprint = $fingerprint; startedAt = [datetime]::UtcNow.ToString('o'); startupPhase = 'starting'; stdoutPath = $stdoutPath; stderrPath = $stderrPath }
    $launchedState = [pscustomobject]$state
    Write-InlineJson $statePath $state
    $deadline = [datetime]::UtcNow.AddSeconds(30)
    $observed = $null
    $phase = 'unverified'
    do {
      $process.Refresh()
      if ($process.HasExited) { throw ("状态条后台提前退出；错误日志：{0}" -f $stderrPath) }
      $candidate = Read-InlineJson $healthPath
      $candidatePhase = Get-InlineHealthPhase $state $candidate $CandidatePort
      $phase = $candidatePhase
      $observed = $null
      if ($candidatePhase -ne 'unverified') { $observed = $candidate }
      if ($phase -in @('attached', 'attached-no-data', 'partial')) { break }
      Start-Sleep -Milliseconds 500
    } while ([datetime]::UtcNow -lt $deadline)
    $state.startupPhase = $phase
    Write-InlineJson $statePath $state
    if ($phase -eq 'unverified') {
      [void](Stop-InlineOwnedProcess ([pscustomobject]$state) $injector)
      throw ("30 秒内没有收到可核实的后台状态；错误日志：{0}" -f $stderrPath)
    }
    return Show-InlinePhase $phase $observed $stateRoot
  } catch {
    $message = $_.Exception.Message
    if ($launchedState) { try { [void](Stop-InlineOwnedProcess $launchedState $injector) } catch {} }
    [IO.File]::WriteAllText($errorPath, ([datetime]::UtcNow.ToString('o') + ' ' + $message), (New-Object Text.UTF8Encoding($true)))
    Write-Host ("状态条启动未完成：{0}" -f $message)
    return 1
  } finally {
    if ($acquired) { try { $mutex.ReleaseMutex() } catch {} }
    $mutex.Dispose()
  }
}

exit (Invoke-InlineStatusStart $PSScriptRoot $Port)
