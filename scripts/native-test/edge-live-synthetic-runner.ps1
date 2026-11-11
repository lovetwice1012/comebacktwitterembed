param([Parameter(Mandatory=$true)][string] $Node, [switch] $TestOnly, [switch] $Takeover, [switch] $Reimport, [switch] $OfflineMessage, [switch] $OfflineBatch, [switch] $OnlineBatch, [switch] $OfflineSettle, [switch] $OverlapProbe, [switch] $DistinctTopics, [switch] $ConnectVersionTwo)
$ErrorActionPreference = 'Stop'
if (-not $TestOnly -or ($ConnectVersionTwo -and $OverlapProbe) -or ($Reimport -and -not $Takeover) -or ($OfflineMessage -and -not $Reimport) -or ($OfflineBatch -and -not $OfflineMessage) -or ($OnlineBatch -and -not $OfflineBatch) -or ($OfflineSettle -and (-not $OfflineBatch -or $OnlineBatch)) -or ($OverlapProbe -and (-not $Takeover -or $Reimport)) -or ($DistinctTopics -and (-not $OfflineBatch -or $OnlineBatch))) { throw 'SYNTHETIC_TEST_ONLY' }
$container = 'cbte-edge-live-synthetic-20261111'
try { $identity = (& docker inspect $container --format '{{.Config.Image}}|{{.State.Running}}' 2>$null) }
catch { throw 'SYNTHETIC_DATABASE_REQUIRED' }
if ($LASTEXITCODE -ne 0 -or $identity -cne 'mariadb:11.4.10|true') { throw 'SYNTHETIC_DATABASE_REQUIRED' }
try { $binding = (& docker port $container '3306/tcp' 2>$null) }
catch { throw 'SYNTHETIC_DATABASE_REQUIRED' }
if ($LASTEXITCODE -ne 0 -or $binding -cne '127.0.0.1:33621') { throw 'SYNTHETIC_DATABASE_REQUIRED' }
$repo = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
$deps = [IO.Path]::Combine($repo, 'artifacts', 'edge-fixture-deps-20261111', 'node_modules')
if (-not [IO.Directory]::Exists($deps) -or ([IO.File]::GetAttributes($deps) -band [IO.FileAttributes]::ReparsePoint)) { throw 'SYNTHETIC_DEPENDENCIES_MISSING' }
. ([IO.Path]::Combine($repo, 'client', 'angelic-setup', 'EdgeCalibrationJob.ps1'))
Initialize-XEdgeCalibrationJob
$variables = [Environment]::GetEnvironmentVariables('Process'); $items = New-Object 'Collections.Generic.List[string]'
foreach ($key in $variables.Keys) {
    $name = [string]$key
    if (-not $name.StartsWith('=') -and -not $name.StartsWith('EDGE_PROBE_', [StringComparison]::OrdinalIgnoreCase) -and
        @('NODE_OPTIONS','NODE_PATH','NODE_REPL_EXTERNAL_MODULE','NODE_ENV','AUTOMATION_TEST_DB_PORT') -notcontains $name) {
        $items.Add(($name + '=' + [string]$variables[$key]))
    }
}
$items.Add('NODE_ENV=test'); $items.Add('NODE_PATH=' + $deps); $items.Add('AUTOMATION_TEST_DB_PORT=33621')
foreach ($name in @('EDGE_PROBE_DATABASE','EDGE_PROBE_REAL_WNS','EDGE_PROBE_RELAY_CALIBRATION','EDGE_PROBE_CALIBRATION_RUNNER')) { $items.Add($name + '=1') }
if ($ConnectVersionTwo) { $items.Add('EDGE_PROBE_CONNECT_VERSION=2') }
if ($Takeover) { $items.Add('EDGE_PROBE_TAKEOVER=1'); $items.Add('EDGE_PROBE_BLOCK_WNS=1') }
if ($Reimport) { $items.Add('EDGE_PROBE_REIMPORT=1') }
if ($OfflineMessage) { $items.Add('EDGE_PROBE_OFFLINE_MESSAGE=1') }
if ($OfflineBatch) { $items.Add('EDGE_PROBE_OFFLINE_BATCH=1') }
if ($OnlineBatch) { $items.Add('EDGE_PROBE_BATCH_ONLINE=1') }
if ($OfflineSettle) { $items.Add('EDGE_PROBE_OFFLINE_SETTLE=1') }
if ($OverlapProbe) { $items.Add('EDGE_PROBE_OVERLAP=1') }
if ($DistinctTopics) { $items.Add('EDGE_PROBE_DISTINCT_TOPICS=1') }
$items.Sort([StringComparer]::OrdinalIgnoreCase); $environment = ($items -join [char]0) + [char]0 + [char]0
$probe = [IO.Path]::Combine($repo, 'experiments', 'chrome-push', 'edge-broker-pipe-probe.cjs')
$job = [XEdgeNative.CalibrationJob]::Start($Node, ('"' + $probe + '"'), $repo, $environment)
$inputBytes = New-Object byte[] 0; $outputBytes = $null
try {
    $read = $job.ReadLimitedAsync(16384); $write = $job.WriteAndCloseAsync($inputBytes)
    $deadline = [DateTime]::UtcNow.AddSeconds(150)
    while (-not $job.WaitForExit(100)) { if ([DateTime]::UtcNow -ge $deadline) { throw 'SYNTHETIC_PROBE_TIMEOUT' } }
    if (-not $write.Wait(5000) -or -not $read.Wait(5000)) { throw 'SYNTHETIC_PROBE_FAILED' }
    $outputBytes = $read.GetAwaiter().GetResult(); $text = [Text.Encoding]::UTF8.GetString($outputBytes)
    if ($job.ExitCode -ne 0) {
        if ($text -match 'PROBE_STAGE wns (PROBE_BATCH_(?:TIMEOUT_[0-7]|DUPLICATE|SCAN_FAILED))') { throw $Matches[1] }
        if ($text -match 'PROBE_STAGE wns (PROBE_TOPIC_SEND_REJECTED)') { throw $Matches[1] }
        throw 'SYNTHETIC_PROBE_FAILED'
    }
    $result = ConvertFrom-Json -InputObject $text
    if ($ConnectVersionTwo -and $result.explicitConnectVersion -cne '2') { throw 'SYNTHETIC_PROBE_INCOMPLETE' }
    if ($OverlapProbe) {
        if ($result.syntheticProfile -ne $true -or $null -eq $result.overlapResult) { throw 'SYNTHETIC_PROBE_INCOMPLETE' }
        Write-Output $text; return
    }
    if ($result.syntheticProfile -ne $true -or $result.realWnsWorkerTested -ne $true -or $result.databaseRecovery -ne $true -or
        $result.packagedExport -ne $true -or $result.packagedSnapshotCleaned -ne $true -or $result.otherSiteConsentRequired -ne $true) { throw 'SYNTHETIC_PROBE_INCOMPLETE' }
    if ($Reimport -and ($result.takeoverResult.receivedInNewWorkerProcess -ne $true -or
        $result.takeoverResult.receivedAfterForcedWorkerExit -ne $true)) { throw 'SYNTHETIC_PROBE_INCOMPLETE' }
    if ($OfflineMessage -and -not $OnlineBatch -and $result.takeoverResult.receivedSentWhileOffline -ne $true) { throw 'SYNTHETIC_PROBE_INCOMPLETE' }
    if ($OfflineBatch -and $result.takeoverResult.batchPersistedOnce -ne $true) { throw 'SYNTHETIC_PROBE_INCOMPLETE' }
    Write-Output $text
} finally {
    try { $job.Stop() } finally { $job.Dispose() }
    [Array]::Clear($inputBytes, 0, $inputBytes.Length)
    if ($null -ne $outputBytes) { [Array]::Clear($outputBytes, 0, $outputBytes.Length) }
}
