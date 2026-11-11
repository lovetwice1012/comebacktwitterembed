param([Parameter(Mandatory=$true)][string] $Base, [Parameter(Mandatory=$true)][string] $Firefox, [switch] $ReadCopiedOnly, [switch] $PipeBootstrap)
$ErrorActionPreference = 'Stop'
$basePath = [IO.Path]::GetFullPath($Base)
$tempPath = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($basePath).TrimEnd('\') -ine $tempPath -or
    [IO.Path]::GetFileName($basePath) -cnotmatch '^cbte-xpcshell-isolated-[0-9a-f]{32}$' -or
    ([IO.File]::GetAttributes($basePath) -band [IO.FileAttributes]::ReparsePoint)) { throw 'SYNTHETIC_ROOT_REQUIRED' }
$seed = [IO.Path]::Combine($basePath, 'seed')
$token = [IO.Path]::GetFileName($basePath).Substring('cbte-xpcshell-isolated-'.Length)
$reader = [IO.Path]::Combine($basePath, ('firefox-snapshot-' + $token))
foreach ($profile in @($seed, $reader)) {
    if (-not [IO.Directory]::Exists($profile) -or ([IO.File]::GetAttributes($profile) -band [IO.FileAttributes]::ReparsePoint)) { throw 'SYNTHETIC_PROFILE_REQUIRED' }
}
$repo = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
. ([IO.Path]::Combine($repo, 'client', 'angelic-setup', 'FirefoxReader.ps1'))
Initialize-XSetupReaderJob
. ([IO.Path]::Combine($repo, 'client', 'angelic-setup', 'EdgeCalibrationJob.ps1'))
if ($PipeBootstrap) { Initialize-XEdgeCalibrationJob }
if (-not [XSetupNative.ReaderJob]::IsSignedMozilla($Firefox)) { throw 'MOZILLA_SIGNATURE_REQUIRED' }
function Invoke-SyntheticGecko([string] $Mode, [string] $Profile, [string] $Expected) {
    $resultName = if ($Mode -eq 'seed') { 'result-seed.txt' } else { 'firefox-result-' + $token + '.json' }
    $result = [IO.Path]::Combine($basePath, $resultName)
    if ([IO.File]::Exists($result)) { throw 'SYNTHETIC_RESULT_EXISTS' }
    $variables = [Environment]::GetEnvironmentVariables('Process')
    $items = New-Object 'Collections.Generic.List[string]'
    foreach ($key in $variables.Keys) {
        $name = [string]$key
        if (-not $name.StartsWith('MOZ_', [StringComparison]::OrdinalIgnoreCase) -and
            -not $name.StartsWith('XRE_', [StringComparison]::OrdinalIgnoreCase) -and
            -not $name.StartsWith('XUL_', [StringComparison]::OrdinalIgnoreCase) -and
            -not $name.StartsWith('CBTE_SYNTHETIC_', [StringComparison]::OrdinalIgnoreCase) -and
            -not $name.StartsWith('CBTE_GECKO_', [StringComparison]::OrdinalIgnoreCase) -and
            @('APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP') -notcontains $name -and -not $name.StartsWith('=')) {
            $items.Add(($name + '=' + [string]$variables[$key]))
        }
    }
    $items.Add('CBTE_SYNTHETIC_MODE=' + $Mode)
    $items.Add('CBTE_SYNTHETIC_PROFILE=' + $Profile)
    $items.Add('CBTE_SYNTHETIC_READER=' + [IO.Path]::Combine($repo, 'client', 'angelic-setup', 'Read-PushSubscription.js'))
    $items.Add('CBTE_SYNTHETIC_RESULT=' + $result)
    $items.Add('CBTE_GECKO_SNAPSHOT=' + $Profile)
    $readerPath = [IO.Path]::Combine($repo, 'client', 'angelic-setup', 'Read-PushSubscription.js')
    $readerHash = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($readerHash.ComputeHash([IO.File]::ReadAllBytes($readerPath))).Replace('-', '').ToLowerInvariant() }
    finally { $readerHash.Dispose() }
    $items.Add('CBTE_GECKO_READER=' + $readerPath)
    $items.Add('CBTE_GECKO_READER_SHA256=' + $digest)
    $items.Add('CBTE_GECKO_RESULT=' + $result)
    $items.Add('CBTE_GECKO_UAID=22222222-2222-4222-8222-222222222222')
    $items.Add('CBTE_GECKO_VERSION=160.0-synthetic')
    $items.Add('MOZ_DISABLE_NONLOCAL_CONNECTIONS=1')
    foreach ($name in @('APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP')) { $items.Add($name + '=' + $basePath) }
    $items.Sort([StringComparer]::OrdinalIgnoreCase)
    $environment = ($items -join [char]0) + [char]0 + [char]0
    $fixture = if ($Mode -eq 'seed') { [IO.Path]::Combine($repo, 'scripts', 'native-test', 'firefox-xpcshell-fixture.js') }
        else { [IO.Path]::Combine($repo, 'client', 'angelic-setup', 'mac', 'FirefoxXPCShellReader.js') }
    $pipe = $PipeBootstrap -and $Mode -eq 'read'; $scriptBytes = $null; $writer = $null; $readerTask = $null; $job = $null
    try {
        if ($pipe) {
            $job = [XEdgeNative.CalibrationJob]::Start($Firefox, '-xpcshell -f -', $basePath, $environment)
            $scriptBytes = [IO.File]::ReadAllBytes($fixture)
            $readerTask = $job.ReadLimitedAsync(65536); $writer = $job.WriteAndCloseAsync($scriptBytes)
        } else { $job = [XSetupNative.ReaderJob]::Start($Firefox, ('-xpcshell -f "' + $fixture + '"'), $basePath, $environment) }
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        $valid = $false
        while (-not $valid -and [DateTime]::UtcNow -lt $deadline) {
            if ([IO.File]::Exists($result)) {
                try {
                    $text = [IO.File]::ReadAllText($result)
                    if ($Mode -eq 'seed') { $valid = $text -ceq $Expected }
                    else {
                        $value = ConvertFrom-Json -InputObject $text
                        $valid = $value.ok -eq $true -and $value.otherSubscriptionCount -eq 0 -and
                            $value.export.push.scope -ceq 'https://x.com/' -and
                            $value.export.push.uaid -ceq '22222222-2222-4222-8222-222222222222' -and
                            $value.export.provenance.browserVersion -ceq '160.0-synthetic'
                    }
                } catch { $valid = $false }
            }
            if (-not $valid) { Start-Sleep -Milliseconds 100 }
        }
        if (-not $valid) { throw 'SYNTHETIC_READ_FAILED' }
        if ($pipe -and (-not $writer.Wait(5000) -or $writer.IsFaulted)) { throw 'SYNTHETIC_PIPE_FAILED' }
    } finally {
        try { if ($null -ne $job) { $job.Stop() } } finally { if ($null -ne $job) { $job.Dispose() }; if ($null -ne $scriptBytes) { [Array]::Clear($scriptBytes,0,$scriptBytes.Length) } }
        if ($null -ne $readerTask) { $null = $readerTask.Wait(5000) }
    }
}
if (-not $ReadCopiedOnly) {
Invoke-SyntheticGecko 'seed' $seed 'CBTE_SYNTHETIC_SEED_OK'
$source = [IO.Path]::Combine($seed, 'storage', 'permanent', 'chrome', 'idb')
$target = [IO.Path]::Combine($reader, 'storage', 'permanent', 'chrome', 'idb')
[IO.Directory]::CreateDirectory($target) | Out-Null
$database = '2918063365piupsah'
$hashes = @{}
function Get-SyntheticHash([string] $File) {
    $algorithm = [Security.Cryptography.SHA256]::Create(); $stream = [IO.File]::OpenRead($File)
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)) }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
foreach ($suffix in @('.sqlite', '.sqlite-wal', '.sqlite-shm', '.sqlite-journal')) {
    $filename = $database + $suffix; $input = [IO.Path]::Combine($source, $filename)
    if ([IO.File]::Exists($input)) {
        if ([IO.File]::GetAttributes($input) -band [IO.FileAttributes]::ReparsePoint) { throw 'SYNTHETIC_LINK_REJECTED' }
        $hashes[$filename] = Get-SyntheticHash $input
        [IO.File]::Copy($input, [IO.Path]::Combine($target, $filename), $false)
    } elseif ($suffix -eq '.sqlite') { throw 'SYNTHETIC_DATABASE_MISSING' }
}
$blobs = [IO.Path]::Combine($source, $database + '.files')
if ([IO.Directory]::Exists($blobs)) {
    if ([IO.File]::GetAttributes($blobs) -band [IO.FileAttributes]::ReparsePoint) { throw 'SYNTHETIC_LINK_REJECTED' }
    Copy-Item -LiteralPath $blobs -Destination ([IO.Path]::Combine($target, $database + '.files')) -Recurse
}
}
Invoke-SyntheticGecko 'read' $reader 'CBTE_SYNTHETIC_READ_OK'
if (-not $ReadCopiedOnly) {
foreach ($filename in $hashes.Keys) {
    if ((Get-SyntheticHash ([IO.Path]::Combine($source, $filename))) -cne $hashes[$filename]) { throw 'SYNTHETIC_SOURCE_CHANGED' }
}
}
Write-Output 'SYNTHETIC_READ_OK'
