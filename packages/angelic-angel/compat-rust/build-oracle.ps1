param(
  [string] $RustupDirectory = $env:RUSTUP_HOME,
  [string] $CargoDirectory = $env:CARGO_HOME,
  [string] $PerlBinaryDirectory = ''
)
$ErrorActionPreference = 'Stop'
if ($RustupDirectory) { $env:RUSTUP_HOME = $RustupDirectory }
if ($CargoDirectory) { $env:CARGO_HOME = $CargoDirectory; $env:PATH = "$CargoDirectory/bin;$env:PATH" }
if ($PerlBinaryDirectory) { $env:PATH = "$PerlBinaryDirectory;$env:PATH" }
$env:PERL_BADLANG = '0'
$compilerCandidates = @(
  'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/Common7/Tools/VsDevCmd.bat',
  'C:/Program Files/Microsoft Visual Studio/18/Community/Common7/Tools/VsDevCmd.bat'
)
$compilerSetup = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($compilerSetup) {
  & $env:ComSpec /c ('call "' + $compilerSetup + '" -no_logo -arch=x64 && set') | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
  }
}
& cargo build --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml') --locked
if ($LASTEXITCODE -ne 0) { throw 'Rust oracle build failed' }
