#requires -Version 5.1
<#
.SYNOPSIS
設定用 Edge の通知情報から、手動アップロード用ファイルを作成します。
.DESCRIPTION
X の通知情報を一時コピーから読み取り、選択されたファイルに保存します。
X 以外の通知が届く可能性がある場合、保存前に確認します。
ファイルのアップロードは利用者自身が行います。この処理は送信しません。
呼び出し元は、専用フォルダー、終了済みのブラウザー、正規パッケージ、
ブラウザーから取得した購読情報と接続情報を事前に確認してください。
#>

function Export-XEdgeTransfer {
    param([Parameter(Mandatory=$true)] $Capture, [Parameter(Mandatory=$true)] $Agent,
          [Parameter(Mandatory=$true)] $Client, [Parameter(Mandatory=$true)][string] $BrowserVersion,
          [string] $ConnectVersion = '1',
          [Parameter(Mandatory=$true)][string] $OutputPath, [switch] $PromptForOtherNotifications,
          [switch] $AllowOtherNotifications)

    if (@('1','2') -cnotcontains $ConnectVersion) { Fail-Safely 'X_EDGE_CALIBRATION_FAILED' '接続情報を確認できません。' }
    $target = Get-LocalPath $OutputPath
    Assert-SafePath $target
    if ((Test-InPath $target $script:Root) -or (Test-InPath $target $script:PackageRoot) -or
        $null -ne (Get-PathAttributes $target) -or -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($target))) {
        Fail-Safely 'X_EDGE_OUTPUT_INVALID' '新しいファイル名を選んでください。'
    }
    if ($Capture.scope -cne 'https://x.com/' -or $Capture.applicationServerKey -isnot [string] -or
        $Capture.endpoint -isnot [string] -or $Capture.keys.p256dh -isnot [string] -or $Capture.keys.auth -isnot [string]) {
        Fail-Safely 'X_EDGE_CAPTURE_FAILED' '設定用ブラウザーの X 通知設定を確認してください。'
    }
    . ([IO.Path]::Combine($script:PackageRoot, 'EdgeSnapshot.ps1'))
    $snapshot = Copy-XEdgeSnapshot -ProfileRoot $script:Profile -PrivateRoot $script:Root
    try {
        $request = [ordered]@{
            snapshotPath = $snapshot.path; token = $snapshot.token; browserVersion = $BrowserVersion; agent = $Agent; client = $Client
            expected = [ordered]@{ endpoint = $Capture.endpoint; publicKey = $Capture.keys.p256dh; auth = $Capture.keys.auth
                applicationServerKey = $Capture.applicationServerKey }
        }
        if ($ConnectVersion -ceq '2') { $request.connectVersion = '2' }
        $reader = Invoke-Helper 'EdgeReader.cjs' $request
        if ($reader.ok -ne $true -or $reader.file.version -ne 3 -or $reader.file.provenance.kind -cne 'edge-wns' -or
            $reader.otherSubscriptionCount -isnot [int] -or $reader.otherSubscriptionCount -lt 0 -or $reader.otherSubscriptionCount -gt 127 -or
            $reader.unclassifiedRecordCount -isnot [int] -or $reader.unclassifiedRecordCount -lt 0 -or $reader.unclassifiedRecordCount -gt 127 -or
            $reader.otherNotificationsPossible -isnot [bool] -or
            $reader.otherNotificationsPossible -ne ($reader.otherSubscriptionCount -gt 0 -or $reader.unclassifiedRecordCount -gt 0)) {
            Fail-Safely 'X_EDGE_READER_FAILED' 'X の通知情報を確認できませんでした。通知設定を確認してください。'
        }
        if ($ConnectVersion -ceq '2' -and $reader.file.push.connectVersion -cne '2') { Fail-Safely 'X_EDGE_READER_FAILED' '接続情報を確認できませんでした。' }
        $document = $reader.file | ConvertTo-Json -Depth 12 -Compress
    } finally { Remove-XEdgeSnapshot -Snapshot $snapshot.path -Token $snapshot.token -PrivateRoot $script:Root }

    if ($reader.otherNotificationsPossible -and -not $AllowOtherNotifications) {
        if (-not $PromptForOtherNotifications) { Fail-Safely 'X_EDGE_OTHER_CONSENT_REQUIRED' '通知データの取り扱いを確認してください。' }
        Add-Type -AssemblyName System.Windows.Forms
        $message = 'X 以外の通知がサーバーに届く可能性があります。現在は保存・復号せずに破棄しますが、技術的には取得できます。ファイルを作成しますか？'
        $answer = [Windows.Forms.MessageBox]::Show($message, '通知データの確認', [Windows.Forms.MessageBoxButtons]::YesNo,
            [Windows.Forms.MessageBoxIcon]::Information, [Windows.Forms.MessageBoxDefaultButton]::Button2)
        if ($answer -ne [Windows.Forms.DialogResult]::Yes) { Fail-Safely 'X_EDGE_CANCELLED' 'ファイルの作成を中止しました。' }
    }
    . ([IO.Path]::Combine($script:PackageRoot, 'NativeSetup.ps1'))
    Initialize-XSetupReaderJob
    $stream = $null
    try {
        # 新しいファイルを本人専用のアクセス権で作り、既存ファイルは上書きしません。
        $stream = [XSetupNative.ReaderJob]::CreatePrivateFile($target, $script:UserSid.Value)
        $bytes = $script:Utf8.GetBytes($document)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { [Array]::Clear($bytes, 0, $bytes.Length) }
        $stream.Dispose(); $stream = $null
    } catch {
        $cleanupFailed = $_.Exception.ToString().Contains('X_SETUP_PRIVATE_CLEANUP_FAILED')
        if ($null -ne $stream) {
            try { [XSetupNative.ReaderJob]::DeleteCreatedFile($stream) } catch { $cleanupFailed = $true }
            finally { try { $stream.Dispose() } catch { $cleanupFailed = $true }; $stream = $null }
        }
        if ($cleanupFailed) { Fail-Safely 'X_EDGE_OUTPUT_CLEANUP_FAILED' '保存先に途中のファイルが残っていないか確認してください。' }
        throw
    } finally { if ($null -ne $stream) { $stream.Dispose() } }
}
