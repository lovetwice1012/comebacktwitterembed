#requires -Version 5.1
<# Select exactly the first executable resolved from the test runner's PATH.
   A multi-element PowerShell property projection must never reach CreateProcess. #>
function Select-XEdgeHostedNodePath([object[]] $Commands) {
    if ($null -eq $Commands -or $Commands.Count -lt 1 -or $null -eq $Commands[0]) { throw 'SYNTHETIC_NODE_UNAVAILABLE' }
    $value = $Commands[0].Source
    if ($value -isnot [string] -or $value -notmatch '^[A-Za-z]:\\' -or $value -match '[\x00-\x1f<>"|?*]' -or
        -not [IO.Path]::IsPathRooted($value)) { throw 'SYNTHETIC_NODE_PATH_INVALID' }
    $full = [IO.Path]::GetFullPath($value)
    if ($full -ine $value -or [IO.Path]::GetFileName($full) -ine 'node.exe') { throw 'SYNTHETIC_NODE_PATH_INVALID' }
    return $full
}
