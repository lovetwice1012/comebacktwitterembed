#requires -Version 5.1
<#
.SYNOPSIS
設定時のローカル接続が、ツールが起動したブラウザーから来たか確認します。
.DESCRIPTION
接続元のプロセスと親子関係、起動時刻、実行ファイルを確認します。
許可できない接続は false を返し、通知データやパスは出力しません。
呼び出し元は、ループバックの接続を確認完了まで読み取らないでください。
#>
function Test-XEdgeOwnedLoopbackPeer {
    param([Parameter(Mandatory=$true)][int] $ClientPort,
          [Parameter(Mandatory=$true)][int] $ServerPort,
          [Parameter(Mandatory=$true)][int] $BrowserPid,
          [Parameter(Mandatory=$true)][long] $BrowserStartTicks,
          [Parameter(Mandatory=$true)][string] $BrowserExecutable)
    $processes = New-Object 'Collections.Generic.List[object]'
    try {
        if ($ClientPort -lt 1024 -or $ClientPort -gt 65535 -or $ServerPort -lt 1024 -or $ServerPort -gt 65535 -or
            $BrowserPid -le 4 -or $BrowserStartTicks -le 0 -or -not [IO.Path]::IsPathRooted($BrowserExecutable)) { return $false }
        $expected = [IO.Path]::GetFullPath($BrowserExecutable)
        $rows = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $ClientPort -RemoteAddress '127.0.0.1' -RemotePort $ServerPort -State Established -ErrorAction Stop)
        if ($rows.Count -ne 1 -or $rows[0].OwningProcess -le 4) { return $false }
        $peerPid = [int]$rows[0].OwningProcess; $current = $peerPid; $seen = @{}
        for ($depth = 0; $depth -lt 9; $depth++) {
            if ($current -le 4 -or $seen.ContainsKey($current)) { return $false }
            $seen[$current] = $true
            $process = Get-Process -Id $current -ErrorAction Stop
            try {
                $ticks = $process.StartTime.ToUniversalTime().Ticks
                $executable = [IO.Path]::GetFullPath($process.Path)
                if ($executable -ine $expected) { return $false }
                $processes.Add([pscustomobject]@{ pid = $current; ticks = $ticks })
            } finally { $process.Dispose() }
            if ($current -eq $BrowserPid) { break }
            $info = @(Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + $current) -ErrorAction Stop)
            if ($info.Count -ne 1 -or [int]$info[0].ProcessId -ne $current) { return $false }
            $current = [int]$info[0].ParentProcessId
        }
        if ($processes.Count -eq 0 -or $processes[$processes.Count - 1].pid -ne $BrowserPid -or
            $processes[$processes.Count - 1].ticks -ne $BrowserStartTicks) { return $false }
        for ($i = 0; $i -lt $processes.Count - 1; $i++) {
            if ($processes[$i].ticks -lt $processes[$i + 1].ticks) { return $false }
        }
        # PID 再利用や接続の切り替わりを避けるため、判定直前にもう一度照合します。
        foreach ($item in $processes) {
            $again = Get-Process -Id $item.pid -ErrorAction Stop
            try { if ($again.StartTime.ToUniversalTime().Ticks -ne $item.ticks -or [IO.Path]::GetFullPath($again.Path) -ine $expected) { return $false } }
            finally { $again.Dispose() }
        }
        $again = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $ClientPort -RemoteAddress '127.0.0.1' -RemotePort $ServerPort -State Established -ErrorAction Stop)
        return ($again.Count -eq 1 -and [int]$again[0].OwningProcess -eq $peerPid)
    } catch { return $false }
}
