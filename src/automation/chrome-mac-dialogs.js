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
    saved: `display dialog "登録用ファイルを保存しました。\n登録画面を開き、保存したファイルを選んでください。" with title "保存しました" buttons {"閉じる"} default button "閉じる"\nreturn "yes"`,
    failed: `display dialog "準備を完了できませんでした。もう一度お試しください。改善しない場合はサポートにご相談ください。" with title "準備を確認" buttons {"閉じる"} default button "閉じる"\nreturn "yes"`,
    browserMissing: `display dialog "Chromeを確認できませんでした。Chromeをインストールまたは更新してから、もう一度お試しください。" with title "Chromeを確認" buttons {"閉じる"} default button "閉じる"\nreturn "yes"`,
    busy: `display dialog "専用Chromeまたは準備ツールが使用中です。終了してから、もう一度お試しください。" with title "使用中です" buttons {"閉じる"} default button "閉じる"\nreturn "yes"`,
    recovery: `display dialog "保存済みの設定を確認できませんでした。既存の設定を削除せずに、サポートにご相談ください。" with title "保存済みの設定を確認" buttons {"閉じる"} default button "閉じる"\nreturn "yes"`,
});
// Both variants are derived only from fixed application-owned literals.
// No user-controlled text is ever interpolated into AppleScript.
const BRAVE_SCRIPTS = Object.freeze({ .../** @type {Record<keyof typeof SCRIPTS, string>} */ (Object.fromEntries(Object.entries(SCRIPTS).map(([key, script]) => [key, script.replaceAll('Chrome', 'Brave')]))),
    open: `display dialog "専用のBraveでXにログインし、通知をオンにします。\n専用BraveではGoogleのプッシュ通知サービスを利用します。\n完了後、ファイルを保存して登録画面からアップロードしてください。" with title "X通知の準備" buttons {"やめる", "Braveを開く"} default button "Braveを開く" cancel button "やめる"\nreturn "yes"`,
    pushDisabled: `display dialog "設定用Braveの設定を開き、「プライバシーとセキュリティ」で「プッシュメッセージングにGoogleサービスを使用」をオンにしてください。\n設定後にBraveを閉じ、このツールをもう一度開いてください。" with title "Braveの通知をオンにする" buttons {"終了"} default button "終了"\nreturn "no"`,
    pushUnknown: `display dialog "設定用Braveの「プライバシーとセキュリティ」で「プッシュメッセージングにGoogleサービスを使用」がオンか確認してください。\n設定を変更した場合はBraveを閉じ、このツールをもう一度開いてください。" with title "Braveの通知を確認" buttons {"終了", "オンを確認"} default button "オンを確認" cancel button "終了"\nreturn "yes"` });

function createMacChromiumDialogs(browser) {
    const scripts = browser === 'chrome' ? SCRIPTS : browser === 'brave' ? BRAVE_SCRIPTS : null;
    const prefix = browser === 'brave' ? 'X_BRAVE_MAC_DIALOG' : 'X_CHROME_MAC_DIALOG';
    if (!scripts || process.platform !== 'darwin') throw fail(`${prefix}_UNSUPPORTED`);
    async function show(script) {
        try {
            const result = await run('/usr/bin/osascript', ['-e', script], { timeout: 300000, maxBuffer: 16384, windowsHide: true });
            return result.stdout.replace(/\r?\n$/, '');
        } catch (error) {
            if (error?.code === 1 && /-128\b/.test(String(error.stderr || ''))) return null;
            throw fail(`${prefix}_FAILED`);
        }
    }
    const yes = async script => await show(script) === 'yes';
    return Object.freeze({
        confirmOpen: () => yes(scripts.open),
        confirmNotifications: options => browser === 'brave' && options?.pushChannelStatus === 'disabled'
            ? yes(BRAVE_SCRIPTS.pushDisabled) : browser === 'brave' && options?.pushChannelStatus === 'unknown'
                ? yes(BRAVE_SCRIPTS.pushUnknown) : yes(scripts.notifications),
        retryCapture: () => yes(scripts.retry),
        confirmKeychain: () => yes(scripts.keychain),
        async showSaved() { await show(scripts.saved); },
        async showError(code) {
            const script = code === (browser === 'brave' ? 'X_BRAVE_MAC_BROWSER_INVALID' : 'X_CHROME_MAC_BROWSER_INVALID') ? scripts.browserMissing
                : ['X_CHROME_MAC_BROKER_BUSY', 'X_BRAVE_MAC_BROKER_BUSY', 'X_CHROME_MAC_LOCK_BUSY', 'X_CHROME_MAC_REGISTRY_BUSY'].includes(code) ? scripts.busy
                    : ['X_CHROME_MAC_REGISTRY_RECOVERY_REQUIRED', 'X_CHROME_MAC_PROFILE_INVALID'].includes(code) ? scripts.recovery : scripts.failed;
            await show(script);
        },
        async confirmSave({ otherSubscriptionCount }) {
            if (!Number.isInteger(otherSubscriptionCount) || otherSubscriptionCount < 0 || otherSubscriptionCount > 63)
                throw fail(`${prefix}_FAILED`);
            if (otherSubscriptionCount > 0 && !await yes(scripts.other)) return null;
            const selected = await show(scripts.destination);
            if (selected === null) return null;
            if (!path.isAbsolute(selected) || selected.includes('\0')) throw fail(`${prefix}_FAILED`);
            return { confirmed: true, otherSitesConsent: otherSubscriptionCount > 0,
                directory: path.dirname(selected), filename: path.basename(selected) };
        },
    });
}
const createMacChromeDialogs = () => createMacChromiumDialogs('chrome');
const createMacBraveDialogs = () => createMacChromiumDialogs('brave');
module.exports = { createMacChromeDialogs, createMacBraveDialogs };
