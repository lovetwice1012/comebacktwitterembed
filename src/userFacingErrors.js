'use strict';

// User replies must not include raw transport errors, signed URLs or stack traces.
function failureReason(error, locale = 'en') {
    const ja = String(locale).toLowerCase().startsWith('ja');
    const status = Number(error?.status || error?.statusCode);
    const code = String(error?.code || '');
    const timeout = /TIMEOUT|ETIMEDOUT|ABORT|ECONN/i.test(code) || /Abort|Timeout/i.test(error?.name || '');
    if (status === 429 || /RATE_LIMIT/i.test(code)) return ja
        ? '取得先の利用制限に達しています。時間をおいて再試行してください。'
        : 'The source is rate limited. Please try again later.';
    if (status === 401 || status === 403) return ja
        ? '取得先へのアクセスが拒否されました。元のリンクで公開状態を確認してください。'
        : 'The source denied access. Please check whether the original link is publicly accessible.';
    if (status === 404 || status === 410) return ja
        ? '取得先で内容が見つかりませんでした。元のリンクを確認してください。'
        : 'The content could not be found at the source. Please check the original link.';
    if (timeout || status >= 500) return ja
        ? '取得先との通信が一時的に失敗しました。時間をおいて再試行してください。'
        : 'The source could not be reached temporarily. Please try again later.';
    return ja ? '内容を取得・解析できませんでした。元のリンクを確認してください。'
        : 'The content could not be retrieved or parsed. Please check the original link.';
}

function notificationDestinationFailure(error, locale = 'en') {
    const japanese = String(locale).toLowerCase().startsWith('ja'), code = String(error?.code || '');
    if (code === 'DESTINATION_DISABLED') return japanese
        ? '通知一覧で既存の通知先を有効にしてから、再登録してください。'
        : 'Enable the existing destination in your notification list, then register again.';
    if (['NOT_FOUND', 'DESTINATION_DELETED', 'DESTINATION_SCOPE', 'DESTINATION_CHANGED', 'WEBHOOK_DESTINATION_CHANGED', 'DM_OWNER_MISMATCH', 'DM_OWNER'].includes(code)) return japanese
        ? '通知一覧で既存の通知を開き、利用できる通知先を選び直してください。既存の登録枠で修復できます。'
        : 'Open the existing notification in your notification list and choose an available destination. This uses its existing slot.';
    if (['CHANNEL_PERMISSION', 'DISCORD_ACCESS_DENIED'].includes(code)) return japanese
        ? '通知先の閲覧・送信権限を確認してください。通知一覧から既存の通知先を選び直すこともできます。'
        : 'Check access and Send Messages permissions for the destination, or choose another destination in your notification list.';
    if (['DISCORD_UNAVAILABLE', 'DISCORD_RATE_LIMITED'].includes(code)) return japanese
        ? '通知先の確認を再試行してください。時間をおいてから再登録できます。'
        : 'Try destination verification again shortly, then register again.';
    return null;
}

module.exports = { failureReason, notificationDestinationFailure };
