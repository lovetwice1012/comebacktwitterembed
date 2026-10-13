'use strict';

const fs = require('node:fs');
const path = require('node:path');

// systemd 245 on cgroup v1 limits RAM but does not implement MemorySwapMax.
// Before network access, constrain RAM+swap in this worker's own cgroup too.
function enforceCgroup(memoryBytes, io = fs) {
    const groups = io.readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n');
    const v1 = groups.map(line => line.split(':')).find(parts => parts[1].split(',').includes('memory'));
    const v2 = groups.map(line => line.split(':')).find(parts => parts[0] === '0' && parts[1] === '');
    const group = v1 || v2;
    if (!group || !/^\/system\.slice\/cbte-watch-[a-z0-9-]+\.service$/.test(group[2])) throw new Error('Acquisition is outside its dedicated cgroup.');
    const root = v1 ? '/sys/fs/cgroup/memory' : '/sys/fs/cgroup';
    const directory = path.posix.join(root, group[2]);
    const ramPath = path.posix.join(directory, v1 ? 'memory.limit_in_bytes' : 'memory.max');
    const ram = Number(io.readFileSync(ramPath, 'utf8').trim());
    if (!Number.isSafeInteger(ram) || ram <= 0 || ram > memoryBytes) throw new Error('Acquisition memory protection is unavailable.');
    const limits = io.readFileSync('/proc/self/limits', 'utf8');
    const addressSpace = limits.match(/^Max address space\s+(\d+)\s+(\d+)\s+bytes\s*$/m);
    if (!addressSpace || Number(addressSpace[2]) > 2147483648) throw new Error('Acquisition address-space protection is unavailable.');
    const swapPath = path.posix.join(directory, v1 ? 'memory.memsw.limit_in_bytes' : 'memory.swap.max');
    const required = v1 ? memoryBytes : 0;
    // Older kernels may disable swap accounting entirely. RLIMIT_AS still
    // bounds all address space, including memory that can move into swap.
    if (v1 && !io.existsSync(swapPath)) return { ramBytes: ram, totalBytes: 2147483648, swapBytes: null };
    if (String(io.readFileSync(swapPath, 'utf8').trim()) !== String(required)) throw new Error('Acquisition swap protection is unavailable.');
    return { ramBytes: ram, totalBytes: v1 ? required : ram, swapBytes: v1 ? null : 0 };
}

function limitUnitSwap(unit, memoryBytes, io = fs) {
    if (!/^cbte-watch-fetch-[a-f0-9-]+$/.test(unit)) throw new Error('Invalid acquisition unit.');
    const legacy = `/sys/fs/cgroup/memory/system.slice/${unit}.service/memory.memsw.limit_in_bytes`;
    const unified = `/sys/fs/cgroup/system.slice/${unit}.service/memory.swap.max`;
    if (io.existsSync(legacy.replace('memory.memsw.limit_in_bytes', 'memory.limit_in_bytes')) && !io.existsSync(legacy)) return;
    const file = io.existsSync(legacy) ? legacy : unified;
    const required = file === legacy ? memoryBytes : 0;
    io.writeFileSync(file, String(required));
    if (String(io.readFileSync(file, 'utf8').trim()) !== String(required)) throw new Error('Acquisition swap protection is unavailable.');
}

module.exports = { enforceCgroup, limitUnitSwap };
