'use strict';

// Maintainer/server entry point. The Firefox data-export GUI does not require
// Node.js. This launcher never installs software, changes PATH, retries a failed
// process, or adds JIT/V8 switches to make a native crash disappear.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const NODE_VERSION = '24.21.0';
const NODE_EXE_SHA256 = 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32';
const NODE_ZIP_SHA256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';
const RELEASE_DIRECTORY = `node-v${NODE_VERSION}-win-x64`;
const SETUP_GUIDE = '保守担当者は PowerShell で scripts/setup-project-node.ps1 を実行してください。';

function failure(code, message) { return Object.assign(new Error(`${message} ${SETUP_GUIDE}`), { code }); }
function localWindowsPath(value) {
    if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value)
        || /[\0-\x1f<>"|?*]/.test(value) || value.slice(2).includes(':') // eslint-disable-line no-control-regex -- reject control bytes in Windows paths
        || value.slice(3).split(/[\\/]/).some(part => part === '.' || part === '..' || /[ .]$/.test(part))) {
        throw failure('PROJECT_NODE_PATH_INVALID', 'ローカルの実行環境の保存先を確認できません。');
    }
    return path.win32.normalize(value);
}

function assertRegularExecutable(executable, fileSystem) {
    // Refuse junctions/symlinks at every existing path component. A different
    // executable in another cache, NODE_BINARY or PATH is never a fallback.
    const parsed = path.win32.parse(executable);
    let candidate = parsed.root;
    try {
        const parts = executable.slice(parsed.root.length).split('\\');
        for (let index = 0; index < parts.length; index++) {
            candidate = path.win32.join(candidate, parts[index]);
            const info = fileSystem.lstatSync(candidate);
            if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
                throw failure('PROJECT_NODE_PATH_INVALID', '実行環境の保存先にリンクまたは不正なファイルがあります。');
            }
        }
    } catch (error) {
        if (error?.code?.startsWith('PROJECT_NODE_')) throw error;
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            throw failure('PROJECT_NODE_MISSING', `検証済みの Windows Node.js ${NODE_VERSION} が見つかりません。`);
        }
        throw failure('PROJECT_NODE_UNAVAILABLE', '実行環境のファイルを安全に確認できません。');
    }
    let hash;
    try { hash = createHash('sha256').update(fileSystem.readFileSync(executable)).digest('hex'); }
    catch { throw failure('PROJECT_NODE_UNAVAILABLE', '実行環境のファイルを安全に読み取れません。'); }
    if (hash !== NODE_EXE_SHA256) throw failure('PROJECT_NODE_HASH_MISMATCH', '実行環境の SHA-256 が一致しません。起動を中止しました。');
    return executable;
}

/** Dependency injection supports isolated tests; the CLI has no override flags. */
function resolveProjectNode(options = {}) {
    const platform = options.platform ?? process.platform;
    const execPath = options.execPath ?? process.execPath;
    if (platform !== 'win32') return execPath;
    const version = options.version ?? process.versions.node;
    const executable = version === NODE_VERSION
        ? localWindowsPath(execPath)
        : path.win32.join(localWindowsPath(options.localAppData ?? process.env.LOCALAPPDATA), 'cbte-runtimes', RELEASE_DIRECTORY, RELEASE_DIRECTORY, 'node.exe');
    return assertRegularExecutable(executable, options.fileSystem ?? fs);
}

function runProjectNode(args, options = {}) {
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
        return Promise.reject(failure('PROJECT_NODE_ARGUMENT_INVALID', 'Node.js の起動引数が不正です。'));
    }
    const executable = resolveProjectNode(options);
    const parent = options.parent ?? process;
    return new Promise((resolve, reject) => {
        let child, settled = false;
        const handlers = new Map();
        function cleanup() { for (const [signal, handler] of handlers) parent.removeListener(signal, handler); }
        function fail() {
            if (settled) return;
            settled = true; cleanup();
            reject(failure('PROJECT_NODE_START_FAILED', '検証済み Node.js の起動に失敗しました。再試行は行っていません。'));
        }
        try {
            child = (options.spawn ?? spawn)(executable, args, {
                cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env,
                stdio: 'inherit', windowsHide: true,
            });
        } catch { fail(); return; }
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
            const handler = () => { try { child.kill(signal); } catch { /* Exit/error determines the final result. */ } };
            handlers.set(signal, handler); parent.on(signal, handler);
        }
        child.once('error', fail);
        child.once('exit', (exitCode, signal) => {
            if (settled) return;
            settled = true; cleanup();
            resolve({ exitCode: Number.isInteger(exitCode) ? exitCode : null, signal: signal || null });
        });
    });
}

if (require.main === module) {
    Promise.resolve().then(() => runProjectNode(process.argv.slice(2))).then(result => {
        if (result.signal) {
            // Preserve normal signal termination for shells/process supervisors.
            try { process.kill(process.pid, result.signal); }
            catch { process.exitCode = 1; }
        } else process.exitCode = result.exitCode ?? 1;
    }).catch(error => {
        console.error(error?.code?.startsWith('PROJECT_NODE_') ? error.message : `Node.js を起動できません。 ${SETUP_GUIDE}`);
        process.exitCode = 1;
    });
}

module.exports = { NODE_VERSION, NODE_EXE_SHA256, NODE_ZIP_SHA256, RELEASE_DIRECTORY, resolveProjectNode, runProjectNode };
