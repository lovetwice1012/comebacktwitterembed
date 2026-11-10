#requires -Version 5.1
<#
.SYNOPSIS
設定用 Edge の通知データを、一時的な専用コピーに保存します。
.DESCRIPTION
設定用 Edge を閉じてから、通知データベースだけをコピーします。
コピーは設定ファイル作成後に消去します。この処理は通信しません。
呼び出し元は、本人だけが使える専用フォルダーと、その所有情報を
先に確認してください。普段のブラウザーのデータは対象にしません。
#>

function Copy-XEdgeSnapshot {
    param([Parameter(Mandatory=$true)][string] $ProfileRoot,
          [Parameter(Mandatory=$true)][string] $PrivateRoot)

    $expectedProfile = [IO.Path]::Combine($PrivateRoot, 'edge-profile')
    if ($ProfileRoot -cne $expectedProfile) { throw 'X_EDGE_SNAPSHOT_INVALID: 設定用の保存場所を確認できません。' }
    Assert-SafePath $PrivateRoot
    Assert-SafePath $ProfileRoot
    $token = [Guid]::NewGuid().ToString('N')
    $snapshot = [IO.Path]::Combine($PrivateRoot, ('edge-snapshot-' + $token))
    Assert-SafePath $snapshot
    if ($null -ne (Get-PathAttributes $snapshot)) { throw 'X_EDGE_SNAPSHOT_INVALID: 一時保存先を準備できません。' }
    $store = [IO.Path]::Combine($ProfileRoot, 'Default', 'EdgePushStorageWithConnectTokenAndKey')
    Assert-SafePath $store
    $lockPath = [IO.Path]::Combine($store, 'LOCK')
    Assert-SafePath $lockPath
    $lock = $null
    $handles = New-Object 'Collections.Generic.List[object]'
    $created = $false
    try {
        # コピー中のブラウザー起動・更新を防ぐため、元の DB のロックを保持します。
        try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw 'X_EDGE_SNAPSHOT_BUSY: 設定用 Edge を閉じてから、もう一度お試しください。' }
        $null = [IO.Directory]::CreateDirectory($snapshot)
        $created = $true
        Write-NewJson ([IO.Path]::Combine($snapshot, 'snapshot-owner.json')) ([ordered]@{
            appId = 'x-notification-setup'; kind = 'edge-snapshot-v1'; token = $token
        })
        $total = [long]0
        $count = 0
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($store)) {
            Assert-SafePath $entry
            $name = [IO.Path]::GetFileName($entry)
            $attributes = [IO.File]::GetAttributes($entry)
            if ($name -ceq 'LOCK') { continue }
            if (($attributes -band [IO.FileAttributes]::Directory) -or
                $name -cnotmatch '^(CURRENT|LOG|LOG\.old|MANIFEST-[0-9]+|[0-9]+\.(log|ldb|sst))$') {
                throw 'X_EDGE_SNAPSHOT_UNSUPPORTED: この Edge の通知保存形式を確認できません。'
            }
            $count++
            if ($count -gt 256) { throw 'X_EDGE_SNAPSHOT_TOO_LARGE: 通知設定の件数を確認してください。' }
            $stream = [IO.File]::Open($entry, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $handles.Add([pscustomobject]@{ Stream = $stream; Name = $name })
            $total += $stream.Length
            if ($stream.Length -gt 67108864 -or $total -gt 134217728) { throw 'X_EDGE_SNAPSHOT_TOO_LARGE: 通知設定のサイズを確認してください。' }
        }
        if ($count -eq 0) { throw 'X_EDGE_SNAPSHOT_INVALID: 通知設定が見つかりません。' }
        $destination = [IO.Path]::Combine($snapshot, 'Default', 'EdgePushStorageWithConnectTokenAndKey')
        Assert-SafePath $destination
        $null = [IO.Directory]::CreateDirectory($destination)
        foreach ($item in $handles) {
            $target = [IO.Path]::Combine($destination, $item.Name)
            Assert-SafePath $target
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $item.Stream.CopyTo($output); $output.Flush($true) } finally { $output.Dispose() }
        }
        return [pscustomobject]@{ path = $snapshot; token = $token }
    }
    catch {
        if ($created) {
            try { Remove-XEdgeSnapshot -Snapshot $snapshot -Token $token -PrivateRoot $PrivateRoot }
            catch { throw 'X_EDGE_SNAPSHOT_CLEANUP_FAILED: 一時保存先を確認できません。サポートへご相談ください。' }
        }
        throw
    }
    finally {
        foreach ($item in $handles) { $item.Stream.Dispose() }
        if ($null -ne $lock) { $lock.Dispose() }
    }
}

function Remove-XEdgeSnapshot {
    param([Parameter(Mandatory=$true)][string] $Snapshot, [Parameter(Mandatory=$true)][string] $Token,
          [Parameter(Mandatory=$true)][string] $PrivateRoot)
    # 今回このツールが作った、所有情報付きの一時フォルダーだけを消します。
    if ($Token -cnotmatch '^[0-9a-f]{32}$' -or $Snapshot -cne [IO.Path]::Combine($PrivateRoot, ('edge-snapshot-' + $Token))) {
        throw 'X_EDGE_SNAPSHOT_CLEANUP_FAILED: 一時保存先を確認できません。'
    }
    Assert-SafePath $Snapshot
    $markerPath = [IO.Path]::Combine($Snapshot, 'snapshot-owner.json')
    $marker = Read-SmallJson $markerPath
    Assert-PropertyNames $marker @('appId', 'kind', 'token')
    if ($marker.appId -cne 'x-notification-setup' -or $marker.kind -cne 'edge-snapshot-v1' -or $marker.token -cne $Token) {
        throw 'X_EDGE_SNAPSHOT_CLEANUP_FAILED: 一時保存先の所有情報を確認できません。'
    }
    $directories = New-Object 'Collections.Generic.List[string]'
    $files = New-Object 'Collections.Generic.List[string]'
    $directories.Add($Snapshot)
    for ($index = 0; $index -lt $directories.Count; $index++) {
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directories[$index])) {
            Assert-SafePath $entry
            if ($directories.Count + $files.Count -ge 1024) { throw 'X_EDGE_SNAPSHOT_CLEANUP_FAILED: 一時保存先の件数を確認できません。' }
            if ([IO.File]::GetAttributes($entry) -band [IO.FileAttributes]::Directory) { $directories.Add($entry) }
            elseif ($entry -cne $markerPath) { $files.Add($entry) }
        }
    }
    foreach ($file in $files) { [IO.File]::Delete($file) }
    for ($index = $directories.Count - 1; $index -gt 0; $index--) { [IO.Directory]::Delete($directories[$index], $false) }
    [IO.File]::Delete($markerPath)
    [IO.Directory]::Delete($Snapshot, $false)
}
