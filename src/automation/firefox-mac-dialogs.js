'use strict';

// Fixed local dialogs for the experimental Firefox flow. No user-controlled
// value is interpolated into AppleScript or sent to a server.
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const fail = () => Object.assign(new Error('X_FIREFOX_MAC_DIALOG_FAILED'), { code: 'X_FIREFOX_MAC_DIALOG_FAILED' });
const SCRIPTS = Object.freeze({
    open: `display dialog "設定用FirefoxでXにログインし、監視するアカウントの投稿通知とブラウザー通知をオンにします。" with title "X通知の準備" buttons {"やめる", "Firefoxを開く"} default button "Firefoxを開く" cancel button "やめる"\nreturn "yes"`,
    closed: `display dialog "通知をオンにしたら、設定用Firefoxを閉じてください。" with title "Firefoxを閉じる" buttons {"やめる", "閉じた"} default button "閉じた" cancel button "やめる"\nreturn "yes"`,
    other: `display dialog "X以外の通知もサーバーに届くため取得可能ですが、現在は保存・利用せず破棄します。このままファイルを作成しますか？" with title "ほかの通知について" buttons {"やめる", "確認して進む"} default button "確認して進む" cancel button "やめる"\nreturn "yes"`,
    destination: `set chosenFile to choose file name with prompt "登録用ファイルの保存先を選んでください。" default name "X通知の登録ファイル.json"\nreturn POSIX path of chosenFile`,
    saved: `display dialog "ファイルを保存しました。登録画面で保存したファイルを選んでください。" with title "保存しました" buttons {"閉じる"} default button "閉じる"\nreturn "yes"`,
    stillOpen: `display dialog "設定用Firefoxを閉じてから、もう一度お試しください。" with title "Firefoxを閉じる" buttons {"閉じる"} default button "閉じる"\nreturn "yes"`,
    failed: `display dialog "準備を完了できませんでした。もう一度お試しください。改善しない場合はサポートにご相談ください。" with title "準備を確認" buttons {"閉じる"} default button "閉じる"\nreturn "yes"`,
});
/** @param {{experimental?: boolean}} [options] */
function createExperimentalMacFirefoxDialogs({ experimental } = {}) {
    if (experimental !== true || process.platform !== 'darwin') throw fail();
    async function show(script) {
        try { const result = await run('/usr/bin/osascript', ['-e', script], { timeout: 300000, maxBuffer: 16384, windowsHide: true });
            return result.stdout.replace(/\r?\n$/, ''); }
        catch (error) { if (error?.code === 1 && /-128\b/.test(String(error.stderr || ''))) return null; throw fail(); }
    }
    const yes = async script => await show(script) === 'yes';
    return Object.freeze({
        confirmOpen: () => yes(SCRIPTS.open), confirmClosed: () => yes(SCRIPTS.closed),
        async confirmSave({ otherSubscriptionCount }) {
            if (!Number.isInteger(otherSubscriptionCount) || otherSubscriptionCount < 0 || otherSubscriptionCount > 63) throw fail();
            if (otherSubscriptionCount > 0 && !await yes(SCRIPTS.other)) return null;
            const selected = await show(SCRIPTS.destination);
            if (selected === null) return null;
            if (!path.isAbsolute(selected) || selected.includes('\0')) throw fail();
            return { confirmed: true, otherSitesConsent: otherSubscriptionCount > 0,
                directory: path.dirname(selected), filename: path.basename(selected) };
        },
        async showSaved() { await show(SCRIPTS.saved); },
        async showError(code) { await show(code === 'X_FIREFOX_MAC_SETUP_BROWSER_OPEN' ? SCRIPTS.stillOpen : SCRIPTS.failed); },
    });
}
module.exports = { createExperimentalMacFirefoxDialogs };
