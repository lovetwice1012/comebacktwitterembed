@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
rem X通知を準備する画面を開きます。ファイルの送信は行いません。
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0Start-EdgeSetup.ps1"
exit /b %errorlevel%
