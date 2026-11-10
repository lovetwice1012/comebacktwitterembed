#requires -Version 5.1
<#
専用Chromeの通知情報だけを読み取るための一時コピーを作ります。
このファイル自体はブラウザーを起動せず、ネットワーク送信も行いません。
呼び出し元は、所有マーカーとアクセス権を確認した専用フォルダー、
および終了済みの専用Chromeだけを渡してください。
#>

function Copy-XChromeSnapshot {
    param([Parameter(Mandatory=$true)][string] $ProfileRoot,
          [Parameter(Mandatory=$true)][string] $PrivateRoot)

    $expectedProfile = [IO.Path]::Combine($PrivateRoot, 'chrome-profile')
    if ($ProfileRoot -cne $expectedProfile) { throw 'X_CHROME_SNAPSHOT_INVALID: 専用の保存場所を確認できません。' }
    Assert-SafePath $PrivateRoot
    Assert-SafePath $ProfileRoot
    $token = [Guid]::NewGuid().ToString('N')
    $snapshot = [IO.Path]::Combine($PrivateRoot, ('chrome-snapshot-' + $token))
    Assert-SafePath $snapshot
    if ($null -ne (Get-PathAttributes $snapshot)) { throw 'X_CHROME_SNAPSHOT_INVALID: 一時保存先を準備できません。' }

    # LevelDBのロックを両方保持し、コピー中に専用Chromeが起動して
    # 通知データを書き換える場合は読み取りを開始しません。
    $store = [IO.Path]::Combine($ProfileRoot, 'Default', 'GCM Store')
    $encryption = [IO.Path]::Combine($store, 'Encryption')
    $locks = New-Object 'Collections.Generic.List[IO.FileStream]'
    $handles = New-Object 'Collections.Generic.List[object]'
    $created = $false
    try {
        foreach ($dir in @($store, $encryption)) {
            Assert-SafePath $dir
            $lock = [IO.Path]::Combine($dir, 'LOCK')
            Assert-SafePath $lock
            try { $locks.Add([IO.File]::Open($lock, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)) }
            catch { throw 'X_CHROME_SNAPSHOT_BUSY: 設定用Chromeを閉じてから、もう一度お試しください。' }
        }
        $null = [IO.Directory]::CreateDirectory($snapshot)
        $created = $true
        Write-NewJson ([IO.Path]::Combine($snapshot, 'snapshot-owner.json')) ([ordered]@{
            appId = 'x-notification-setup'; kind = 'chrome-snapshot-v1'; token = $token
        })
        $total = [long]0
        foreach ($pair in @(
            @([IO.Path]::Combine($ProfileRoot, 'Local State'), 'Local State'),
            @([IO.Path]::Combine($ProfileRoot, 'Default', 'Preferences'), 'Default\Preferences')
        )) {
            $source = $pair[0]; Assert-SafePath $source
            $stream = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $handles.Add([pscustomobject]@{ Stream = $stream; Name = $pair[1] })
            $total += $stream.Length
            if ($stream.Length -gt 4194304 -or $total -gt 134217728) { throw 'X_CHROME_SNAPSHOT_TOO_LARGE: 通知設定のサイズを確認してください。' }
        }
        foreach ($pair in @(@($store, 'Default\GCM Store'), @($encryption, 'Default\GCM Store\Encryption'))) {
            $count = 0
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($pair[0])) {
                Assert-SafePath $entry
                $name = [IO.Path]::GetFileName($entry)
                $attributes = [IO.File]::GetAttributes($entry)
                if ($name -ceq 'Encryption' -and $pair[0] -ceq $store -and ($attributes -band [IO.FileAttributes]::Directory)) { continue }
                if ($name -ceq 'LOCK') { continue }
                if (($attributes -band [IO.FileAttributes]::Directory) -or
                    $name -cnotmatch '^(CURRENT|LOG|LOG\.old|MANIFEST-[0-9]+|[0-9]+\.(log|ldb|sst))$') {
                    throw 'X_CHROME_SNAPSHOT_UNSUPPORTED: このChromeの通知保存形式を確認できません。'
                }
                $count++
                if ($count -gt 256) { throw 'X_CHROME_SNAPSHOT_TOO_LARGE: 通知設定の件数を確認してください。' }
                $stream = [IO.File]::Open($entry, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
                $handles.Add([pscustomobject]@{ Stream = $stream; Name = [IO.Path]::Combine($pair[1], $name) })
                $total += $stream.Length
                if ($stream.Length -gt 67108864 -or $total -gt 134217728) { throw 'X_CHROME_SNAPSHOT_TOO_LARGE: 通知設定のサイズを確認してください。' }
            }
        }
        foreach ($item in $handles) {
            $target = [IO.Path]::Combine($snapshot, $item.Name)
            Assert-SafePath $target
            $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $item.Stream.CopyTo($output); $output.Flush($true) } finally { $output.Dispose() }
        }
        return [pscustomobject]@{ path = $snapshot; token = $token }
    }
    catch {
        if ($created) {
            try { Remove-XChromeSnapshot -Snapshot $snapshot -Token $token -PrivateRoot $PrivateRoot }
            catch { throw 'X_CHROME_SNAPSHOT_CLEANUP_FAILED: 一時保存先を確認できません。サポートへご相談ください。' }
        }
        throw
    }
    finally {
        foreach ($item in $handles) { $item.Stream.Dispose() }
        foreach ($lock in $locks) { $lock.Dispose() }
    }
}

function Remove-XChromeSnapshot {
    param([Parameter(Mandatory=$true)][string] $Snapshot, [Parameter(Mandatory=$true)][string] $Token,
          [Parameter(Mandatory=$true)][string] $PrivateRoot)
    # 自分が今回作成した、直下の所有マーカー付きフォルダーだけを対象にします。
    if ($Token -cnotmatch '^[0-9a-f]{32}$' -or $Snapshot -cne [IO.Path]::Combine($PrivateRoot, ('chrome-snapshot-' + $Token))) {
        throw 'X_CHROME_SNAPSHOT_CLEANUP_FAILED: 一時保存先を確認できません。'
    }
    Assert-SafePath $Snapshot
    $markerPath = [IO.Path]::Combine($Snapshot, 'snapshot-owner.json')
    $marker = Read-SmallJson $markerPath
    Assert-PropertyNames $marker @('appId', 'kind', 'token')
    if ($marker.appId -cne 'x-notification-setup' -or $marker.kind -cne 'chrome-snapshot-v1' -or $marker.token -cne $Token) {
        throw 'X_CHROME_SNAPSHOT_CLEANUP_FAILED: 一時保存先の所有情報を確認できません。'
    }
    $directories = New-Object 'Collections.Generic.List[string]'
    $files = New-Object 'Collections.Generic.List[string]'
    $directories.Add($Snapshot)
    for ($index = 0; $index -lt $directories.Count; $index++) {
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directories[$index])) {
            Assert-SafePath $entry
            if ($directories.Count + $files.Count -ge 1024) { throw 'X_CHROME_SNAPSHOT_CLEANUP_FAILED: 一時保存先の件数を確認できません。' }
            if ([IO.File]::GetAttributes($entry) -band [IO.FileAttributes]::Directory) { $directories.Add($entry) }
            elseif ($entry -cne $markerPath) { $files.Add($entry) }
        }
    }
    foreach ($file in $files) { [IO.File]::Delete($file) }
    for ($index = $directories.Count - 1; $index -gt 0; $index--) { [IO.Directory]::Delete($directories[$index], $false) }
    [IO.File]::Delete($markerPath)
    [IO.Directory]::Delete($Snapshot, $false)
}
