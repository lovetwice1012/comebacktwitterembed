$ErrorActionPreference = 'Stop'
$cloudflared = 'C:/PROGRA~2/cloudflared/cloudflared.exe'
$sshOptions = @('-tt', '-o', "ProxyCommand=$cloudflared access ssh --hostname %h")
$logPath = Join-Path $PSScriptRoot '.tmp_dashboard_deploy_preflight.out'
$remoteScript = @'
set -eu
echo '== host =='
hostname
echo '== dashboard processes =='
ps -eo pid=,ppid=,etime=,args= | grep -E '[n]ext.*start|start-dashboard' || true
echo '== listener =='
ss -ltnp '( sport = :30987 )' || true
echo '== source and disk =='
cd /root/comebacktwitterembed
git status --short || true
df -h /root/comebacktwitterembed
echo '== dashboard build prerequisites =='
test -d dashboard/node_modules && echo node_modules=present || echo node_modules=missing
test -d dashboard/.next && echo next_build=present || echo next_build=missing
'@
$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
$remoteCommand = 'er -c ''sudo su - root -c "echo ' + $payload + ' | base64 -d | bash"'''
& ssh @sshOptions 'yussy@ssh.sprink.cloud' $remoteCommand 2>&1 | Tee-Object -FilePath $logPath
