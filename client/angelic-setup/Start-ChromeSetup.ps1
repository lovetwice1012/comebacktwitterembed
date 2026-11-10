#requires -Version 5.1
<#
X通知用ファイルを作る画面です。設定用Chromeを開いて通知をオンにし、
「通知データを保存」を押すと、このPCのファイルを作成します。
ファイルをWeb画面にアップロードする操作は、ご本人が行います。
#>
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$script:Busy=$false
$script:Utf8=New-Object Text.UTF8Encoding($false)
$script:Root=$PSScriptRoot

function Quote-Argument([string]$Value) {
    $escaped=[regex]::Replace($Value,'(\\*)"','$1$1\"'); $escaped=[regex]::Replace($escaped,'(\\+)$','$1$1')
    return '"'+$escaped+'"'
}
function Invoke-ChromeSetup([string]$Action,[string]$OutputPath='') {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=[IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
    $args=@('-NoLogo','-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',
        [IO.Path]::Combine($script:Root,'ChromeSetup.ps1'),'-Action',$Action)
    if ($Action -eq 'Export') { $args+=@('-OutputPath',$OutputPath,'-PromptForOtherNotifications') }
    $info.Arguments=($args | ForEach-Object { Quote-Argument $_ }) -join ' '
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=$script:Utf8; $info.StandardErrorEncoding=$script:Utf8
    $process=[Diagnostics.Process]::Start($info)
    try {
        # Chromeの準備中は仲介プロセスが生き続けます。継承された出力ハンドルの
        # 終端を待たず、実処理が返す1行だけを読みます。
        $out=$process.StandardOutput.ReadLineAsync(); $null=$process.StandardError.ReadToEndAsync()
        while (-not $process.WaitForExit(100)) { [Windows.Forms.Application]::DoEvents() }
        if (-not $out.Wait(5000)) { throw 'setup result timeout' }
        $text=$out.GetAwaiter().GetResult()
        if ($text.Length -gt 65536 -or [string]::IsNullOrWhiteSpace($text)) { throw 'setup result invalid' }
        $result=$text | ConvertFrom-Json
        if ($result.ok -ne $true) {
            $message=[string]$result.message
            if ($message -notmatch '^X_CHROME_[A-Z_]+: ') { throw 'setup result invalid' }
            throw ($message -replace '^X_CHROME_[A-Z_]+: ','')
        }
        return $result
    } finally { $process.Dispose() }
}
function Set-Busy([bool]$Value) {
    $script:Busy=$Value; $script:OpenButton.Enabled=-not $Value; $script:SaveButton.Enabled=-not $Value
    $script:Form.UseWaitCursor=$Value; [Windows.Forms.Application]::DoEvents()
}
function Show-Error([string]$Message) {
    [void][Windows.Forms.MessageBox]::Show($script:Form,$Message,'X通知の準備',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Information)
}

$script:Form=New-Object Windows.Forms.Form
$script:Form.Text='X通知の準備'; $script:Form.StartPosition='CenterScreen'; $script:Form.ClientSize=New-Object Drawing.Size(540,410)
$script:Form.MinimumSize=New-Object Drawing.Size(556,449); $script:Form.MaximizeBox=$false
$script:Form.Font=New-Object Drawing.Font('Yu Gothic UI',10)
$heading=New-Object Windows.Forms.Label; $heading.Text='ChromeでX通知を準備'; $heading.AutoSize=$true
$heading.Font=New-Object Drawing.Font('Yu Gothic UI',15,[Drawing.FontStyle]::Bold); $heading.Location=New-Object Drawing.Point(22,20)
$script:Form.Controls.Add($heading)
$description=New-Object Windows.Forms.Label; $description.Location=New-Object Drawing.Point(25,64); $description.Size=New-Object Drawing.Size(480,82)
$description.Text="1. 設定用ChromeでXにログインします。`r`n2. 監視したいアカウントの投稿通知とブラウザー通知をオンにします。`r`n3. 通知データを保存し、Webの登録画面でファイルを選びます。"
$script:Form.Controls.Add($description)
$script:OpenButton=New-Object Windows.Forms.Button; $script:OpenButton.Text='設定用Chromeを開く'; $script:OpenButton.Location=New-Object Drawing.Point(25,154); $script:OpenButton.Size=New-Object Drawing.Size(240,42)
$script:Form.Controls.Add($script:OpenButton)
$script:SaveButton=New-Object Windows.Forms.Button; $script:SaveButton.Text='通知データを保存'; $script:SaveButton.Location=New-Object Drawing.Point(25,211); $script:SaveButton.Size=New-Object Drawing.Size(240,42)
$script:Form.Controls.Add($script:SaveButton)
$hint=New-Object Windows.Forms.Label; $hint.Location=New-Object Drawing.Point(25,270); $hint.Size=New-Object Drawing.Size(475,66)
$hint.Text="保存すると設定用Chromeが閉じます。`r`nファイルは登録画面でのみ使用してください。`r`nChromeを開き直した後も、保存して登録してください。"
$script:Form.Controls.Add($hint)
$script:Status=New-Object Windows.Forms.Label; $script:Status.Location=New-Object Drawing.Point(25,349); $script:Status.Size=New-Object Drawing.Size(475,40)
$script:Form.Controls.Add($script:Status)
$script:OpenButton.Add_Click({
    if ($script:Busy) { return }; Set-Busy $true
    try { $null=Invoke-ChromeSetup 'Prepare'; $null=Invoke-ChromeSetup 'Open'; $script:Status.Text='Xの通知をオンにしてから、通知データを保存してください。' }
    catch { Show-Error $_.Exception.Message } finally { Set-Busy $false }
})
$script:SaveButton.Add_Click({
    if ($script:Busy) { return }
    $dialog=New-Object Windows.Forms.SaveFileDialog
    try {
        $dialog.Title='通知データを保存'; $dialog.Filter='JSONファイル (*.json)|*.json'; $dialog.FileName='X通知データ.json'; $dialog.OverwritePrompt=$false
        if ($dialog.ShowDialog($script:Form) -ne [Windows.Forms.DialogResult]::OK) { return }
        $target=$dialog.FileName
        if ([IO.File]::Exists($target)) { Show-Error '新しいファイル名を選んでください。'; return }
    } finally { $dialog.Dispose() }
    $confirm=[Windows.Forms.MessageBox]::Show($script:Form,'設定用Chromeを閉じて、通知データを保存します。続けますか？','X通知の準備',
        [Windows.Forms.MessageBoxButtons]::YesNo,[Windows.Forms.MessageBoxIcon]::Information,[Windows.Forms.MessageBoxDefaultButton]::Button2)
    if ($confirm -ne [Windows.Forms.DialogResult]::Yes) { return }
    Set-Busy $true
    try { $null=Invoke-ChromeSetup 'Export' $target; $script:Status.Text='保存しました。Webの登録画面でファイルを選んでください。'; Show-Error '保存しました。Webの登録画面で、このファイルを選んでください。' }
    catch { Show-Error $_.Exception.Message } finally { Set-Busy $false }
})
$script:Form.Add_FormClosing({ param($sender,$eventArgs) if ($script:Busy) { $eventArgs.Cancel=$true } })
try { $null=Invoke-ChromeSetup 'Status'; [void]$script:Form.ShowDialog(); exit 0 }
catch { Show-Error 'ツールを確認できませんでした。ZIPをすべて展開し直してください。'; exit 2 }
finally { $script:Form.Dispose() }
