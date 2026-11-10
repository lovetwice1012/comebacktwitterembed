@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
rem X通知の準備画面をBrave用に開きます。ファイルの送信は行いません。
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0Start-ChromeSetup.ps1" -Browser brave
exit /b %errorlevel%
