param([Parameter(Mandatory=$true)][string] $Base, [Parameter(Mandatory=$true)][string] $Firefox)
$ErrorActionPreference = 'Stop'
$basePath = [IO.Path]::GetFullPath($Base)
$tempPath = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($basePath).TrimEnd('\') -ine $tempPath -or
    [IO.Path]::GetFileName($basePath) -cnotmatch '^cbte-xpcshell-isolated-[0-9a-f]{32}$' -or
    ([IO.File]::GetAttributes($basePath) -band [IO.FileAttributes]::ReparsePoint)) { throw 'SYNTHETIC_ROOT_REQUIRED' }
$profile = [IO.Path]::Combine($basePath, 'profile')
if (-not [IO.Directory]::Exists($profile) -or ([IO.File]::GetAttributes($profile) -band [IO.FileAttributes]::ReparsePoint)) { throw 'SYNTHETIC_PROFILE_REQUIRED' }
$repo = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
. ([IO.Path]::Combine($repo, 'client', 'angelic-setup', 'FirefoxReader.ps1'))
Initialize-XSetupReaderJob
if (-not [XSetupNative.ReaderJob]::IsSignedMozilla($Firefox)) { throw 'MOZILLA_SIGNATURE_REQUIRED' }
$result = [IO.Path]::Combine($basePath, 'result.txt')
if ([IO.File]::Exists($result)) { throw 'SYNTHETIC_RESULT_EXISTS' }
$variables = [Environment]::GetEnvironmentVariables('Process')
$items = New-Object 'Collections.Generic.List[string]'
foreach ($key in $variables.Keys) {
    $name = [string]$key
    if (-not $name.StartsWith('MOZ_', [StringComparison]::OrdinalIgnoreCase) -and
        -not $name.StartsWith('XRE_', [StringComparison]::OrdinalIgnoreCase) -and
        -not $name.StartsWith('XUL_', [StringComparison]::OrdinalIgnoreCase) -and
        -not $name.StartsWith('CBTE_SYNTHETIC_', [StringComparison]::OrdinalIgnoreCase) -and
        @('APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP') -notcontains $name -and -not $name.StartsWith('=')) {
        $items.Add(($name + '=' + [string]$variables[$key]))
    }
}
$items.Add('CBTE_SYNTHETIC_PROFILE=' + $profile)
$items.Add('CBTE_SYNTHETIC_READER=' + [IO.Path]::Combine($repo, 'client', 'angelic-setup', 'Read-PushSubscription.js'))
$items.Add('CBTE_SYNTHETIC_RESULT=' + $result)
$items.Add('MOZ_DISABLE_NONLOCAL_CONNECTIONS=1')
foreach ($name in @('APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP')) { $items.Add($name + '=' + $basePath) }
$items.Sort([StringComparer]::OrdinalIgnoreCase)
$environment = ($items -join [char]0) + [char]0 + [char]0
$fixture = [IO.Path]::Combine($repo, 'scripts', 'native-test', 'firefox-xpcshell-fixture.js')
$job = [XSetupNative.ReaderJob]::Start($Firefox, ('-xpcshell -f "' + $fixture + '"'), $basePath, $environment)
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not [IO.File]::Exists($result) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (-not [IO.File]::Exists($result) -or [IO.File]::ReadAllText($result) -cne 'CBTE_SYNTHETIC_READ_OK') { throw 'SYNTHETIC_READ_FAILED' }
} finally {
    try { $job.Stop() } finally { $job.Dispose() }
}
Write-Output 'SYNTHETIC_READ_OK'
