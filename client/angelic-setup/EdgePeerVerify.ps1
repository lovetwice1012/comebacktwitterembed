#requires -Version 5.1
<# 設定用ブラウザーのプロセスと一時接続を照合します。通知データは扱いません。 #>
param([ValidateSet('Verify','Identity','Peer')][string] $Mode,
      [int] $BrowserPid, [string] $BrowserExecutable, [string] $BrowserStartTicks,
      [int] $ClientPort, [int] $ServerPort)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
try {
    if (-not [IO.Path]::IsPathRooted($BrowserExecutable)) { throw 'Invalid request' }
    $expected = [IO.Path]::GetFullPath($BrowserExecutable)
    if ($Mode -ceq 'Verify') {
        if ([IO.Path]::GetFileName($expected) -ine 'msedge.exe') { throw 'Executable mismatch' }
        $volume = [IO.Path]::GetPathRoot($expected); $current = $volume
        foreach ($part in ($expected.Substring($volume.Length) -split '\\')) {
            if ($part.Length -gt 0) { $current = [IO.Path]::Combine($current, $part) }
            if ([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid executable path' }
        }
        Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop
        $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $expected
        if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
            $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'Microsoft Corporation') { throw 'Invalid signature' }
        [ordered]@{ ok = $true } | ConvertTo-Json -Compress
    } elseif ($Mode -ceq 'Identity') {
        if ($BrowserPid -le 4) { throw 'Invalid request' }
        $process = Microsoft.PowerShell.Management\Get-Process -Id $BrowserPid -ErrorAction Stop
        try {
            if ([IO.Path]::GetFullPath($process.Path) -ine $expected) { throw 'Process mismatch' }
            $ticks = $process.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
            if ($ticks -cnotmatch '^\d{18}$') { throw 'Invalid start time' }
            [ordered]@{ ok = $true; startTicks = $ticks } | ConvertTo-Json -Compress
        } finally { $process.Dispose() }
    } elseif ($Mode -ceq 'Peer') {
        if ($BrowserPid -le 4 -or $BrowserStartTicks -cnotmatch '^\d{18}$') { throw 'Invalid start time' }
        . ([IO.Path]::Combine($PSScriptRoot, 'EdgePeerIdentity.ps1'))
        $allowed = Test-XEdgeOwnedLoopbackPeer -ClientPort $ClientPort -ServerPort $ServerPort -BrowserPid $BrowserPid `
            -BrowserStartTicks ([long]::Parse($BrowserStartTicks, [Globalization.CultureInfo]::InvariantCulture)) -BrowserExecutable $expected
        [ordered]@{ ok = [bool]$allowed } | ConvertTo-Json -Compress
        if (-not $allowed) { exit 1 }
    } else { throw 'Invalid request' }
} catch { [ordered]@{ ok = $false } | ConvertTo-Json -Compress; exit 1 }
