'use strict';

// This is a disposable-hosted-CI experiment, not a setup tool. It enables only
// the fixed APNs system service for a synthetic Safari subscription test and
// restores its disabled state before returning. No user profile is read.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const LABEL = 'system/com.apple.apsd';
const PLIST = '/System/Library/LaunchDaemons/com.apple.apsd.plist';
const error = code => Object.assign(new Error(code), { code });

function disabledState(output) {
    if (typeof output !== 'string' || output.length > 262144) return 'unknown';
    const matches = [...output.matchAll(/^[\t ]*"com\.apple\.apsd"[\t ]*=>[\t ]*(true|false|disabled|enabled)[\t ]*$/gm)];
    return matches.length === 1 ? ['true', 'disabled'].includes(matches[0][1]) : 'unknown';
}

function serviceState(result) {
    if (!result || result.error || !Number.isInteger(result.status)) return 'unknown';
    if (result.status === 0) return 'loaded';
    // launchctl print's documented missing-service diagnostic on macOS is
    // accepted only for this exact label, system domain, and exit code. Any
    // permission error, unexpected output or format remains unknown.
    if (result.status !== 113 || typeof result.stderr !== 'string' || result.stderr.length > 4096) return 'unknown';
    const text = result.stderr.replace(/\r\n/g, '\n').trim();
    return /^(?:Bad request\.\n)?Could not find service "com\.apple\.apsd" in domain for system$/.test(text)
        ? 'not_loaded' : 'unknown';
}

function createExecutor(spawn) {
    if (typeof spawn !== 'function') throw error('FIXTURE_APSD_EXECUTOR_INVALID');
    return (file, args, options = {}) => spawn(file, args, { encoding: 'utf8', timeout: options.timeout || 10000,
        maxBuffer: 262144, stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        ...(options.env ? { env: options.env } : {}) });
}
const defaultExecute = createExecutor(spawnSync);

function runExperiment({ platform = process.platform, env = process.env, execute = defaultExecute,
    report = message => process.stdout.write(`${message}\n`) } = {}) {
    if (platform !== 'darwin' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
        || env.CBTE_SAFARI_APSD_EXPERIMENT !== '1' || typeof env.RUNNER_TEMP !== 'string'
        || !path.isAbsolute(env.RUNNER_TEMP) || typeof execute !== 'function' || typeof report !== 'function')
        throw error('FIXTURE_APSD_ENVIRONMENT_INVALID');
    function launchctl(...args) { return execute('/usr/bin/sudo', ['-n', '/bin/launchctl', ...args]); }
    function checked(result, code) {
        if (!result || result.error || !Number.isInteger(result.status)) throw error(code);
        return result;
    }
    const disabled = () => {
        const result = checked(launchctl('print-disabled', 'system'), 'FIXTURE_APSD_STATE_UNAVAILABLE');
        return result.status === 0 ? disabledState(result.stdout) : 'unknown';
    };
    // The initial disabled state is required so cleanup never disables a
    // service that the runner was already using. A pre-existing process or
    // loaded service is also a hard stop.
    if (disabled() !== true) throw error('FIXTURE_APSD_INITIAL_STATE_INVALID');
    const processCheck = checked(execute('/usr/bin/sudo', ['-n', '/usr/bin/pgrep', '-x', 'apsd']), 'FIXTURE_APSD_PROCESS_UNKNOWN');
    if (processCheck.status !== 1) throw error('FIXTURE_APSD_PROCESS_PRESENT_OR_UNKNOWN');
    const initialService = serviceState(launchctl('print', LABEL));
    if (initialService === 'loaded') throw error('FIXTURE_APSD_SERVICE_ALREADY_LOADED');
    if (initialService !== 'not_loaded') throw error('FIXTURE_APSD_SERVICE_UNKNOWN');
    let changed = false, loadAttempted = false, resultCode = 'FIXTURE_APSD_EXPERIMENT_FAILED', cleanupOk = false;
    try {
        // Record cleanup responsibility before the call: even a timed-out
        // enable command might already have changed the runner's setting.
        changed = true;
        if (checked(launchctl('enable', LABEL), 'FIXTURE_APSD_ENABLE_FAILED').status !== 0 || disabled() !== false)
            throw error('FIXTURE_APSD_ENABLE_FAILED');
        report('Safari CI APNs service: enabled');
        // Even a timed-out bootstrap may have loaded the service, so mark the
        // attempt before invoking it and always try to stop it on cleanup.
        loadAttempted = true;
        const bootstrap = checked(launchctl('bootstrap', 'system', PLIST), 'FIXTURE_APSD_BOOTSTRAP_FAILED');
        if (bootstrap.status !== 0 && checked(launchctl('print', LABEL), 'FIXTURE_APSD_BOOTSTRAP_FAILED').status !== 0)
            throw error('FIXTURE_APSD_BOOTSTRAP_FAILED');
        if (checked(launchctl('kickstart', LABEL), 'FIXTURE_APSD_START_FAILED').status !== 0)
            throw error('FIXTURE_APSD_START_FAILED');
        report('Safari CI APNs service: start requested');
        const test = checked(execute(process.execPath, ['--test', '--test-name-pattern=hosted Safari attempts a synthetic push subscription',
            path.join(__dirname, 'safari-hosted-push-subscribe.test.cjs')], { timeout: 420000, inherit: true,
            env: { ...env, CBTE_SAFARI_PUSH_HOSTED: '1', CBTE_SAFARI_SYNTHETIC_ALLOW: '1',
                CBTE_SAFARI_FIXTURE_HOST: '127.0.0.1', CBTE_SAFARI_FIXTURE_SCHEME: 'https' } }), 'FIXTURE_SAFARI_TEST_FAILED');
        resultCode = test.status === 0 ? 'FIXTURE_SAFARI_TEST_PASSED' : 'FIXTURE_SAFARI_TEST_FAILED';
    } catch (cause) {
        resultCode = typeof cause?.code === 'string' && /^FIXTURE_[A-Z_]+$/.test(cause.code) ? cause.code : 'FIXTURE_APSD_EXPERIMENT_FAILED';
    } finally {
        if (changed) {
            let stopped = !loadAttempted, disabledRestored = false;
            try {
                // The service was disabled and not loaded when this test began.
                // Stop only that fixed service. A failed or timed-out bootout
                // is unconfirmed, even if a follow-up lookup also fails.
                if (loadAttempted) stopped = checked(launchctl('bootout', LABEL), 'FIXTURE_APSD_CLEANUP_FAILED').status === 0;
            } catch { stopped = false; }
            try {
                // Always attempt to restore the disabled flag, including when
                // the separate bootout operation itself failed or timed out.
                const disable = checked(launchctl('disable', LABEL), 'FIXTURE_APSD_CLEANUP_FAILED');
                disabledRestored = disable.status === 0 && disabled() === true;
            } catch { disabledRestored = false; }
            cleanupOk = stopped && disabledRestored;
        }
        report(`Safari CI APNs service: restoration ${cleanupOk ? 'confirmed' : 'unconfirmed'}`);
    }
    if (!cleanupOk) throw error('FIXTURE_APSD_CLEANUP_FAILED');
    if (resultCode !== 'FIXTURE_SAFARI_TEST_PASSED') throw error(resultCode);
    return { state: 'passed', restored: true };
}

if (require.main === module) {
    try { runExperiment(); }
    catch (cause) { process.stderr.write(`${/^FIXTURE_[A-Z_]+$/.test(cause?.code || '') ? cause.code : 'FIXTURE_APSD_EXPERIMENT_FAILED'}\n`); process.exitCode = 1; }
}
module.exports = { createExecutor, disabledState, serviceState, runExperiment };
