#requires -Version 5.1
<#
.SYNOPSIS
専用ブラウザーで設定したX通知の受信情報を、手動アップロード用ファイルに保存します。
.DESCRIPTION
このツールは受信情報を送信しません。ログインと通知設定、作成したファイルの
アップロードは利用者本人が行います。普段のブラウザー設定は開きません。
X以外の通知も同じ受信情報に含まれる場合、ファイル作成前に確認します。
#>
[CmdletBinding()]
param([ValidateSet('Status','Prepare','Open','Export')][string] $Action='Status',
      [ValidateSet('chrome','brave')][string] $Browser='chrome',
      [string] $PrivateRoot, [string] $OutputPath, [switch] $PromptForOtherNotifications,
      [switch] $AllowOtherNotifications)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Browser=$Browser.ToLowerInvariant()
$script:Utf8 = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $script:Utf8
$script:AppId = 'x-notification-setup'
$script:UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$script:SystemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$script:PackageRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([char]'\')
$script:PackageVersion = '0.1.0-chrome-preview.8'

function Fail-Safely([string]$Code,[string]$Message) { throw ($Code + ': ' + $Message) }
function Get-PathAttributes([string]$Path) {
    try { return [IO.File]::GetAttributes($Path) }
    catch [IO.FileNotFoundException] { return $null }
    catch [IO.DirectoryNotFoundException] { return $null }
}
function Get-LocalPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:[\\/]' -or $Value.Substring(2).Contains(':')) {
        Fail-Safely 'X_CHROME_PATH_INVALID' 'このPC内の保存場所を選んでください。'
    }
    foreach ($part in ($Value.Substring(3) -split '[\\/]')) {
        if ($part -eq '.' -or $part -eq '..' -or $part -match '[ .]$') { Fail-Safely 'X_CHROME_PATH_INVALID' '保存場所を選び直してください。' }
    }
    $full = [IO.Path]::GetFullPath($Value).TrimEnd([char]'\')
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($full))
    if ($drive.DriveType -in @([IO.DriveType]::Network,[IO.DriveType]::Unknown,[IO.DriveType]::NoRootDirectory)) {
        Fail-Safely 'X_CHROME_PATH_INVALID' 'このPC内の保存場所を選んでください。'
    }
    return $full
}
function Assert-SafePath([string]$Path) {
    $volume = [IO.Path]::GetPathRoot($Path); $current = $volume
    foreach ($part in @('') + @($Path.Substring($volume.Length) -split '\\')) {
        if ($part.Length -gt 0) { $current = [IO.Path]::Combine($current,$part) }
        $attributes = Get-PathAttributes $current
        if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Fail-Safely 'X_CHROME_PATH_INVALID' 'リンクを含まない、このPC内のフォルダーを選んでください。'
        }
    }
}
function Test-InPath([string]$Child,[string]$Parent) {
    return $Child.Equals($Parent,[StringComparison]::OrdinalIgnoreCase) -or $Child.StartsWith($Parent.TrimEnd([char]'\')+'\',[StringComparison]::OrdinalIgnoreCase)
}
function Assert-PropertyNames($Object,[string[]]$Expected) {
    if ($null -eq $Object) { throw 'Invalid object' }
    $names=@($Object.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names.Count -ne $Expected.Count) { throw 'Invalid object' }
    foreach ($name in $names) { if ($Expected -cnotcontains $name) { throw 'Invalid object' } }
}
function Read-SmallJson([string]$Path,[int]$MaxBytes=16384) {
    Assert-SafePath $Path
    $info=Get-Item -LiteralPath $Path -Force
    if ($info.PSIsContainer -or $info.Length -lt 1 -or $info.Length -gt $MaxBytes) { throw 'Invalid metadata' }
    return [IO.File]::ReadAllText($Path,$script:Utf8) | ConvertFrom-Json
}
function Write-NewJson([string]$Path,$Value) {
    Assert-SafePath $Path
    $bytes=$script:Utf8.GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress))
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function New-PrivateDirectory([string]$Path) {
    # 新しい専用フォルダーに、作成する瞬間から本人とSYSTEMだけの
    # アクセス権を設定します。既存フォルダーの権限は変更しません。
    if (-not ('XChromeNative.PrivateDirectory' -as [type])) {
        $source=@'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace XChromeNative {
 public static class PrivateDirectory {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public bool inherit; }
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectory(string path,ref SecurityAttributes attributes);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  public static void Create(string path,string sid) {
   IntPtr descriptor=IntPtr.Zero; uint size;
   try {
    if(!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;"+sid+")",1,out descriptor,out size))throw new Win32Exception();
    var attributes=new SecurityAttributes { length=Marshal.SizeOf(typeof(SecurityAttributes)),descriptor=descriptor,inherit=false };
    if(!CreateDirectory(path,ref attributes))throw new Win32Exception();
   } finally { if(descriptor!=IntPtr.Zero)LocalFree(descriptor); }
  }
 }
}
'@
        Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
    }
    [XChromeNative.PrivateDirectory]::Create($Path,$script:UserSid.Value)
}
function Assert-PrivateDirectory([string]$Path) {
    $dir=New-Object IO.DirectoryInfo($Path)
    if ($PSVersionTable.PSVersion.Major -le 5) { $acl=$dir.GetAccessControl() }
    else { $acl=[IO.FileSystemAclExtensions]::GetAccessControl($dir) }
    if (-not $acl.AreAccessRulesProtected) { throw 'Directory ACL not protected' }
    $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { throw 'Directory ACL mismatch' }
    $seen=@{}
    foreach ($rule in $rules) {
        $sid=$rule.IdentityReference.Value
        if ($sid -cne $script:UserSid.Value -and $sid -cne $script:SystemSid.Value) { throw 'Directory ACL mismatch' }
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Directory ACL mismatch' }
        $seen[$sid]=$true
    }
    if (-not $seen.ContainsKey($script:UserSid.Value) -or -not $seen.ContainsKey($script:SystemSid.Value)) { throw 'Directory ACL mismatch' }
}
function Assert-Package {
    $names=@('ChromeSetup.ps1','Start-ChromeSetup.ps1','ChromeSnapshot.ps1','NativeSetup.ps1','ChromeReader.cjs',
        'ChromeBroker.cjs','ChromeCapture.cjs','ChromeLevelDB.node','ChromeNode.exe','ChromeNode-LICENSE.txt',
        'ChromeDependencies-LICENSE.txt','はじめに.txt','Chromeで開始.cmd','Braveで開始.cmd','LICENSE')
    Assert-SafePath $script:PackageRoot
    $allowed=$names+@('package-manifest.json'); $entries=@(Get-ChildItem -LiteralPath $script:PackageRoot -Force)
    if ($entries.Count -ne $allowed.Count) { throw 'Package entries invalid' }
    foreach ($entry in $entries) { if ($entry.PSIsContainer -or $allowed -cnotcontains $entry.Name) { throw 'Package entries invalid' }; Assert-SafePath $entry.FullName }
    $manifest=Read-SmallJson ([IO.Path]::Combine($script:PackageRoot,'package-manifest.json')) 32768
    Assert-PropertyNames $manifest @('schemaVersion','packageId','version','files')
    if ($manifest.schemaVersion -ne 1 -or $manifest.packageId -cne 'x-notification-chrome-setup' -or $manifest.version -cne $script:PackageVersion) { throw 'Package invalid' }
    Assert-PropertyNames $manifest.files $names
    foreach ($name in $names) {
        $expected=$manifest.files.PSObject.Properties[$name].Value
        if ($expected -isnot [string] -or $expected -cnotmatch '^[0-9a-f]{64}$') { throw 'Package hash invalid' }
        if ($name -ceq 'ChromeNode.exe' -and $expected -cne 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32') { throw 'Runtime hash invalid' }
        $file=[IO.Path]::Combine($script:PackageRoot,$name); $info=Get-Item -LiteralPath $file -Force
        $limit=if ($name -ceq 'ChromeNode.exe') { 104857600 } else { 4194304 }
        if ($info.Length -lt 1 -or $info.Length -gt $limit) { throw 'Package size invalid' }
        $hash=[Security.Cryptography.SHA256]::Create(); $stream=[IO.File]::OpenRead($file)
        try { $actual=[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
        finally { $stream.Dispose(); $hash.Dispose() }
        if ($actual -cne $expected) { throw 'Package hash mismatch' }
    }
}
function Get-Owner {
    Assert-SafePath $script:Root
    if ($null -eq (Get-PathAttributes $script:Root)) { return $null }
    Assert-PrivateDirectory $script:Root
    $owner=Read-SmallJson ([IO.Path]::Combine($script:Root,'owner.json'))
    Assert-PropertyNames $owner @('schemaVersion','appId','profileId','rootPath','profilePath')
    $id=[Guid]::Empty
    if ($owner.schemaVersion -ne 1 -or $owner.appId -cne $script:AppId -or
        -not [Guid]::TryParseExact([string]$owner.profileId,'D',[ref]$id) -or
        $owner.rootPath -cne $script:Root -or $owner.profilePath -cne $script:Profile) { throw 'Owner mismatch' }
    foreach ($dir in @($script:Profile,$script:Launches)) {
        Assert-SafePath $dir
        if (-not [IO.Directory]::Exists($dir)) { throw 'Owner directory missing' }
    }
    $browserMarker=[IO.Path]::Combine($script:Root,'browser.json')
    if ($null -ne (Get-PathAttributes $browserMarker)) {
        $browserData=Read-SmallJson $browserMarker
        Assert-PropertyNames $browserData @('profileId','browser')
        if ($browserData.profileId -cne $owner.profileId -or $browserData.browser -cne $Browser) { throw 'Browser profile mismatch' }
    } elseif ($Browser -ceq 'brave') { throw 'Browser profile missing' }
    return $owner
}
function Get-ActiveLaunch($Owner) {
    $active=$null
    foreach ($item in @(Get-ChildItem -LiteralPath $script:Launches -Force)) {
        if ($item.PSIsContainer -or $item.Name -cnotmatch '^launch-[0-9a-f-]{36}\.json$') { throw 'Launch metadata invalid' }
        $record=Read-SmallJson $item.FullName
        $hasEngine=$null -ne $record.PSObject.Properties['engineVersion']
        if ($hasEngine) { Assert-PropertyNames $record @('schemaVersion','appId','profileId','pid','processStartedUtc','browserVersion','engineVersion','port','brokerToken') }
        else { Assert-PropertyNames $record @('schemaVersion','appId','profileId','pid','processStartedUtc','browserVersion','port','brokerToken') }
        $engineVersion=if ($hasEngine) { [string]$record.engineVersion } else { [string]$record.browserVersion }
        if ($record.schemaVersion -ne 1 -or $record.appId -cne $script:AppId -or $record.profileId -cne $Owner.profileId -or
            $record.pid -isnot [int] -and $record.pid -isnot [long] -or $record.browserVersion -isnot [string] -or
            $record.browserVersion -cnotmatch '^[0-9]{1,3}(\.[0-9]{1,5}){3}$' -or $engineVersion -cnotmatch '^[0-9]{1,3}(\.[0-9]{1,5}){3}$' -or $record.port -isnot [int] -or
            $record.port -lt 1024 -or $record.port -gt 65535 -or $record.brokerToken -isnot [string] -or
            $record.brokerToken -cnotmatch '^[0-9a-f]{64}$') { throw 'Launch metadata invalid' }
        $started=[DateTime]::MinValue
        if ($record.processStartedUtc -is [DateTime]) { $started=$record.processStartedUtc.ToUniversalTime() }
        elseif (-not [DateTime]::TryParseExact([string]$record.processStartedUtc,'o',[Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind,[ref]$started)) { throw 'Launch metadata invalid' }
        $process=Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
        if ($null -ne $process) {
            try {
                if ($process.StartTime.ToUniversalTime().Ticks -eq $started.ToUniversalTime().Ticks) {
                    if ($null -ne $active) { throw 'Multiple Chrome processes' }
                    if ([IO.Path]::GetFullPath($process.Path) -ine [IO.Path]::Combine($script:PackageRoot,'ChromeNode.exe')) { throw 'Broker process mismatch' }
                    $active=[pscustomobject]@{ pid=[int]$record.pid; started=$started; browserVersion=[string]$record.browserVersion; engineVersion=$engineVersion;
                        port=[int]$record.port; token=[string]$record.brokerToken }
                }
            } finally { $process.Dispose() }
        }
    }
    return $active
}
function Get-ChromeExecutable {
    # 親がPowerShell 7の場合も、現在のPowerShell自身に付属する署名検証
    # モジュールを明示して読み込み、異なる版のモジュール混入を防ぎます。
    $securityModule=[IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')
    Import-Module -Name $securityModule -ErrorAction Stop
    $relative=if ($Browser -ceq 'brave') { 'BraveSoftware\Brave-Browser\Application\brave.exe' } else { 'Google\Chrome\Application\chrome.exe' }
    $signer=if ($Browser -ceq 'brave') { 'Brave Software, Inc.' } else { 'Google LLC' }
    $browserLabel=if ($Browser -ceq 'brave') { 'Brave' } else { 'Google Chrome' }
    $candidates=@([IO.Path]::Combine($env:ProgramFiles,$relative))
    if (${env:ProgramFiles(x86)}) { $candidates+= [IO.Path]::Combine(${env:ProgramFiles(x86)},$relative) }
    if ($env:LOCALAPPDATA) { $candidates+= [IO.Path]::Combine($env:LOCALAPPDATA,$relative) }
    foreach ($candidate in $candidates) {
        if (-not [IO.File]::Exists($candidate)) { continue }
        Assert-SafePath $candidate
        $signature=Get-AuthenticodeSignature -LiteralPath $candidate
        if ($signature.Status -eq 'Valid' -and $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ceq $signer) { return $candidate }
    }
    Fail-Safely 'X_CHROME_NOT_FOUND' ($browserLabel+'をインストールしてから、もう一度お試しください。')
}
function Quote-WindowsArgument([string]$Value) {
    $escaped=[regex]::Replace($Value,'(\\*)"','$1$1\"'); $escaped=[regex]::Replace($escaped,'(\\+)$','$1$1')
    return '"'+$escaped+'"'
}
function Invoke-Helper([string]$Name,$InputObject) {
    if ($Name -cnotin @('ChromeCapture.cjs','ChromeReader.cjs')) { throw 'Helper invalid' }
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=[IO.Path]::Combine($script:PackageRoot,'ChromeNode.exe')
    $info.Arguments=Quote-WindowsArgument ([IO.Path]::Combine($script:PackageRoot,$Name))
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.RedirectStandardInput=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=$script:Utf8; $info.StandardErrorEncoding=$script:Utf8
    foreach ($name in @('NODE_OPTIONS','NODE_PATH','NODE_REPL_EXTERNAL_MODULE')) { $info.EnvironmentVariables.Remove($name) }
    $process=[Diagnostics.Process]::Start($info)
    try {
        $text=($InputObject | ConvertTo-Json -Depth 12 -Compress); $bytes=$script:Utf8.GetBytes($text)
        $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length); $process.StandardInput.Close()
        $out=$process.StandardOutput.ReadToEndAsync(); $err=$process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Helper timeout' }
        $text=$out.GetAwaiter().GetResult(); $null=$err.GetAwaiter().GetResult()
        if ($text.Length -gt 65536 -or [string]::IsNullOrWhiteSpace($text)) { throw 'Helper failed' }
        $result=$text | ConvertFrom-Json
        if ($result.ok -isnot [bool] -or ($process.ExitCode -ne 0 -and $result.ok)) { throw 'Helper failed' }
        return $result
    } finally { $process.Dispose() }
}
function Get-BrokerEndpoint($Launch) {
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $Launch.port -ErrorAction Stop | Where-Object { $_.LocalAddress -eq '127.0.0.1' })
    if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $Launch.pid) { throw 'Broker endpoint owner mismatch' }
    return [pscustomobject]@{ port=$Launch.port; token=$Launch.token }
}
function Start-PrivateBroker([string]$Chrome,[string]$Profile) {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=[IO.Path]::Combine($script:PackageRoot,'ChromeNode.exe')
    $info.Arguments=Quote-WindowsArgument ([IO.Path]::Combine($script:PackageRoot,'ChromeBroker.cjs'))
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.RedirectStandardInput=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=$script:Utf8; $info.StandardErrorEncoding=$script:Utf8
    foreach ($name in @('NODE_OPTIONS','NODE_PATH','NODE_REPL_EXTERNAL_MODULE')) { $info.EnvironmentVariables.Remove($name) }
    $process=[Diagnostics.Process]::Start($info); $success=$false
    try {
        $text=([ordered]@{chromePath=$Chrome;profilePath=$Profile} | ConvertTo-Json -Compress); $bytes=$script:Utf8.GetBytes($text)
        $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length); $process.StandardInput.Close()
        $line=$process.StandardOutput.ReadLineAsync()
        if (-not $line.Wait(20000)) { throw 'Broker timeout' }
        $text=$line.GetAwaiter().GetResult()
        if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 4096) { throw 'Broker result invalid' }
        $ready=$text | ConvertFrom-Json
        Assert-PropertyNames $ready @('ok','port','token','pid','browserPid','engineVersion')
        if ($ready.ok -ne $true -or $ready.pid -ne $process.Id -or $ready.port -isnot [int] -or $ready.port -lt 1024 -or
            $ready.port -gt 65535 -or $ready.token -isnot [string] -or $ready.token -cnotmatch '^[0-9a-f]{64}$' -or
            $ready.engineVersion -isnot [string] -or $ready.engineVersion -cnotmatch '^[0-9]{1,3}(\.[0-9]{1,5}){3}$') { throw 'Broker result invalid' }
        $result=[pscustomobject]@{ pid=[int]$process.Id; started=$process.StartTime.ToUniversalTime().ToString('o');
            port=[int]$ready.port; token=[string]$ready.token; engineVersion=[string]$ready.engineVersion }
        $success=$true; return $result
    } finally {
        if (-not $success -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}

try {
    try { Assert-Package } catch { Fail-Safely 'X_CHROME_PACKAGE_INVALID' 'ZIPを新しくダウンロードし、すべて展開してください。' }
    if ([string]::IsNullOrWhiteSpace($PrivateRoot)) { $PrivateRoot=[IO.Path]::Combine($env:LOCALAPPDATA,'XNotificationSetup',$(if ($Browser -ceq 'brave') { 'BraveSetup' } else { 'ChromeSetup' })) }
    $script:Root=Get-LocalPath $PrivateRoot
    if ($script:Root.Length -le 3 -or (Test-InPath $script:Root $script:PackageRoot) -or (Test-InPath $script:PackageRoot $script:Root)) { throw 'Unsafe root' }
    $script:Profile=[IO.Path]::Combine($script:Root,'chrome-profile'); $script:Launches=[IO.Path]::Combine($script:Root,'launches')
    $sha=[Security.Cryptography.SHA256]::Create()
    try { $mutexName=[BitConverter]::ToString($sha.ComputeHash($script:Utf8.GetBytes($script:Root.ToUpperInvariant()))).Replace('-','') } finally { $sha.Dispose() }
    $mutex=New-Object Threading.Mutex($false,('Local\XChromeSetup-'+$mutexName)); $held=$false
    try {
        try { $held=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held=$true }
        if (-not $held) { Fail-Safely 'X_CHROME_BUSY' '先に始めた操作が終わるまでお待ちください。' }
        $owner=Get-Owner
        if ($Action -eq 'Prepare' -and $null -eq $owner) {
            $parent=[IO.Path]::GetDirectoryName($script:Root); Assert-SafePath $parent
            if (-not [IO.Directory]::Exists($parent)) { $null=[IO.Directory]::CreateDirectory($parent); Assert-SafePath $parent }
            New-PrivateDirectory $script:Root; Assert-SafePath $script:Root; Assert-PrivateDirectory $script:Root
            $null=[IO.Directory]::CreateDirectory($script:Profile); $null=[IO.Directory]::CreateDirectory($script:Launches)
            $profileId=[Guid]::NewGuid().ToString('D')
            if ($Browser -ceq 'brave') {
                # このツール専用の新規プロファイルだけでGoogleの通知サービスを
                # 有効にします。普段使いのBrave設定には触れません。
                $braveDefault=[IO.Path]::Combine($script:Profile,'Default'); $null=[IO.Directory]::CreateDirectory($braveDefault)
                Write-NewJson ([IO.Path]::Combine($braveDefault,'Preferences')) ([ordered]@{ brave=[ordered]@{ gcm=[ordered]@{ channel_status=$true } } })
                Write-NewJson ([IO.Path]::Combine($script:Root,'browser.json')) ([ordered]@{ profileId=$profileId; browser='brave' })
            }
            Write-NewJson ([IO.Path]::Combine($script:Root,'owner.json')) ([ordered]@{ schemaVersion=1; appId=$script:AppId;
                profileId=$profileId; rootPath=$script:Root; profilePath=$script:Profile })
            $owner=Get-Owner
        }
        if ($Action -eq 'Open') {
            if ($null -eq $owner) { Fail-Safely 'X_CHROME_NOT_PREPARED' '最初にブラウザーの準備を行ってください。' }
            if ($null -ne (Get-ActiveLaunch $owner)) { Fail-Safely 'X_CHROME_BUSY' '設定用ブラウザーはすでに開いています。' }
            $chrome=Get-ChromeExecutable
            $broker=Start-PrivateBroker $chrome $script:Profile
            try {
                Write-NewJson ([IO.Path]::Combine($script:Launches,('launch-'+[Guid]::NewGuid().ToString('D')+'.json'))) ([ordered]@{
                    schemaVersion=1; appId=$script:AppId; profileId=$owner.profileId; pid=$broker.pid;
                    processStartedUtc=$broker.started; browserVersion=(Get-Item -LiteralPath $chrome).VersionInfo.FileVersion; engineVersion=$broker.engineVersion;
                    port=$broker.port; brokerToken=$broker.token })
            } catch {
                # 起動直後の自分の仲介プロセスだけを停止します。PIDが再利用
                # されている場合は別プロセスに触れません。
                $started=[DateTime]::ParseExact($broker.started,'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)
                $process=Get-Process -Id $broker.pid -ErrorAction SilentlyContinue
                if ($null -ne $process) {
                    try { if ($process.StartTime.ToUniversalTime().Ticks -eq $started.ToUniversalTime().Ticks -and
                        [IO.Path]::GetFullPath($process.Path) -ieq [IO.Path]::Combine($script:PackageRoot,'ChromeNode.exe')) { $process.Kill(); $process.WaitForExit() } }
                    finally { $process.Dispose() }
                }
                throw
            }
        }
        if ($Action -eq 'Export') {
            if ($null -eq $owner) { Fail-Safely 'X_CHROME_NOT_PREPARED' '設定用ブラウザーで通知をオンにしてください。' }
            $target=Get-LocalPath $OutputPath; Assert-SafePath $target
            if ((Test-InPath $target $script:Root) -or (Test-InPath $target $script:PackageRoot) -or
                $null -ne (Get-PathAttributes $target) -or -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($target))) {
                Fail-Safely 'X_CHROME_OUTPUT_INVALID' '新しいファイル名を選んでください。'
            }
            $launch=Get-ActiveLaunch $owner
            if ($null -eq $launch) { Fail-Safely 'X_CHROME_NOT_RUNNING' '設定用ブラウザーを開き、Xで通知をオンにしてください。' }
            $broker=Get-BrokerEndpoint $launch
            $capture=Invoke-Helper 'ChromeCapture.cjs' ([ordered]@{port=$broker.port;token=$broker.token})
            if ($capture.ok -ne $true) {
                if ($capture.errorCode -ceq 'X_CHROME_CAPTURE_AMBIGUOUS') { Fail-Safely 'X_CHROME_CAPTURE_AMBIGUOUS' '設定用ブラウザーでXのタブを1つだけ開き、もう一度お試しください。' }
                if ($capture.errorCode -ceq 'X_CHROME_CAPTURE_NOT_FOUND') { Fail-Safely 'X_CHROME_CAPTURE_NOT_FOUND' '設定用ブラウザーでXを開いてから、もう一度お試しください。' }
                Fail-Safely 'X_CHROME_CAPTURE_FAILED' '設定用ブラウザーのXタブで、ブラウザー通知と投稿通知をオンにしてください。'
            }
            $process=Get-Process -Id $launch.pid -ErrorAction SilentlyContinue
            if ($null -ne $process) {
                try {
                    if ($process.StartTime.ToUniversalTime().Ticks -eq $launch.started.ToUniversalTime().Ticks -and -not $process.WaitForExit(15000)) { throw 'Browser did not exit' }
                } finally { $process.Dispose() }
            }
            . ([IO.Path]::Combine($script:PackageRoot,'ChromeSnapshot.ps1'))
            $snapshot=Copy-XChromeSnapshot -ProfileRoot $script:Profile -PrivateRoot $script:Root
            try {
                $state=Read-SmallJson ([IO.Path]::Combine($snapshot.path,'Local State')) 1048576
                $wrapped=[Convert]::FromBase64String([string]$state.os_crypt.encrypted_key)
                if ($wrapped.Length -le 5 -or [Text.Encoding]::ASCII.GetString($wrapped,0,5) -cne 'DPAPI') { throw 'OS key invalid' }
                Add-Type -AssemblyName System.Security
                $protected=New-Object byte[] ($wrapped.Length-5); [Array]::Copy($wrapped,5,$protected,0,$protected.Length)
                $key=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
                if ($key.Length -ne 32) { throw 'OS key invalid' }
                try {
                    $reader=Invoke-Helper 'ChromeReader.cjs' ([ordered]@{snapshotPath=$snapshot.path;token=$snapshot.token;
                        subscription=$capture.subscription;browserVersion=$launch.browserVersion;engineVersion=$launch.engineVersion;
                        profileKey=([Convert]::ToBase64String($key).TrimEnd('=').Replace('+','-').Replace('/','_'))})
                } finally { [Array]::Clear($key,0,$key.Length) }
                if ($reader.ok -ne $true) {
                    if ($reader.errorCode -ceq 'X_CHROME_SNAPSHOT_UNSUPPORTED') { Fail-Safely 'X_CHROME_BROWSER_UNSUPPORTED' 'このブラウザーの通知保存形式はまだ対応していません。' }
                    if ($reader.errorCode -ceq 'X_CHROME_SNAPSHOT_AMBIGUOUS') { Fail-Safely 'X_CHROME_SUBSCRIPTION_AMBIGUOUS' 'Xの通知設定が複数見つかりました。設定用ブラウザーの通知設定を確認してください。' }
                    if ($reader.errorCode -ceq 'X_CHROME_SNAPSHOT_NOT_FOUND') { Fail-Safely 'X_CHROME_SUBSCRIPTION_NOT_FOUND' '設定用ブラウザーでXの通知をオンにしてから、もう一度お試しください。' }
                    Fail-Safely 'X_CHROME_READER_FAILED' 'Xの通知情報を確認できませんでした。設定用ブラウザーで通知をオンにしてください。'
                }
                if (($Browser -ceq 'brave' -and $reader.file.provenance.kind -cne 'brave-gcm') -or
                    ($Browser -ceq 'chrome' -and $reader.file.provenance.kind -cne 'chrome-gcm')) { throw 'Browser profile mismatch' }
                if ($reader.file.version -ne 2 -or $reader.otherSubscriptionCount -lt 0 -or $reader.otherSubscriptionCount -gt 63) { throw 'Reader failed' }
                $document=$reader.file | ConvertTo-Json -Depth 12 -Compress
            } finally { Remove-XChromeSnapshot -Snapshot $snapshot.path -Token $snapshot.token -PrivateRoot $script:Root }
            if ($reader.otherSubscriptionCount -gt 0 -and -not $AllowOtherNotifications) {
                if (-not $PromptForOtherNotifications) { Fail-Safely 'X_CHROME_OTHER_CONSENT_REQUIRED' 'X以外の通知も含まれています。確認してからファイルを作成してください。' }
                Add-Type -AssemblyName System.Windows.Forms
                $answer=[Windows.Forms.MessageBox]::Show('X以外の通知もサーバーに届く可能性があります。現在、X以外のデータは保存・復号せず破棄します。サーバーには届くため、技術的には取得できます。ファイルを作成しますか？','通知データの確認',[Windows.Forms.MessageBoxButtons]::YesNo,[Windows.Forms.MessageBoxIcon]::Information,[Windows.Forms.MessageBoxDefaultButton]::Button2)
                if ($answer -ne [Windows.Forms.DialogResult]::Yes) { Fail-Safely 'X_CHROME_CANCELLED' 'ファイルの作成を中止しました。' }
            }
            . ([IO.Path]::Combine($script:PackageRoot,'NativeSetup.ps1'))
            Initialize-XSetupReaderJob
            $stream=$null
            try {
                $stream=[XSetupNative.ReaderJob]::CreatePrivateFile($target,$script:UserSid.Value)
                $bytes=$script:Utf8.GetBytes($document); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true)
                $stream.Dispose(); $stream=$null
            } catch {
                $cleanupFailed=$_.Exception.ToString().Contains('X_SETUP_PRIVATE_CLEANUP_FAILED')
                if ($null -ne $stream) {
                    try { [XSetupNative.ReaderJob]::DeleteCreatedFile($stream) } catch { $cleanupFailed=$true }
                    finally { try { $stream.Dispose() } catch { $cleanupFailed=$true }; $stream=$null }
                }
                if ($cleanupFailed) { Fail-Safely 'X_CHROME_OUTPUT_CLEANUP_FAILED' '保存できませんでした。保存先に途中のファイルが残っていないか確認してください。' }
                throw
            } finally { if ($null -ne $stream) { $stream.Dispose() } }
        }
        $active=if ($null -ne $owner) { $null -ne (Get-ActiveLaunch $owner) } else { $false }
        [ordered]@{ok=$true;prepared=($null -ne $owner);active=$active;fileCreated=($Action -eq 'Export')} | ConvertTo-Json -Compress
    } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
} catch {
    $message=[string]$_.Exception.Message
    if ($message -notmatch '^X_CHROME_[A-Z_]+: ') { $message='X_CHROME_FAILED: 通知情報を保存できませんでした。設定用ブラウザーを開き、通知設定を確認してください。' }
    [ordered]@{ok=$false;message=$message} | ConvertTo-Json -Compress
    exit 1
}
