$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\start-inline-status.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors.Message -join '; ') }
foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  . ([scriptblock]::Create($function.Extent.Text))
}
$checks = 0
function Assert-Equal($Actual, $Expected, [string]$Label) {
  if ($Actual -ne $Expected) { throw ("{0}: expected [{1}], actual [{2}]" -f $Label, $Expected, $Actual) }
  $script:checks++
}
$now = [datetime]::UtcNow
$injector = 'C:\Tools\Inline Status\native_status_injector.mjs'
$previous = [pscustomobject]@{ pid = 42; port = 9335; codeFingerprint = 'code-a'; runId = 'run-a' }
$process = [pscustomobject]@{ Name = 'node.exe'; ProcessId = 42; CommandLine = '"C:\node.exe" "C:\Tools\Inline Status\native_status_injector.mjs" --port 9335 --report "C:\state\health.json" --run-id run-a' }
$health = [pscustomobject]@{ runId = 'run-a'; running = $true; rendererCount = 2; bindingCount = 2; checkedAt = $now.ToString('o'); status = 'attached' }
Assert-Equal (Test-InlineRuntimeReusable $previous $health $process $injector 'code-a' 9335 $now) $true 'exact owned healthy process can be reused'
$health.checkedAt = $now
Assert-Equal (Test-InlineHealthFresh $previous $health 9335 $now) $true 'typed UTC DateTime remains fresh without culture string conversion'
Assert-Equal (ConvertTo-InlineUtc $health.checkedAt).Kind ([DateTimeKind]::Utc) 'UTC DateTime retains UTC kind'
$health.checkedAt = ([datetimeoffset]$now).ToOffset([timespan]::FromHours(-7))
Assert-Equal (Test-InlineHealthFresh $previous $health 9335 $now) $true 'DateTimeOffset preserves the instant across an offset'
$health.checkedAt = $health.checkedAt.ToString('o')
Assert-Equal (Test-InlineHealthFresh $previous $health 9335 $now) $true 'ISO string with an explicit offset preserves the instant'
$health.checkedAt = $now.AddSeconds(-16)
Assert-Equal (Test-InlineHealthFresh $previous $health 9335 $now) $false 'typed stale DateTime is rejected'
$health.checkedAt = ([datetimeoffset]$now.AddSeconds(1)).ToOffset([timespan]::FromHours(8))
Assert-Equal (Test-InlineHealthFresh $previous $health 9335 $now) $false 'typed future DateTimeOffset is rejected'
$health.checkedAt = 'not-a-timestamp'
Assert-Equal (Test-InlineHealthFresh $previous $health 9335 $now) $false 'invalid timestamp is rejected'
$health.checkedAt = $now.ToString('o')
$jsonFixture = Join-Path $PSScriptRoot ('inline-launcher-fixture-' + [guid]::NewGuid().ToString('N') + '.json')
try {
  Write-InlineJson $jsonFixture ([ordered]@{ generation = 1; checkedAt = $now.ToString('o') })
  Assert-Equal (Read-InlineJson $jsonFixture).generation 1 'first JSON write creates a readable file'
  Write-InlineJson $jsonFixture $health
  $jsonHealth = Read-InlineJson $jsonFixture
  Assert-Equal $jsonHealth.runId 'run-a' 'second JSON write atomically replaces the existing file'
  Assert-Equal (Test-InlineHealthFresh $previous $jsonHealth 9335 $now) $true 'real JSON read timestamp remains fresh on this PowerShell version'
  Assert-Equal (Get-InlineHealthPhase $previous $jsonHealth 9335 $now) 'attached' 'real JSON read reports the verified attached phase'
  Write-Output ('Actual JSON timestamp type: ' + $jsonHealth.checkedAt.GetType().FullName)
} finally {
  if (Test-Path -LiteralPath $jsonFixture) { Remove-Item -LiteralPath $jsonFixture -Force }
}
Assert-Equal (Test-InlineRuntimeReusable $previous $health $process $injector 'code-b' 9335 $now) $false 'changed code is not reused'
$previous.pid = 43
Assert-Equal (Test-InlineRuntimeReusable $previous $health $process $injector 'code-a' 9335 $now) $false 'wrong process id is not reused'
$previous.pid = 42
Assert-Equal (Test-InlineOwnedProcess $process 'C:\Other\native_status_injector.mjs' 'run-a' 9335) $false 'other installation is not owned'
Assert-Equal (Test-InlineOwnedProcess $process $injector 'run-b' 9335) $false 'PID reuse or other invocation is not owned'
Assert-Equal (Test-InlineOwnedProcess $process $injector 'run-a' 9336) $false 'other port is not owned'
$other = [pscustomobject]@{ Name = 'ChatGPT.exe'; CommandLine = $process.CommandLine }
Assert-Equal (Test-InlineOwnedProcess $other $injector 'run-a' 9335) $false 'official app is never an owned process'
$health.checkedAt = $now.AddSeconds(-16).ToString('o')
Assert-Equal (Test-InlineHealthFresh $previous $health 9335 $now) $false 'stale health rejected'
$health.checkedAt = $now.AddSeconds(1).ToString('o')
Assert-Equal (Test-InlineHealthFresh $previous $health 9335 $now) $false 'future health rejected'
$health.checkedAt = $now.ToString('o')
$health.runId = 'old-run'
Assert-Equal (Test-InlineHealthFresh $previous $health 9335 $now) $false 'another run health rejected'
$health.runId = 'run-a'; $health.status = 'attached-partial-data'
Assert-Equal (Get-InlineHealthPhase $previous $health 9335 $now) 'partial' 'partial state remains partial'
$health.status = 'attached'; $health.bindingCount = 0
Assert-Equal (Get-InlineHealthPhase $previous $health 9335 $now) 'unavailable' 'attached without binding is not success'
$health.status = 'waiting-for-conversation'
Assert-Equal (Get-InlineHealthPhase $previous $health 9335 $now) 'waiting' 'waiting has explicit separate result'
$health.running = $false
Assert-Equal (Get-InlineHealthPhase $previous $health 9335 $now) 'unverified' 'stopped worker is not reusable'
Assert-Equal (Get-InlineStateRoot 'C:\Users\Test\Documents') 'C:\Users\Test\Documents\ChatGPT-Tools\inline-status-state' 'state location'
$target = [pscustomobject]@{ type = 'page'; url = 'app://-/index.html?initialRoute=/local/thread'; webSocketDebuggerUrl = 'ws://127.0.0.1:9335/devtools/page/1' }
Assert-Equal (Test-InlineTargetList @($target) 9335) $true 'pop-out renderer is acceptable for CDP readiness'
Assert-Equal (Test-InlineTargetList @() 9335) $false 'empty CDP list is not readiness'
$target.webSocketDebuggerUrl = 'ws://example.com:9335/devtools/page/1'
Assert-Equal (Test-InlineTargetList @($target) 9335) $false 'external websocket rejected'
$script:fakeNow = [datetime]'2026-01-01T00:00:00Z'
$script:probes = 0
$ready = Wait-InlineCdp 9335 30 -Probe { param($p, $ms) $script:probes++; return $script:probes -eq 3 } -Clock { $script:fakeNow } -Delay { param($ms) $script:fakeNow = $script:fakeNow.AddMilliseconds($ms) }
Assert-Equal $ready $true 'readiness retries without launching an app'
Assert-Equal $script:probes 3 'readiness stops once ready'
$script:fakeNow = [datetime]'2026-01-01T00:00:00Z'
$started = $script:fakeNow
$ready = Wait-InlineCdp 9335 30 -Probe { param($p, $ms) return $false } -Clock { $script:fakeNow } -Delay { param($ms) $script:fakeNow = $script:fakeNow.AddMilliseconds($ms) }
Assert-Equal $ready $false 'bounded no-CDP result'
Assert-Equal ($script:fakeNow - $started).TotalSeconds 30 'readiness does not wait forever'
$bytes = [IO.File]::ReadAllBytes($source)
Assert-Equal ([BitConverter]::ToString($bytes[0..2])) 'EF-BB-BF' 'PowerShell 5 UTF-8 BOM'
Write-Output ("PASS: {0} pure/mocked launcher assertions; no application or background process started." -f $checks)
