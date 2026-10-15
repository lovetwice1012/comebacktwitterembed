'use strict';

// Public, side-effect-free input hints shared by the GUI and server validation.
const GUIDANCE = Object.freeze({
    youtube: { placeholder: 'https://www.youtube.com/@YouTube', example: 'https://www.youtube.com/@YouTube', help: '動画URLではなく、チャンネルのURL・@ハンドル・UCから始まるIDを入力してください。' },
    github: { placeholder: 'https://github.com/octocat', example: 'https://github.com/octocat', help: 'リポジトリではなく、ユーザーのプロフィールURLまたはユーザー名を入力してください。' },
    twitch: { placeholder: 'https://www.twitch.tv/twitch', example: 'https://www.twitch.tv/twitch', help: 'クリップではなく、配信チャンネルのURLまたはチャンネル名を入力してください。' },
    spotify: { placeholder: 'https://open.spotify.com/artist/…', example: 'https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg', help: '曲やアルバムではなく、アーティストのURLまたはIDを入力してください。' },
    pixiv: { placeholder: 'https://www.pixiv.net/users/…', example: 'https://www.pixiv.net/users/123', help: '作品ではなく、作者のプロフィールURLまたは数値のユーザーIDを入力してください。' },
    booth: { placeholder: 'https://ショップ名.booth.pm/', example: 'https://lilxyzw.booth.pm/', help: '商品のURLではなく、ショップのURLまたはショップ名を入力してください。' },
    amazon: { placeholder: 'https://www.amazon.co.jp/dp/…', example: 'https://www.amazon.co.jp/dp/B08N5WRWNW', help: '商品IDを含む商品URLを入力してください。短縮URLは商品ページを開いてからコピーしてください。' },
    steam: { placeholder: 'https://store.steampowered.com/app/…', example: 'https://store.steampowered.com/app/730/', help: 'ゲームのストア・コミュニティURL、またはストアのパッケージ・バンドルURLを入力してください。' },
});
const DOMAINS = {
    youtube: ['youtube.com', 'youtu.be'], github: ['github.com'], twitch: ['twitch.tv'], spotify: ['open.spotify.com'],
    pixiv: ['pixiv.net'], booth: ['booth.pm'], steam: ['store.steampowered.com', 'steamcommunity.com', 's.team'],
    amazon: ['amazon.co.jp', 'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.ca', 'amazon.it', 'amazon.es', 'amazon.com.au', 'amazon.in', 'a.co', 'amzn.to'],
    instagram: ['instagram.com'], twitter: ['x.com', 'twitter.com'], tiktok: ['tiktok.com'], niconico: ['nicovideo.jp', 'nico.ms'],
};
function sourceProvider(value) {
    try {
        const url = new URL(String(value).trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
        const host = url.hostname.toLowerCase();
        return Object.entries(DOMAINS).find(([, names]) => names.some(name => host === name || host.endsWith(`.${name}`)))?.[0];
    } catch { return undefined; }
}
function sourceGuidance(providerId) { return GUIDANCE[providerId] || { placeholder: '監視するURLを入力', help: '対応サービスと監視対象を確認してください。' }; }
function monitorState(row) {
    if (!row.enabled) return { id: 'paused', label: '停止中', description: '監視を停止しています。再開するまで新しい通知は送りません。' };
    if (row.workflowId && row.workflowStatus !== 'active') {
        const status = row.workflowStatus;
        return { id: 'waiting', label: status === 'unapplied' ? 'ルール未適用' : status === 'paused' ? 'ルール停止中' : 'ルールの確認待ち',
            description: status === 'unapplied' ? 'ルールを通知に適用すると配信を開始できます。' : status === 'paused' ? 'ルールを再開すると配信を再開できます。' : '割り当てたルールを確認するか、通知設定から別のルールを選んでください。', action: 'workflow' };
    }
    if (row.destinationId && row.destinationStatus !== 'active') return { id: 'waiting', label: row.destinationStatus === 'paused' ? '通知先停止中' : '通知先の確認待ち',
        description: row.destinationStatus === 'paused' ? '通知先を有効にすると配信を再開できます。' : '通知設定から有効な通知先を選んでください。', action: 'destination' };
    if (row.errorCode) return /RATE_LIMIT|PACING/.test(row.errorCode)
        ? { id: 'waiting', label: '取得制限で待機', description: 'サービスの取得制限に合わせて待機しています。次回予定に再確認します。' }
        : { id: 'error', label: '確認が必要', description: /INVALID_CURSOR/.test(row.errorCode)
            ? '監視履歴を読み取れませんでした。過去投稿の再通知を防ぐため、履歴の復旧が必要です。'
            : /NOT_FOUND/.test(row.errorCode) ? '監視対象が見つかりません。URLの変更や削除、公開状態を確認してください。'
                : '対象の取得に失敗しました。次回予定に再試行します。続く場合はURLや公開状態を確認してください。' };
    if (!row.lastCheckedAtMs) return { id: 'initial', label: '初回確認待ち', description: row.kind === 'price' ? '初回の価格を基準に、以降の価格変化や指定条件を確認します。' : '初回は現在の投稿を基準に記録し、過去の投稿は通知しません。' };
    return { id: 'active', label: '監視中', description: '新しい投稿や価格の変化を定期的に確認しています。' };
}
function filterMonitors(rows, query, state) {
    const needle = String(query || '').trim().toLocaleLowerCase();
    return rows.filter(row => (!needle || [row.name, row.source, row.providerId].some(value => String(value || '').toLocaleLowerCase().includes(needle)))
        && (state === 'all' || state === 'attention' && ['error', 'waiting'].includes(monitorState(row).id)
            || state === 'active' && row.enabled && !['workflow', 'destination'].includes(monitorState(row).action) || state === 'paused' && !row.enabled));
}
module.exports = { sourceProvider, sourceGuidance, monitorState, filterMonitors };
