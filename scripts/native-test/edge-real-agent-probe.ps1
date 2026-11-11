param([Parameter(Mandatory=$true)][string] $Base, [Parameter(Mandatory=$true)][string] $Node)
$ErrorActionPreference = 'Stop'
$basePath = [IO.Path]::GetFullPath($Base)
$tempPath = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($basePath).TrimEnd('\') -ine $tempPath -or
    [IO.Path]::GetFileName($basePath) -cnotmatch '^cbte-edge-agent-probe-[0-9a-f]{32}$' -or
    ([IO.File]::GetAttributes($basePath) -band [IO.FileAttributes]::ReparsePoint)) { throw 'SYNTHETIC_ROOT_REQUIRED' }
$repo = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
. ([IO.Path]::Combine($repo, 'client', 'angelic-setup', 'EdgeCalibrationJob.ps1'))
Initialize-XEdgeCalibrationJob
$vars = [Environment]::GetEnvironmentVariables('Process'); $items = New-Object 'Collections.Generic.List[string]'
foreach ($key in $vars.Keys) {
    $name = [string]$key
    if (-not $name.StartsWith('=') -and -not $name.StartsWith('CBTE_EDGE_', [StringComparison]::OrdinalIgnoreCase) -and
        @('NODE_OPTIONS','NODE_PATH','NODE_REPL_EXTERNAL_MODULE') -notcontains $name) { $items.Add(($name + '=' + [string]$vars[$key])) }
}
$items.Add('CBTE_EDGE_AGENT_PROBE=1'); $items.Add('CBTE_EDGE_PROBE_BASE=' + $basePath)
if ($env:CBTE_RUN_EDGE_CONNECT_PROBE -ceq '1') { $items.Add('CBTE_EDGE_PROBE_CONNECT_VERSIONS=1') }
if (@('1','2') -ccontains $env:CBTE_RUN_EDGE_AUTH_VERSION) { $items.Add('CBTE_EDGE_PROBE_AUTH_VERSION=' + $env:CBTE_RUN_EDGE_AUTH_VERSION) }
$items.Sort([StringComparer]::OrdinalIgnoreCase); $environment = ($items -join [char]0) + [char]0 + [char]0
$script = [IO.Path]::Combine($repo, 'scripts', 'native-test', 'edge-real-agent-probe.cjs')
$job = [XEdgeNative.CalibrationJob]::Start($Node, ('"' + $script + '"'), $repo, $environment)
$inputBytes = New-Object byte[] 0; $outputBytes = $null
try {
    $read = $job.ReadLimitedAsync(8192); $write = $job.WriteAndCloseAsync($inputBytes)
    $deadline = [DateTime]::UtcNow.AddSeconds(75)
    while (-not $job.WaitForExit(100)) { if ([DateTime]::UtcNow -ge $deadline) { throw 'SYNTHETIC_PROBE_TIMEOUT' } }
    if (-not $write.Wait(5000) -or -not $read.Wait(5000) -or $job.ExitCode -ne 0) { throw 'SYNTHETIC_PROBE_FAILED' }
    $outputBytes = $read.GetAwaiter().GetResult(); $text = [Text.Encoding]::UTF8.GetString($outputBytes)
    $value = ConvertFrom-Json -InputObject $text
    if ($value.ok -isnot [bool]) { throw 'SYNTHETIC_PROBE_FAILED' }
    Write-Output $text
} finally {
    try { $job.Stop() } finally { $job.Dispose() }
    [Array]::Clear($inputBytes, 0, $inputBytes.Length)
    if ($null -ne $outputBytes) { [Array]::Clear($outputBytes, 0, $outputBytes.Length) }
}
