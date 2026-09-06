#!/usr/bin/env bash
set -euo pipefail
# Prepare independent versioned runtimes. Cutover/restarts are explicit steps.
test "$#" = 2
source_root="$(readlink -f "$1")"
binary="$2"
test "$(id -u)" = 0
test "$source_root" = /root/comebacktwitterembed
test -f "$source_root/config.json"
test -f "$binary"
revision="$(git -C "$source_root" rev-parse HEAD)"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
if ! id cbte-admin >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/cbte-admin --shell /usr/sbin/nologin cbte-admin
fi
usermod -a -G systemd-journal cbte-admin
install -d -m 0755 /opt/cbte-admin/releases /opt/cbte-admin/runtimes
install -d -m 0700 /etc/cbte-admin
for state in cbte-admin cbte-admin-analysis cbte-admin-reports cbte-admin-shared; do
    install -d -m 0700 -o cbte-admin -g cbte-admin "/var/lib/$state"
done
install -d -m 0700 /var/lib/cbte-admin-bot-spool
runtime="/opt/cbte-admin/runtimes/$revision"
if ! test -f "$runtime/.runtime-ready"; then
    staging="/opt/cbte-admin/runtimes/.staging-$revision-$$"
    test ! -e "$staging"
    install -d -m 0755 "$staging"
    git -C "$source_root" archive HEAD | tar -xf - -C "$staging"
    cp -a --reflink=auto "$source_root/node_modules" "$staging/node_modules"
    cp -a --reflink=auto "$source_root/dashboard/node_modules" "$staging/dashboard/node_modules"
    install -m 0640 -o root -g cbte-admin "$source_root/config.json" "$staging/config.json"
    printf '%s\n' "$revision" > "$staging/.runtime-ready"
    if test -e "$runtime"; then
        echo "Incomplete runtime exists; preserve it for inspection: $runtime" >&2
        exit 1
    fi
    mv "$staging" "$runtime"
fi
install -d -m 0755 "/opt/cbte-admin/releases/$revision"
install -m 0755 "$binary" "/opt/cbte-admin/releases/$revision/cbte-admin"
# Existing saves permission repair is an independent, bounded maintenance job.
# Management startup must not wait for a recursive metadata rewrite.
for unit in cbte-admin cbte-admin-analysis cbte-admin-reports cbte-admin-executor; do
    if systemctl is-active --quiet "$unit.service"; then
        echo "Stop $unit before changing the independent runtime pointers." >&2
        exit 1
    fi
done
install -m 0644 "$source_root/deploy/systemd/cbte-admin-saves-acl.service" /etc/systemd/system/cbte-admin-saves-acl.service
for name in current worker-runtime; do
    if test -e "/opt/cbte-admin/$name" && ! test -L "/opt/cbte-admin/$name"; then
        echo "Refusing to replace a non-symlink: /opt/cbte-admin/$name" >&2
        exit 1
    fi
done
ln -s "releases/$revision" /opt/cbte-admin/current.next
mv -Tf /opt/cbte-admin/current.next /opt/cbte-admin/current
ln -s "runtimes/$revision" /opt/cbte-admin/worker-runtime.next
mv -Tf /opt/cbte-admin/worker-runtime.next /opt/cbte-admin/worker-runtime
python3 "$source_root/deploy/admin-platform/write-config.py" "$source_root" "$revision"
for unit in cbte-admin cbte-admin-analysis cbte-admin-reports cbte-admin-executor; do
    install -m 0644 "$source_root/deploy/systemd/$unit.service" "/etc/systemd/system/$unit.service"
done
install -D -m 0644 "$source_root/deploy/admin-platform/90-admin-platform.conf" /etc/systemd/system/cbte.service.d/90-admin-platform.conf
systemctl daemon-reload
echo "Prepared independent release $revision. Services and public routing have not been changed yet."
echo "Optional existing-saves ACL repair: systemctl start cbte-admin-saves-acl.service; inspect its JSON journal progress and repeat bounded batches if pending."
