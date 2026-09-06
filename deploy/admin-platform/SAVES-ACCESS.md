# Separate saved-data permission preparation

The installer no longer walks `saves` or performs `setfacl -R`. Preparing the independent management runtime/core has no dependency on completion of this maintenance job. The new oneshot is installed but is not enabled, started, retried, or attached to another service automatically.

After filesystem responsiveness is confirmed, an operator may run one small batch:

```sh
systemctl start cbte-admin-saves-acl.service
journalctl -u cbte-admin-saves-acl.service -n 5 --no-pager
```

Each batch defaults to a two-second cooperative budget, 128 examined/discovered entries, and at most 16 ACL writes. It runs at nice 19, idle I/O priority and a 10% CPU quota in its own service. The helper accepts bounded overrides up to ten seconds, 4096 entries and 128 writes when invoked directly. A systemd ten-second start timeout and two-second stop timeout contain normal overruns. **Kernel uninterruptible I/O cannot be made killable by these limits.** If the unit has not stopped, do not start more repair/deployment work; diagnose that stall rather than stacking retries.

JSON journal output reports pending/completed paths, examined entries, changed/unchanged ACLs, excluded private control files, deferred paths, the current root-relative path and elapsed time. A root-only SQLite checkpoint in `/var/lib/cbte-admin-saves-acl` preserves the frontier across runs and crashes. Run another batch only after the previous one has exited and progress is still pending. A completed checkpoint does not walk the tree again on the next deployment. An interrupted directory enumeration may reread that directory's entry names, but completed child ACLs are not reread or rewritten. Very large or constantly changing directories may require manual investigation; this is not an unbounded recursive startup pass.

The source is fixed to `/root/comebacktwitterembed/saves` and the target user is fixed to `cbte-admin`. The checkpoint binds the root inode/device and target identity; an unexpected replacement fails rather than silently processing another tree. Linux no-follow descriptors are opened component by component. ACL operations use `libacl` on those pinned descriptors, including `/proc/self/fd` for existing directory defaults. Symlinks and non-regular files are skipped; hardlinked and set-ID files are deferred for review. Concurrent inode changes between ACL read and write are rejected for a later retry.

The helper reads existing permissions first and writes only when the administrator lacks the requested access (`rwX`, directory `rwx`). It preserves owner/other entries and preserves every other principal's **effective** group-class permissions when increasing the mask. It does not run recursive `chmod`, change owners/groups, elevate the worker to root, grant world access, or remove/migrate saved data. Existing administrator-owned files with restrictive owner mode are reported instead of pretending a named ACL overrides their owner entry. See [POSIX ACL access and creation rules](https://man7.org/linux/man-pages/man5/acl.5.html).

Existing default ACLs can receive the same conservative repair. **No first default ACL is created automatically**: doing so changes future umask inheritance and could otherwise widen access. New-file/new-directory access is governed by the application's opt-in shared save-control protocol, not by repeatedly rewriting the historical tree.

Private `.admin-save.lock` and `.admin-save-journal.json` files are counted separately and left unchanged. Their group/mode/ownership protocol is stricter than a generic access ACL. In particular, inherited ACL entries can be masked by explicit mode `0600`, and an access ACL cannot substitute for the required shared GID. A `complete` result means existing ordinary saved-data ACLs completed within this scope; it does not assert that legacy private control-file ownership has been repaired. Investigate such files through the explicit shared-control recovery workflow before changing them.

This source change does not run permission repair on any host. It reduces deployment I/O and avoids the former management startup dependency; it is not a claim that ACL activity caused or fixes the observed kernel/WBT stall.

The offline tests cover mask preservation, idempotence, batch limits and checkpoint reuse. The native Linux-root test uses only a temporary fixture and verifies the actual libacl descriptor round trip; run it on the target platform before choosing to start a production repair batch:

```sh
python3 -m unittest discover -s /opt/cbte-admin/worker-runtime/deploy/admin-platform/tests -p test_saves_access.py
```
