#requires -Version 5.1
<#
.SYNOPSIS
Edge で設定した X 通知の受信情報を、手動アップロード用ファイルに保存します。
.DESCRIPTION
設定用 Edge は普段のプロファイルと別です。このツールはファイルを送信しません。
X 以外の通知がサーバーに届く可能性がある場合、保存前に取り扱いを確認します。
#>
[CmdletBinding()]
param([ValidateSet('Status','Prepare','Open','Export')][string] $Action='Status',
      [string] $PrivateRoot, [string] $OutputPath, [switch] $PromptForOtherNotifications,
      [switch] $AllowOtherNotifications)
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
$request=[pscustomobject]@{ action=$Action; privateRoot=$PrivateRoot; outputPath=$OutputPath;
    prompt=[bool]$PromptForOtherNotifications; allow=[bool]$AllowOtherNotifications }
$packageRoot=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([char]'\')
$packageVersion='0.1.0-edge-preview.3'
function Assert-EdgeBootstrapPath([string]$Path) {
    $current=[IO.Path]::GetPathRoot($Path)
    foreach($part in $Path.Substring($current.Length).Split([char]92)) {
        if($part.Length){$current=[IO.Path]::Combine($current,$part)}
        if([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) {
            if([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint){throw 'Invalid package path'}
        }
    }
}
function Assert-EdgeBootstrapFields($Object,[string[]]$Names) {
    if($null -eq $Object){throw 'Invalid package metadata'}
    $actual=@($Object.PSObject.Properties|ForEach-Object{$_.Name})
    if($actual.Count -ne $Names.Count){throw 'Invalid package metadata'}
    foreach($name in $actual){if($Names -cnotcontains $name){throw 'Invalid package metadata'}}
}
function Assert-EdgeBootstrapPackage {
    $names=@('EdgeShared.ps1','EdgeSetup.ps1','Start-EdgeSetup.ps1','EdgeSnapshot.ps1','EdgeExport.ps1',
        'EdgeCalibration.ps1','EdgeCalibrationJob.ps1','EdgeEphemeralCertificate.ps1','EdgePeerIdentity.ps1','EdgePeerVerify.ps1','NativeSetup.ps1',
        'ChromeBroker.cjs','ChromeCapture.cjs','ChromeReader.cjs','EdgeBroker.cjs','EdgeCapture.cjs','EdgeReader.cjs','EdgeCalibrate.cjs',
        'ChromeLevelDB.node','ChromeNode.exe','ChromeNode-LICENSE.txt','ChromeDependencies-LICENSE.txt','はじめに.txt','Edgeで開始.cmd','LICENSE')
    Assert-EdgeBootstrapPath $packageRoot
    $allowed=$names+@('package-manifest.json');$entries=@(Get-ChildItem -LiteralPath $packageRoot -Force)
    if($entries.Count -ne $allowed.Count){throw 'Invalid package entries'}
    foreach($entry in $entries){if($entry.PSIsContainer -or $allowed -cnotcontains $entry.Name){throw 'Invalid package entries'};Assert-EdgeBootstrapPath $entry.FullName}
    $manifestPath=[IO.Path]::Combine($packageRoot,'package-manifest.json');$info=Get-Item -LiteralPath $manifestPath -Force
    if($info.Length -lt 1 -or $info.Length -gt 32768){throw 'Invalid package metadata'}
    $manifest=[IO.File]::ReadAllText($manifestPath,[Text.Encoding]::UTF8)|ConvertFrom-Json
    Assert-EdgeBootstrapFields $manifest @('schemaVersion','packageId','version','files')
    if($manifest.schemaVersion -ne 1 -or $manifest.packageId -cne 'x-notification-edge-setup' -or $manifest.version -cne $packageVersion){throw 'Invalid package metadata'}
    Assert-EdgeBootstrapFields $manifest.files $names
    foreach($name in $names){
        $expected=$manifest.files.PSObject.Properties[$name].Value
        if($expected -isnot [string] -or $expected -cnotmatch '^[0-9a-f]{64}$'){throw 'Invalid package hash'}
        if($name -ceq 'ChromeNode.exe' -and $expected -cne 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32'){throw 'Invalid runtime hash'}
        $file=[IO.Path]::Combine($packageRoot,$name);$item=Get-Item -LiteralPath $file -Force
        $limit=if($name -ceq 'ChromeNode.exe'){104857600}else{4194304}
        if($item.Length -lt 1 -or $item.Length -gt $limit){throw 'Invalid package size'}
        $hash=[Security.Cryptography.SHA256]::Create();$stream=[IO.File]::OpenRead($file)
        try{$actual=[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$hash.Dispose()}
        if($actual -cne $expected){throw 'Invalid package hash'}
    }
}
try {
    try { Assert-EdgeBootstrapPackage } catch { throw 'X_EDGE_PACKAGE_INVALID: ZIP を新しくダウンロードし、すべて展開してください。' }
    . ([IO.Path]::Combine($packageRoot,'EdgeShared.ps1')) -LibraryOnly -Browser edge
    $Action=$request.action;$PrivateRoot=$request.privateRoot;$OutputPath=$request.outputPath
    $PromptForOtherNotifications=$request.prompt;$AllowOtherNotifications=$request.allow
    $Browser='edge';$script:PackageVersion=$packageVersion
    if([string]::IsNullOrWhiteSpace($PrivateRoot)){$PrivateRoot=[IO.Path]::Combine($env:LOCALAPPDATA,'XNotificationSetup','EdgeSetup')}
    $script:Root=Get-LocalPath $PrivateRoot
    if($script:Root.Length -le 3 -or (Test-InPath $script:Root $script:PackageRoot) -or (Test-InPath $script:PackageRoot $script:Root)){throw 'Unsafe root'}
    $script:Profile=[IO.Path]::Combine($script:Root,'edge-profile');$script:Launches=[IO.Path]::Combine($script:Root,'launches')
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$mutexName=[BitConverter]::ToString($sha.ComputeHash($script:Utf8.GetBytes($script:Root.ToUpperInvariant()))).Replace('-','')}finally{$sha.Dispose()}
    $mutex=New-Object Threading.Mutex($false,('Local\XEdgeSetup-'+$mutexName));$held=$false
    try {
        try{$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true}
        if(-not $held){Fail-Safely 'X_EDGE_BUSY' '先に始めた操作が終わるまでお待ちください。'}
        $owner=Get-Owner
        if($Action -ceq 'Prepare' -and $null -eq $owner){
            $parent=[IO.Path]::GetDirectoryName($script:Root);Assert-SafePath $parent
            if(-not [IO.Directory]::Exists($parent)){$null=[IO.Directory]::CreateDirectory($parent);Assert-SafePath $parent}
            New-PrivateDirectory $script:Root;Assert-SafePath $script:Root;Assert-PrivateDirectory $script:Root
            $null=[IO.Directory]::CreateDirectory($script:Profile);$null=[IO.Directory]::CreateDirectory($script:Launches)
            $profileId=[Guid]::NewGuid().ToString('D')
            Write-NewJson ([IO.Path]::Combine($script:Root,'browser.json')) ([ordered]@{profileId=$profileId;browser='edge'})
            Write-NewJson ([IO.Path]::Combine($script:Root,'owner.json')) ([ordered]@{schemaVersion=1;appId=$script:AppId;profileId=$profileId;rootPath=$script:Root;profilePath=$script:Profile})
            $owner=Get-Owner
        }
        if($Action -ceq 'Open'){
            if($null -eq $owner){Fail-Safely 'X_EDGE_NOT_PREPARED' '最初にブラウザーの準備を行ってください。'}
            if($null -ne (Get-ActiveLaunch $owner)){Fail-Safely 'X_EDGE_BUSY' '設定用ブラウザーはすでに開いています。'}
            $relative='Microsoft\Edge\Application\msedge.exe';$edge=$null
            foreach($base in @(${env:ProgramFiles(x86)},$env:ProgramFiles,$env:LOCALAPPDATA)){
                if([string]::IsNullOrWhiteSpace($base)){continue};$candidate=[IO.Path]::Combine($base,$relative)
                if(-not [IO.File]::Exists($candidate)){continue};Assert-SafePath $candidate
                Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop
                $signature=Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $candidate
                if($signature.Status -eq 'Valid' -and $null -ne $signature.SignerCertificate -and $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ceq 'Microsoft Corporation'){$edge=$candidate;break}
            }
            if($null -eq $edge){Fail-Safely 'X_EDGE_NOT_FOUND' 'Microsoft Edge をインストールしてから、もう一度お試しください。'}
            $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=[IO.Path]::Combine($script:PackageRoot,'ChromeNode.exe')
            $info.Arguments=Quote-WindowsArgument ([IO.Path]::Combine($script:PackageRoot,'EdgeBroker.cjs'))
            $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
            $info.StandardOutputEncoding=$script:Utf8;$info.StandardErrorEncoding=$script:Utf8
            foreach($name in @('NODE_OPTIONS','NODE_PATH','NODE_REPL_EXTERNAL_MODULE')){$info.EnvironmentVariables.Remove($name)}
            $process=[Diagnostics.Process]::Start($info);$success=$false
            try {
                $bytes=$script:Utf8.GetBytes(([ordered]@{edgePath=$edge;profilePath=$script:Profile}|ConvertTo-Json -Compress))
                try{$process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length);$process.StandardInput.Close()}finally{[Array]::Clear($bytes,0,$bytes.Length)}
                $line=$process.StandardOutput.ReadLineAsync();if(-not $line.Wait(20000)){throw 'Broker timeout'};$ready=$line.GetAwaiter().GetResult()|ConvertFrom-Json
                Assert-PropertyNames $ready @('ok','port','token','pid','browserPid','engineVersion')
                if($ready.ok -ne $true -or $ready.pid -ne $process.Id -or $ready.port -isnot [int] -or $ready.port -lt 1024 -or $ready.port -gt 65535 -or
                    $ready.token -isnot [string] -or $ready.token -cnotmatch '^[0-9a-f]{64}$' -or $ready.engineVersion -cnotmatch '^[0-9]{1,3}(\.[0-9]{1,5}){3}$'){throw 'Invalid broker'}
                Write-NewJson ([IO.Path]::Combine($script:Launches,('launch-'+[Guid]::NewGuid().ToString('D')+'.json'))) ([ordered]@{
                    schemaVersion=1;appId=$script:AppId;profileId=$owner.profileId;pid=[int]$process.Id;processStartedUtc=$process.StartTime.ToUniversalTime().ToString('o');
                    browserVersion=(Get-Item -LiteralPath $edge).VersionInfo.FileVersion;engineVersion=[string]$ready.engineVersion;port=[int]$ready.port;brokerToken=[string]$ready.token })
                $success=$true
            } finally {if(-not $success -and -not $process.HasExited){$process.Kill();$process.WaitForExit()};$process.Dispose()}
        }
        if($Action -ceq 'Export'){
            if($null -eq $owner){Fail-Safely 'X_EDGE_NOT_PREPARED' '設定用ブラウザーで通知をオンにしてください。'}
            $target=Get-LocalPath $OutputPath;Assert-SafePath $target
            if((Test-InPath $target $script:Root) -or (Test-InPath $target $script:PackageRoot) -or $null -ne (Get-PathAttributes $target) -or -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($target))){Fail-Safely 'X_EDGE_OUTPUT_INVALID' '新しいファイル名を選んでください。'}
            $launch=Get-ActiveLaunch $owner;if($null -eq $launch){Fail-Safely 'X_EDGE_NOT_RUNNING' '設定用ブラウザーを開き、X で通知をオンにしてください。'}
            $broker=Get-BrokerEndpoint $launch;$capture=Invoke-Helper 'EdgeCapture.cjs' ([ordered]@{port=$broker.port;token=$broker.token})
            if($capture.ok -ne $true){Fail-Safely 'X_EDGE_CAPTURE_FAILED' '設定用ブラウザーの X タブで、ブラウザー通知と投稿通知をオンにしてください。'}
            $process=Get-Process -Id $launch.pid -ErrorAction SilentlyContinue
            if($null -ne $process){try{if($process.StartTime.ToUniversalTime().Ticks -eq $launch.started.ToUniversalTime().Ticks -and -not $process.WaitForExit(15000)){throw 'Browser did not exit'}}finally{$process.Dispose()}}
            $edge=$null;$relative='Microsoft\Edge\Application\msedge.exe'
            foreach($base in @(${env:ProgramFiles(x86)},$env:ProgramFiles,$env:LOCALAPPDATA)){if(-not [string]::IsNullOrWhiteSpace($base)){$candidate=[IO.Path]::Combine($base,$relative);if([IO.File]::Exists($candidate) -and (Get-Item -LiteralPath $candidate).VersionInfo.FileVersion -ceq $launch.browserVersion){$edge=$candidate;break}}}
            if($null -eq $edge){Fail-Safely 'X_EDGE_BROWSER_CHANGED' 'ブラウザーを開き直してから、通知データを保存してください。'}
            . ([IO.Path]::Combine($script:PackageRoot,'EdgeCalibration.ps1'))
            $calibration=Invoke-XEdgeCalibration -EdgePath $edge -BrowserVersion $launch.browserVersion
            . ([IO.Path]::Combine($script:PackageRoot,'EdgeExport.ps1'))
            Export-XEdgeTransfer -Capture $capture.subscription -Agent $calibration.agent -Client $calibration.client -BrowserVersion $launch.browserVersion -OutputPath $target `
                -PromptForOtherNotifications:$PromptForOtherNotifications -AllowOtherNotifications:$AllowOtherNotifications
        }
        $active=if($null -ne $owner){$null -ne (Get-ActiveLaunch $owner)}else{$false}
        [ordered]@{ok=$true;prepared=($null -ne $owner);active=$active;fileCreated=($Action -ceq 'Export')}|ConvertTo-Json -Compress
    } finally {if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}
} catch {
    $message=[string]$_.Exception.Message
    if($message -notmatch '^X_(?:EDGE|CHROME)_[A-Z_]+: '){$message='X_EDGE_FAILED: 通知情報を保存できませんでした。設定用ブラウザーの通知設定を確認してください。'}
    [ordered]@{ok=$false;message=$message}|ConvertTo-Json -Compress;exit 1
}
