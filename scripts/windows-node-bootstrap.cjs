'use strict';

const path = require('node:path');
const FAILURE_MESSAGE = 'プロジェクト専用Node.jsの確認または起動に失敗しました。保守担当者は PowerShell で scripts/setup-project-node.ps1 を実行してください。既存のNode.jsでは再試行していません。';

/**
 * Return true when the parent must stop loading application code. An affected
 * Windows Node only loads this filesystem/process bootstrap; application TCP
 * connections are created by the verified pinned child. The actual application
 * continues synchronously on Linux and in an already verified Windows process.
 * Options are dependency injection for isolated tests, never user CLI options.
 */
function handoffWindowsNode(entryPath, options = {}) {
    const current = options.process ?? process;
    if (current.platform !== 'win32' || current.versions?.bun) return false;
    const output = options.console ?? console;
    function failed() {
        // Neither a native exception message nor configuration/secret file
        // contents belong in this pre-application diagnostic.
        output.error(FAILURE_MESSAGE);
        current.exitCode = 1;
    }
    let runtime, runtimeOptions, executable;
    try {
        runtime = options.runtime ?? require('./run-project-node.cjs');
        runtimeOptions = { platform: current.platform, version: current.versions.node,
            execPath: current.execPath, localAppData: current.env.LOCALAPPDATA,
            parent: current, cwd: current.cwd(), env: current.env };
        executable = runtime.resolveProjectNode(runtimeOptions);
    }
    catch { failed(); return true; }
    // resolveProjectNode verifies a matching-version executable too. Comparing
    // normalized Windows paths avoids a second parent/child handoff or a loop.
    if (path.win32.normalize(executable).toLowerCase() === path.win32.normalize(current.execPath).toLowerCase()) return false;
    try {
        const inspector = options.inspector ?? require('node:inspector');
        // --inspect (including NODE_OPTIONS) already belongs to this temporary
        // parent. Release its listener before forwarding the same flags so the
        // healthy child can bind that port. close() waits until it has stopped.
        // Do not touch an inspector when verification fails or no handoff is
        // needed; active debugger connections are closed only for this switch.
        if (inspector.url()) inspector.close();
    } catch { failed(); return true; }
    const args = [...current.execArgv, entryPath, ...current.argv.slice(2)];
    Promise.resolve().then(() => runtime.runProjectNode(args, runtimeOptions)).then(result => {
        if (result.signal) {
            try { current.kill(current.pid, result.signal); }
            catch { current.exitCode = 1; }
        } else current.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 1;
    }).catch(failed);
    return true;
}

module.exports = { handoffWindowsNode, FAILURE_MESSAGE };
