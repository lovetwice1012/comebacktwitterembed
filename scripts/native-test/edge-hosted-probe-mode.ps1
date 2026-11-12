# Pure mode-to-flag mapping. It does not inspect or modify the host.
function Get-XEdgeHostedProbeFlags {
    param([ValidateSet('normal', 'online-batch', 'offline-batch', 'offline-status')][string] $Mode = 'normal')
    if ($Mode -eq 'normal') { return }
    @('EDGE_PROBE_TAKEOVER=1', 'EDGE_PROBE_BLOCK_WNS=1', 'EDGE_PROBE_REIMPORT=1',
      'EDGE_PROBE_OFFLINE_MESSAGE=1', 'EDGE_PROBE_OFFLINE_BATCH=1')
    if ($Mode -eq 'online-batch') { 'EDGE_PROBE_BATCH_ONLINE=1' }
    else { 'EDGE_PROBE_OFFLINE_SETTLE=1' }
    if ($Mode -eq 'offline-status') { 'EDGE_PROBE_REQUEST_STATUS=1' }
}

function Get-XEdgeHostedSendStatus {
    param([string] $Value)
    $one = 'H(?:[2-5][0-9]{2}|UNKNOWN)-D(?:CONNECTED|DISCONNECTED|TEMPDISCONNECTED|TEMPCONNECTED|ABSENT|OTHER)-W(?:RECEIVED|DROPPED|CHANNELTHROTTLED|ABSENT|OTHER)'
    if ($Value -cmatch ('\A' + $one + '(?:;' + $one + '){0,2}\z')) { return $Value }
    return $null
}

# Check fixed fixture results without contacting a service or touching files.
function Assert-XEdgeHostedProbeResult {
    param([ValidateSet('normal', 'online-batch', 'offline-batch', 'offline-status')][string] $Mode, [object] $Result)
    if ($Result.syntheticProfile -ne $true -or $Result.realWnsWorkerTested -ne $true -or $Result.databaseRecovery -ne $true -or
        $Result.packagedExport -ne $true -or $Result.packagedSnapshotCleaned -ne $true -or $Result.otherSiteConsentRequired -ne $true -or
        $Result.explicitConnectVersion -cne '2') { throw 'SYNTHETIC_PROBE_INCOMPLETE' }
    if ($Mode -ne 'normal' -and ($Result.takeoverResult.receivedAfterForcedWorkerExit -ne $true -or
        $Result.takeoverResult.batchPersistedOnce -ne $true)) { throw 'SYNTHETIC_BATCH_INCOMPLETE' }
    if ($Mode -in @('offline-batch', 'offline-status') -and $Result.takeoverResult.receivedSentWhileOffline -ne $true) { throw 'SYNTHETIC_BATCH_INCOMPLETE' }
}
