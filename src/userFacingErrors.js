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

module.exports = { failureReason };
