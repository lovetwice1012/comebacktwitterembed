'use strict';

// Local macOS dialogs. Scripts are fixed strings, not assembled from user
// data; the selected path is returned to the local writer and never uploaded.
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const fail = code => Object.assign(new Error(code), { code });
const SCRIPTS = Object.freeze({
    open: `display dialog "専用のChromeでXにログインし、通知をオンにします。\n完了したら登録用ファイルを保存し、登録画面からアップロードしてください。" with title "X通知の準備" buttons {"やめる", "Chromeを開く"} default button "Chromeを開く" cancel button "やめる"\nreturn "yes"`,
    notifications: `display dialog "専用ChromeでXにログインし、監視したいアカウントの投稿通知をオンにしてください。\n設定が終わったら次へ進みます。" with title "Xの通知をオンにする" buttons {"やめる", "設定できた"} default button "設定できた" cancel button "やめる"\nreturn "yes"`,
    retry: `display dialog "通知設定を確認できませんでした。専用ChromeでXの通知をオンにしてから、もう一度お試しください。" with title "通知設定を確認" buttons {"やめる", "もう一度確認"} default button "もう一度確認" cancel button "やめる"\nreturn "yes"`,
    keychain: `display dialog "通知情報を読むため、ChromeのKeychainへのアクセスを許可してください。\nこの鍵は普段のChromeとも共有され、他の情報の読み取りにも使えます。このツールでは通知情報の読み取りにだけ使います。" with title "Keychainへのアクセス" buttons {"やめる", "許可して進む"} default button "許可して進む" cancel button "やめる"\nreturn "yes"`,
    other: `display dialog "X以外の通知も含まれています。\nX以外の通知もサーバーに届くため取得可能ですが、現在は保存・利用せず破棄します。内容を確認し、このままファイルを作成しますか？" with title "ほかの通知について" buttons {"やめる", "確認して進む"} default button "確認して進む" cancel button "やめる"\nreturn "yes"`,
    destination: `set chosenFile to choose file name with prompt "登録用ファイルの保存先を選んでください。" default name "X通知の登録ファイル.json"\nreturn POSIX path of chosenFile`,
});

function createMacChromeDialogs() {
    if (process.platform !== 'darwin') throw fail('X_CHROME_MAC_DIALOG_UNSUPPORTED');
    async function show(script) {
        try {
            const result = await run('/usr/bin/osascript', ['-e', script], { timeout: 300000, maxBuffer: 16384, windowsHide: true });
            return result.stdout.replace(/\r?\n$/, '');
        } catch (error) {
            if (error?.code === 1 && /-128\b/.test(String(error.stderr || ''))) return null;
            throw fail('X_CHROME_MAC_DIALOG_FAILED');
        }
    }
    const yes = async script => await show(script) === 'yes';
    return Object.freeze({
        confirmOpen: () => yes(SCRIPTS.open),
        confirmNotifications: () => yes(SCRIPTS.notifications),
        retryCapture: () => yes(SCRIPTS.retry),
        confirmKeychain: () => yes(SCRIPTS.keychain),
        async confirmSave({ otherSubscriptionCount }) {
            if (!Number.isInteger(otherSubscriptionCount) || otherSubscriptionCount < 0 || otherSubscriptionCount > 63)
                throw fail('X_CHROME_MAC_DIALOG_FAILED');
            if (otherSubscriptionCount > 0 && !await yes(SCRIPTS.other)) return null;
            const selected = await show(SCRIPTS.destination);
            if (selected === null) return null;
            if (!path.isAbsolute(selected) || selected.includes('\0')) throw fail('X_CHROME_MAC_DIALOG_FAILED');
            return { confirmed: true, otherSitesConsent: otherSubscriptionCount > 0,
                directory: path.dirname(selected), filename: path.basename(selected) };
        },
    });
}
module.exports = { createMacChromeDialogs };
