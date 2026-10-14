@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
rem ======================================================================
rem X通知用ファイルの作成画面を開くための入口です。
rem このファイルをダブルクリックしてください。コマンドの入力は不要です。
rem この入口自体は、通知データの読み取り・アップロードを行いません。
rem 同じフォルダーの Start-Setup.ps1 にある説明画面を開くだけです。
rem 実際にデータを扱う前に、説明画面で内容と保存先を確認します。
rem 管理者への昇格や、PowerShellの永続的な設定変更は行いません。
rem ======================================================================
title X notification setup
if not exist "%~dp0Start-Setup.ps1" (
  echo 必要なファイルが見つかりません。
  echo ZIPを右クリックして「すべて展開」してから、展開したフォルダーで開いてください。
  echo このウィンドウを閉じるには、何かキーを押してください。
  pause >nul
  exit /b 2
)
rem 保存場所に空白や記号が含まれていても、引用符で1つの引数として渡します。
rem 入力された文字列をコマンドとして実行する仕組みや、追加引数の転送はありません。
rem Bypassは今回起動するプロセスだけの指定です。PC全体の実行ポリシーは変えません。
rem Hiddenは補助コンソール用です。利用者向けの説明画面は別ウィンドウで表示されます。
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0Start-Setup.ps1"
set "SETUP_RESULT=%ERRORLEVEL%"
rem 通常のエラー2/3は説明画面自身が案内済みです。
rem 構文エラーなど画面が開く前の予期しない失敗だけは、入口側でも説明を表示します。
if "%SETUP_RESULT%"=="0" goto finished
if "%SETUP_RESULT%"=="2" goto finished
if "%SETUP_RESULT%"=="3" goto finished
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -WindowStyle Normal -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('説明画面を開けませんでした。ZIPをすべて展開し直してください。PCや組織の制限で拒否されている場合は、その管理者へご相談ください。','X通知の準備ツール','OK','Error')"
if not errorlevel 1 goto finished
echo 説明画面を開けませんでした。ZIPの「はじめに読んでください.txt」を確認してください。
echo このウィンドウを閉じるには、何かキーを押してください。
pause >nul
:finished
exit /b %SETUP_RESULT%
