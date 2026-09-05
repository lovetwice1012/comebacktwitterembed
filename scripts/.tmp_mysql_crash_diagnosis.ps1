$ErrorActionPreference = 'Stop'
$cloudflared = 'C:/PROGRA~2/cloudflared/cloudflared.exe'
$sshOptions = @('-tt', '-o', "ProxyCommand=$cloudflared access ssh --hostname %h")
$logPath = Join-Path $PSScriptRoot '.tmp_mysql_crash_diagnosis.out'
$remoteScript = @'
set -u
echo '== time and host =='
date -Is
hostname
uptime
echo '== mysql service state =='
systemctl status mysql mariadb --no-pager -l || true
systemctl show mysql -p ActiveState -p SubState -p NRestarts -p ExecMainCode -p ExecMainStatus 2>/dev/null || true
systemctl show mariadb -p ActiveState -p SubState -p NRestarts -p ExecMainCode -p ExecMainStatus 2>/dev/null || true
echo '== mysql processes =='
ps -eo pid=,ppid=,etime=,rss=,vsz=,args= | grep -E '[m]ysqld|[m]ariadbd' || true
echo '== memory and filesystem =='
free -h
df -hT
df -i
echo '== kernel kill and I/O evidence =='
dmesg -T 2>/dev/null | grep -Ei 'out of memory|oom|killed process|mysqld|mariadbd|I/O error|ext4.*error|xfs.*error' | tail -n 160 || true
echo '== mysql service journal (last 7 days) =='
journalctl -u mysql -u mariadb --since '7 days ago' --no-pager -n 300 2>/dev/null || true
echo '== mysql error logs =='
for log in /var/log/mysql/error.log /var/log/mysql/mysqld.log /var/log/mysqld.log; do
  if [ -f "$log" ]; then
    echo "-- $log --"
    tail -n 250 "$log"
  fi
done
echo '== mysql configuration memory and recovery settings =='
grep -R -E '^[[:space:]]*(innodb_buffer_pool_size|max_connections|tmp_table_size|max_heap_table_size|log_error|innodb_force_recovery)' /etc/mysql /etc/my.cnf 2>/dev/null || true
echo '== recent system and service boots =='
last -x | head -n 40 || true
'@
$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
$remoteCommand = 'echo ' + $payload + ' | base64 -d | bash'
& ssh @sshOptions 'yussy@ssh.sprink.cloud' $remoteCommand 2>&1 | Tee-Object -FilePath $logPath
