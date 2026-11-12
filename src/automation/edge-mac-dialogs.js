'use strict';

// Fixed local dialogs only. Paths selected by the user stay on this Mac.
const path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(require('node:child_process').execFile);
const fail = () => Object.assign(new Error('X_EDGE_MAC_DIALOG_FAILED'), { code: 'X_EDGE_MAC_DIALOG_FAILED' });
const SCRIPTS = Object.freeze({
    open: `display dialog "設定用EdgeでXにログインし、通知をオンにします。\n準備のため一時的な接続を確認してから、設定用Edgeを開きます。" with title "X通知の準備" buttons {"やめる", "Edgeを開く"} default button "Edgeを開く" cancel button "やめる"\nreturn "yes"`,
    notifications: `display dialog "設定用EdgeでXにログインし、監視したいアカウントの投稿通知をオンにしてください。\n「設定できた」を押すと、設定用Edgeを閉じてファイルの作成に進みます。" with title "Xの通知をオンにする" buttons {"やめる", "設定できた"} default button "設定できた" cancel button "やめる"\nreturn "yes"`,
    closed: `display dialog "設定用Edgeの終了を確認できませんでした。\n設定用Edgeを閉じてから、もう一度確認してください。" with title "Edgeを閉じる" buttons {"やめる", "閉じた"} default button "閉じた" cancel button "やめる"\nreturn "yes"`,
    retry: `display dialog "通知設定を確認できませんでした。Xの通知をオンにして、もう一度お試しください。" with title "通知設定を確認" buttons {"やめる", "もう一度確認"} default button "もう一度確認" cancel button "やめる"\nreturn "yes"`,
    newProfile: `display dialog "設定用Edgeの情報を確認できませんでした。新しい設定用Edgeで、Xへのログインと通知設定をやり直せます。\n以前の設定用Edgeの情報と登録済みの受信情報は残ります。" with title "新しく設定する" buttons {"やめる", "新しく設定する"} default button "やめる" cancel button "やめる"\nreturn "yes"`,
    other: `display dialog "X以外の通知も含まれています。\nそれらもサーバーに届くため取得可能ですが、現時点では保存・利用せず破棄します。" with title "ほかの通知について" buttons {"やめる", "確認して進む"} default button "確認して進む" cancel button "やめる"\nreturn "yes"`,
    unknown: `display dialog "X以外の通知も含まれる可能性があります。\nそれらもサーバーに届くため取得可能ですが、現時点では保存・利用せず破棄します。" with title "ほかの通知について" buttons {"やめる", "確認して進む"} default button "確認して進む" cancel button "やめる"\nreturn "yes"`,
    destination: `set chosenFile to choose file name with prompt "登録用ファイルの保存先を選んでください。" default name "X通知の登録ファイル.json"\nreturn POSIX path of chosenFile`,
    saved: `display dialog "登録用ファイルを保存しました。\n登録画面を開き、保存したファイルを選んでください。" with title "保存しました" buttons {"閉じる"} default button "閉じる"\nreturn "yes"`,
    failed: `display dialog "準備を完了できませんでした。もう一度お試しください。改善しない場合はサポートにご相談ください。" with title "準備を確認" buttons {"閉じる"} default button "閉じる"\nreturn "yes"`,
    cleanup: `display dialog "一時的な準備データを安全に片付けられませんでした。\nサポートにご相談ください。" with title "準備データを確認" buttons {"閉じる"} default button "閉じる"\nreturn "yes"`,
    rotationFailed: `display dialog "新しい設定への切り替えを確認できませんでした。以前の設定用Edgeの情報は残っています。\n状態を確認しますので、サポートにご相談ください。" with title "設定を確認" buttons {"閉じる"} default button "閉じる"\nreturn "yes"`,
});
/** @param {{experimental?: boolean}} [options] */
function createExperimentalMacEdgeDialogs({ experimental } = {}) {
    if (experimental !== true || process.platform !== 'darwin') throw fail();
    async function show(script) {
        try { const result = await run('/usr/bin/osascript', ['-e', script], { timeout: 300000, maxBuffer: 16384, windowsHide: true });
            return result.stdout.replace(/\r?\n$/, ''); }
        catch (error) { if (error?.code === 1 && /-128\b/.test(String(error.stderr || ''))) return null; throw fail(); }
    }
    const yes = async script => await show(script) === 'yes';
    return Object.freeze({
        confirmOpen: () => yes(SCRIPTS.open), confirmNotifications: () => yes(SCRIPTS.notifications),
        confirmClosed: () => yes(SCRIPTS.closed), retryCapture: () => yes(SCRIPTS.retry), confirmNewProfile: () => yes(SCRIPTS.newProfile),
        async confirmSave({ otherSubscriptionCount, unclassifiedRecordCount, otherNotificationsPossible }) {
            if (!Number.isInteger(otherSubscriptionCount) || otherSubscriptionCount < 0 || otherSubscriptionCount > 127
                || !Number.isInteger(unclassifiedRecordCount) || unclassifiedRecordCount < 0 || unclassifiedRecordCount > 127
                || otherNotificationsPossible !== (otherSubscriptionCount > 0 || unclassifiedRecordCount > 0)) throw fail();
            if (otherNotificationsPossible && !await yes(otherSubscriptionCount > 0 ? SCRIPTS.other : SCRIPTS.unknown)) return null;
            const selected = await show(SCRIPTS.destination);
            if (selected === null) return null;
            if (!path.isAbsolute(selected) || selected.includes('\0')) throw fail();
            return { confirmed: true, otherSitesConsent: otherNotificationsPossible,
                directory: path.dirname(selected), filename: path.basename(selected) };
        },
        async showSaved() { await show(SCRIPTS.saved); },
        async showError(code) { await show(code === 'X_EDGE_MAC_CALIBRATION_CLEANUP_PENDING' || code === 'X_EDGE_MAC_CALIBRATION_CLEANUP_FAILED' ? SCRIPTS.cleanup
            : ['X_EDGE_MAC_ROTATION_FAILED', 'X_EDGE_MAC_ROTATION_INVALID', 'X_EDGE_MAC_ROTATION_CLEANUP_FAILED'].includes(code) ? SCRIPTS.rotationFailed
                : SCRIPTS.failed); },
    });
}
module.exports = { createExperimentalMacEdgeDialogs };
