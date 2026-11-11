'use strict';

// CI-only aggregate for a known synthetic process group. Command arguments,
// executable paths, process IDs and notification data are never logged.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
function summarizeSyntheticGroup(output, groupId) {
    const counts = { zombie: 0, live: 0, orphan: 0, chrome: 0, osascript: 0, other: 0 };
    for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (!match || Number(match[3]) !== groupId) continue;
        if (match[4].startsWith('Z')) counts.zombie++; else counts.live++;
        if (Number(match[2]) === 1) counts.orphan++;
        if (/Google Chrome|Chrome Helper|crashpad/i.test(match[5])) counts.chrome++;
        else if (/osascript$/i.test(match[5])) counts.osascript++;
        else counts.other++;
    }
    return counts;
}
async function describeSyntheticGroup(t, groupId, label) {
    if (!Number.isSafeInteger(groupId) || groupId < 2) return;
    try {
        const result = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,comm='], { timeout: 5000, maxBuffer: 1024 * 1024 });
        const counts = summarizeSyntheticGroup(result.stdout, groupId);
        t.diagnostic(`${label} synthetic group counts=${JSON.stringify(counts)}`);
    } catch { t.diagnostic(`${label} synthetic group inspection unavailable`); }
}
module.exports = { describeSyntheticGroup, summarizeSyntheticGroup };
