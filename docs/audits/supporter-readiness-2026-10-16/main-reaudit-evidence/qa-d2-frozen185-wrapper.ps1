# Run only the fixed local acceptance suite. This script does not access the
# production host, change Git, alter application settings, or replay any test.
# Preserve stdout/stderr and the native exit code separately from test results.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$reauditRepo = 'C:\Users\yussy\.codex\worktrees\x-realtime-choice-20261014\comebacktwitterembed'
$reauditRoot = 'C:\Users\yussy\AppData\Local\Temp\cbte-main-reaudit10-v8-source-rev3-20261016'
$reauditSource = 'd2e792d30a44723e603869b27970b05597d51a9d'
Set-Location -LiteralPath $reauditRepo
if ((& git rev-parse HEAD).Trim() -cne $reauditSource) { throw 'Unexpected fixed source' }
& git diff --exit-code HEAD -- src index.js package.json package-lock.json packages/angelic-angel dashboard scripts migrations
if ($LASTEXITCODE -ne 0) { throw 'Core files have changed' }
$reauditUntracked = & git ls-files --others --exclude-standard -- src index.js package.json package-lock.json packages/angelic-angel dashboard scripts migrations
if ($LASTEXITCODE -ne 0 -or $reauditUntracked) { throw 'Unexpected untracked core file' }
$reauditFiles = & node scripts/run-project-node.cjs -p 'require("./scripts/run-supporter-readiness-acceptance.cjs").files.length'
if ($LASTEXITCODE -ne 0 -or [int]$reauditFiles -ne 185) { throw 'Acceptance file inventory changed' }
$reauditXml = Join-Path $reauditRoot 'main-reaudit-d2e792d-frozen-185-tests.xml'
$reauditProgress = Join-Path $reauditRoot 'main-reaudit-d2e792d-frozen-185-progress.log'
$reauditOuter = Join-Path $reauditRoot 'main-reaudit-d2e792d-frozen-185-outer.log'
$reauditExitReceipt = Join-Path $reauditRoot 'main-reaudit-d2e792d-frozen-185-exit.json'
foreach ($reauditOutput in @($reauditXml, $reauditProgress, $reauditOuter, $reauditExitReceipt)) {
    if (Test-Path -LiteralPath $reauditOutput) { throw 'Existing run evidence must be preserved' }
}
$reauditStartedAt = [DateTime]::UtcNow.ToString('o')
$env:AUTOMATION_TEST_DB_PORT = '33621'
$env:SUPPORTER_READINESS_TEST_REPORT = $reauditXml
$env:SUPPORTER_READINESS_PROGRESS_REPORT = $reauditProgress
$reauditOuterClaim = [IO.File]::Open($reauditOuter, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$reauditOuterClaim.Dispose()
& node scripts/run-project-node.cjs scripts/run-supporter-readiness-acceptance.cjs 2>&1 | Tee-Object -FilePath $reauditOuter -Append
$reauditNativeExit = $LASTEXITCODE
if ($null -eq $reauditNativeExit) { throw 'Native process exit code missing' }
$reauditOutputHashes = [ordered]@{}
foreach ($reauditOutput in @($reauditXml, $reauditProgress, $reauditOuter)) {
    $reauditOutputHashes[[IO.Path]::GetFileName($reauditOutput)] = if (Test-Path -LiteralPath $reauditOutput) {
        (Get-FileHash -LiteralPath $reauditOutput -Algorithm SHA256).Hash.ToLowerInvariant()
    } else { $null }
}
$reauditReceipt = [ordered]@{
    status = 'native-exit-recorded-acceptance-not-yet-evaluated'
    sourceRevision = $reauditSource
    acceptanceTestFiles = 185
    exitCode = [int]$reauditNativeExit
    startedAt = $reauditStartedAt
    finishedAt = [DateTime]::UtcNow.ToString('o')
    outputSha256 = $reauditOutputHashes
    acceptance = $false
    productionAccessed = $false
    acceptanceSuiteOrAssertionRetriedByWrapper = $false
}
$reauditBytes = [Text.UTF8Encoding]::new($false).GetBytes(($reauditReceipt | ConvertTo-Json -Depth 5) + "`n")
$reauditReceiptStream = [IO.File]::Open($reauditExitReceipt, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $reauditReceiptStream.Write($reauditBytes, 0, $reauditBytes.Length) } finally { $reauditReceiptStream.Dispose() }
Write-Output ($reauditReceipt | ConvertTo-Json -Depth 5)
exit ([int]$reauditNativeExit)
