#requires -Version 5.1
param([ValidateSet('normal', 'online-batch', 'offline-batch', 'offline-status', 'offline-cache', 'offline-no-cache')][string] $Mode = 'normal')
<#
  Disposable GitHub-hosted Windows runner only. This downloads a hash-pinned
  MariaDB ZIP to RUNNER_TEMP, starts a private loopback database without
  installing a service, then runs the synthetic Edge/WNS pipeline in a Job.
  It never opens a user's browser profile, X account, or production database.
#>
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:OS -cne 'Windows_NT') { throw 'SYNTHETIC_HOST_REQUIRED' }
if (-not $env:RUNNER_TEMP -or -not [IO.Path]::IsPathRooted($env:RUNNER_TEMP)) { throw 'SYNTHETIC_HOST_REQUIRED' }
$temp = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
$repo = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
$candidate = [IO.Path]::Combine($temp, 'cbte-edge-preview-15.zip')
if (-not [IO.File]::Exists($candidate) -or (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -ine '9a0577be4216b1f3970c00c51b1258275f72df052c21090322e63e1dde0c5397') { throw 'SYNTHETIC_PACKAGE_REQUIRED' }
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$signature = Get-AuthenticodeSignature -LiteralPath $edge
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
    $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'Microsoft Corporation') { throw 'SYNTHETIC_EDGE_SIGNATURE_INVALID' }
if (Get-NetTCPConnection -LocalPort 33621 -State Listen -ErrorAction SilentlyContinue) { throw 'SYNTHETIC_DB_PORT_BUSY' }
$archive = [IO.Path]::Combine($temp, 'cbte-mariadb-11.4.10.zip')
$extract = [IO.Path]::Combine($temp, 'cbte-mariadb-11.4.10')
$data = [IO.Path]::Combine($temp, 'cbte-edge-disposable-db')
foreach ($target in @($archive, $extract, $data)) { if (Test-Path -LiteralPath $target) { throw 'SYNTHETIC_PATH_BUSY' } }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri 'https://archive.mariadb.org/mariadb-11.4.10/winx64-packages/mariadb-11.4.10-winx64.zip' -OutFile $archive -TimeoutSec 180
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine 'fb7c76f0804321ee373daa49145f2056d2d88f321b614130adeb05a1644ea003') { throw 'SYNTHETIC_DB_DOWNLOAD_INVALID' }
Expand-Archive -LiteralPath $archive -DestinationPath $extract
$bin = [IO.Path]::Combine($extract, 'mariadb-11.4.10-winx64', 'bin')
$installer = [IO.Path]::Combine($bin, 'mariadb-install-db.exe')
$server = [IO.Path]::Combine($bin, 'mariadbd.exe')
$admin = [IO.Path]::Combine($bin, 'mariadb-admin.exe')
foreach ($file in @($installer, $server, $admin)) { if (-not [IO.File]::Exists($file)) { throw 'SYNTHETIC_DB_PACKAGE_INVALID' } }
$syntheticPassword = 'cbte-synthetic-only'
& $installer "--datadir=$data" "--password=$syntheticPassword" '--port=33621' '--silent'
if ($LASTEXITCODE -ne 0) { throw 'SYNTHETIC_DB_INITIALIZE_FAILED' }
$dbProcess = $null
try {
    $ini = [IO.Path]::Combine($data, 'my.ini')
    if (-not [IO.File]::Exists($ini)) { throw 'SYNTHETIC_DB_INITIALIZE_FAILED' }
    $dbProcess = Start-Process -FilePath $server -ArgumentList @("--defaults-file=`"$ini`"", '--bind-address=127.0.0.1', '--port=33621') -WindowStyle Hidden -PassThru
    $ready = $false
    for ($i = 0; $i -lt 90; $i++) {
        if ($dbProcess.HasExited) { break }
        $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 33621 -State Listen -ErrorAction SilentlyContinue)
        if ($listeners.Count -eq 1 -and $listeners[0].OwningProcess -eq $dbProcess.Id) {
            & $admin '--protocol=tcp' '--host=127.0.0.1' '--port=33621' '--user=root' "--password=$syntheticPassword" ping *> $null
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'SYNTHETIC_DB_NOT_READY' }

    . ([IO.Path]::Combine($repo, 'client', 'angelic-setup', 'EdgeCalibrationJob.ps1'))
    Initialize-XEdgeCalibrationJob
    $vars = [Environment]::GetEnvironmentVariables('Process'); $items = New-Object 'Collections.Generic.List[string]'
    foreach ($key in $vars.Keys) {
        $name = [string]$key
        if (-not $name.StartsWith('=') -and -not $name.StartsWith('EDGE_PROBE_', [StringComparison]::OrdinalIgnoreCase) -and
            @('NODE_OPTIONS','NODE_PATH','NODE_REPL_EXTERNAL_MODULE','NODE_ENV','AUTOMATION_TEST_DB_PORT','AUTOMATION_TEST_DB_PASSWORD') -notcontains $name) {
            $items.Add(($name + '=' + [string]$vars[$key]))
        }
    }
    foreach ($item in @('NODE_ENV=test', ('NODE_PATH=' + [IO.Path]::Combine($repo, 'scripts', 'fixtures', 'edge-cdp-deps', 'node_modules')),
        'AUTOMATION_TEST_DB_PORT=33621', ('AUTOMATION_TEST_DB_PASSWORD=' + $syntheticPassword),
        'EDGE_PROBE_DATABASE=1', 'EDGE_PROBE_REAL_WNS=1', 'EDGE_PROBE_RELAY_CALIBRATION=1',
        'EDGE_PROBE_CALIBRATION_RUNNER=1', 'EDGE_PROBE_CONNECT_VERSION=2', 'EDGE_PROBE_PINNED_HOSTED_PACKAGE=1')) { $items.Add($item) }
    . ([IO.Path]::Combine($repo, 'scripts', 'native-test', 'edge-hosted-probe-mode.ps1'))
    foreach ($item in @(Get-XEdgeHostedProbeFlags -Mode $Mode)) { $items.Add($item) }
    $items.Sort([StringComparer]::OrdinalIgnoreCase); $environment = ($items -join [char]0) + [char]0 + [char]0
    . ([IO.Path]::Combine($repo, 'scripts', 'native-test', 'edge-hosted-node-selection.ps1'))
    $nodeCommands = @(Get-Command node.exe -CommandType Application)
    $node = Select-XEdgeHostedNodePath -Commands $nodeCommands
    $probe = [IO.Path]::Combine($repo, 'experiments', 'chrome-push', 'edge-broker-pipe-probe.cjs')
    if (-not [IO.File]::Exists($node) -or (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ine 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32') { throw 'SYNTHETIC_NODE_INVALID' }
    if (-not [IO.Path]::IsPathRooted($probe) -or -not [IO.File]::Exists($probe) -or $probe -match '[\x00-\x1f<>"|?*]' -or
        -not [IO.Path]::IsPathRooted($repo) -or -not [IO.Directory]::Exists($repo) -or $repo -match '[\x00-\x1f<>"|?*]') { throw 'SYNTHETIC_LAUNCH_PATH_INVALID' }
    # Report only fixed booleans and a candidate count; never print PATH,
    # environment values, the executable path, or arguments.
    Write-Output ('Synthetic launch checks: nodeCandidates=' + $nodeCommands.Count + ' nodeScalar=true nodePinned=true probeValid=true workingDirectoryValid=true argumentsValid=true')
    $job = [XEdgeNative.CalibrationJob]::Start($node, ('"' + $probe + '"'), $repo, $environment)
    $inputBytes = New-Object byte[] 0; $outputBytes = $null
    try {
        $read = $job.ReadLimitedAsync(16384); $write = $job.WriteAndCloseAsync($inputBytes)
        $deadline = [DateTime]::UtcNow.AddSeconds(240)
        while (-not $job.WaitForExit(100)) { if ([DateTime]::UtcNow -ge $deadline) { throw 'SYNTHETIC_PROBE_TIMEOUT' } }
        if (-not $write.Wait(5000) -or -not $read.Wait(5000)) { throw 'SYNTHETIC_PROBE_FAILED' }
        $outputBytes = $read.GetAwaiter().GetResult(); $text = [Text.Encoding]::UTF8.GetString($outputBytes)
        if ($job.ExitCode -ne 0) {
            if ($text -match '(?m)^PROBE_SEND_STATUS ([A-Z0-9;-]+)\r?$') {
                $safeStatus = Get-XEdgeHostedSendStatus -Value $Matches[1]
                if ($null -ne $safeStatus) { Write-Output ('Synthetic send statuses: ' + $safeStatus) }
            }
            if ($text -match 'PROBE_STAGE ([a-z]+) ([A-Z0-9_]+)') { throw ('SYNTHETIC_PROBE_' + $Matches[1].ToUpperInvariant() + '_' + $Matches[2]) }
            throw 'SYNTHETIC_PROBE_FAILED'
        }
        $result = ConvertFrom-Json -InputObject $text
        Assert-XEdgeHostedProbeResult -Mode $Mode -Result $result
        if ($null -ne $result.sendStatuses) {
            $safeStatus = Get-XEdgeHostedSendStatus -Value $result.sendStatuses
            if ($null -eq $safeStatus) { throw 'SYNTHETIC_STATUS_INVALID' }
            Write-Output ('Synthetic send statuses: ' + $safeStatus)
        }
        Write-Output ('Synthetic signed Edge, pinned preview.15, version 2, database and WNS validation passed: ' + $Mode)
    } finally {
        try { $job.Stop() } finally { $job.Dispose() }
        [Array]::Clear($inputBytes, 0, $inputBytes.Length)
        if ($null -ne $outputBytes) { [Array]::Clear($outputBytes, 0, $outputBytes.Length) }
    }
} finally {
    if ($null -ne $dbProcess -and -not $dbProcess.HasExited) {
        $current = Get-Process -Id $dbProcess.Id -ErrorAction SilentlyContinue
        if ($null -ne $current -and $current.Path -ieq $server) { $current.Kill(); $current.WaitForExit() }
    }
    if ($null -ne $dbProcess) { $dbProcess.Dispose() }
}
