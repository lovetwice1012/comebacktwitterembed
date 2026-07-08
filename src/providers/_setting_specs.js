'use strict';

const { DISCORD_LOCALE_OPTIONS } = require('../discordLocales');

const DEFAULT_SETTING_KEY = 'overview';

function text(en, ja) {
    return { en, ja };
}

function descriptionLengthSpec(key, providerName, defaultLength, maxLength) {
    const values = [0, 200, 350, 700, 900, 1400, maxLength]
        .filter((value, index, array) => value <= maxLength && array.indexOf(value) === index);
    if (!values.includes(defaultLength)) values.push(defaultLength);
    values.sort((a, b) => a - b);

    return {
        key,
        label: text(`${providerName} description length`, `${providerName} description length`),
        description: text(
            `Controls the maximum number of description characters shown in ${providerName} embeds. 0 hides descriptions.`,
            `${providerName} embeds description max length. 0 hides descriptions.`
        ),
        kind: 'choice',
        settingKey: key,
        choices: values.map(value => ({
            label: value === 0
                ? text('Hide descriptions', 'Hide descriptions')
                : text(`${value} characters`, `${value} characters`),
            value: String(value),
        })),
        parseValue: value => Number(value),
    };
}

function sensitiveDisplayModeSpec(key, label, description) {
    return {
        key,
        label,
        description,
        kind: 'choice',
        settingKey: key,
        choices: [
            { label: text('Normal media', '通常表示'), value: 'normal' },
            { label: text('Metadata only', 'メタ情報のみ'), value: 'metadata_only' },
            { label: text('Spoiler attachments', 'spoiler添付'), value: 'spoiler_attachment' },
            { label: text('Suppress expansion', '展開しない'), value: 'suppress' },
        ],
    };
}

function nonNsfwSensitiveRestrictionSpec(key, label, description) {
    return {
        key,
        label,
        description,
        kind: 'bool',
        settingKey: key,
    };
}

function sensitiveTargetSpec(key, label, description) {
    return {
        key,
        label,
        description,
        kind: 'targets',
        settingKey: key,
    };
}

const BULK_SETTING_KEYS = new Set([
    'enabled',
    'disable',
    'defaultLanguage',
    'editOriginalIfTranslate',
    'extract_bot_message',
    'button_invisible',
    'button_disabled',
]);

const COMMON_SETTING_SPECS = [
    {
        key: 'enabled',
        label: text('Provider on/off', 'プロバイダーの有効化'),
        description: text(
            'Controls whether this provider expands matching links in this server.',
            'このサーバーで、このプロバイダーのリンクを展開するかどうかを切り替えます。'
        ),
        kind: 'providerEnabled',
        settingKey: 'enabled',
    },
    {
        key: 'disable',
        label: text('Do not expand for targets', '対象ごとの展開停止'),
        description: text(
            'Prevents link expansion for the selected users, channels, or roles.',
            '選択したユーザー、チャンネル、ロールの投稿ではリンク展開を行わないようにします。'
        ),
        kind: 'targets',
        settingKey: 'disable',
    },
    {
        key: 'defaultLanguage',
        label: text('Default output language', '標準の表示言語'),
        description: text(
            'Changes the language used for provider text, embed labels, and Translate button output where supported.',
            '対応しているプロバイダーの埋め込みラベルや翻訳ボタンの出力に使う言語を変更します。'
        ),
        kind: 'choice',
        settingKey: 'defaultLanguage',
        choices: DISCORD_LOCALE_OPTIONS.map(option => ({
            label: `${option.flag} ${option.nativeName}`,
            value: option.value,
        })),
    },
    {
        key: 'editOriginalIfTranslate',
        label: text('Edit embed after translation', '翻訳後に埋め込みを編集'),
        description: text(
            'When a Translate button is used, edits the original bot response instead of sending a separate translated response.',
            '翻訳ボタンが押されたとき、翻訳結果を別メッセージで送らず、元のBot応答を編集します。'
        ),
        kind: 'bool',
        settingKey: 'editOriginalIfTranslate',
    },
    {
        key: 'extract_bot_message',
        label: text('Expand bot messages', 'Botの投稿も展開'),
        description: text(
            'Also expands provider links posted by bots and webhooks.',
            'BotやWebhookが投稿したプロバイダーリンクも展開対象にします。'
        ),
        kind: 'bool',
        settingKey: 'extract_bot_message',
    },
    {
        key: 'button_invisible',
        label: text('Hide response buttons', '応答ボタンを非表示'),
        description: text(
            'Hides selected buttons such as Translate, Delete, or media-view buttons from the bot response.',
            'Botの応答に付く翻訳、削除、メディア表示切り替えなどのボタンを選んで非表示にします。'
        ),
        kind: 'buttonVisibility',
        settingKey: 'button_invisible',
    },
    {
        key: 'button_disabled',
        label: text('Block button use for targets', '対象ごとのボタン操作停止'),
        description: text(
            'Prevents selected users, channels, or roles from using buttons on the bot response.',
            '選択したユーザー、チャンネル、ロールがBot応答のボタンを操作できないようにします。'
        ),
        kind: 'targets',
        settingKey: 'button_disabled',
    },
    {
        key: 'failure_display_policy',
        label: text('Fetch failure output', 'Fetch failure output'),
        description: text(
            'Chooses what the bot sends when provider metadata cannot be fetched.',
            'Chooses what the bot sends when provider metadata cannot be fetched.'
        ),
        kind: 'choice',
        settingKey: 'failure_display_policy',
        choices: [
            { label: text('Send nothing', 'Send nothing'), value: 'silent' },
            { label: text('Send source link', 'Send source link'), value: 'source_link' },
            { label: text('Send short error summary', 'Send short error summary'), value: 'error_summary' },
        ],
    },
];

const SETTING_SPEC_CATALOG = {
    bannedWords: {
        key: 'bannedWords',
        label: text('Blocked words in embeds', '展開しないワード'),
        description: text(
            'If the fetched title, text, caption, or description contains one of these words, the bot skips the expansion.',
            '取得したタイトル、本文、キャプション、説明文に登録ワードが含まれる場合、そのリンク展開を送信しません。'
        ),
        kind: 'bannedWords',
        settingKey: 'bannedWords',
    },
    sendMediaAsAttachmentsAsDefault: {
        key: 'sendMediaAsAttachmentsAsDefault',
        label: text('Send media as files first', 'メディアを添付ファイル優先で送信'),
        description: text(
            'Changes image/video output from embed previews to Discord file attachments when the provider supports it.',
            '対応プロバイダーで、画像や動画を埋め込みプレビューではなくDiscord添付ファイルとして優先送信します。'
        ),
        kind: 'bool',
        settingKey: 'sendMediaAsAttachmentsAsDefault',
    },
    deletemessageifonlypostedtweetlink: {
        key: 'deletemessageifonlypostedtweetlink',
        label: text('Delete link-only source message', 'リンクだけの元投稿を削除'),
        description: text(
            'Deletes the user message after expansion when that message contains only the provider link.',
            '投稿内容がプロバイダーリンクだけだった場合、展開後に元のユーザーメッセージを削除します。'
        ),
        kind: 'bool',
        settingKey: 'deletemessageifonlypostedtweetlink',
    },
    deletemessageifonlypostedtweetlink_secoundaryextractmode: {
        key: 'deletemessageifonlypostedtweetlink_secoundaryextractmode',
        label: text('Delete link-only in secondary mode', 'セカンダリ展開でも元投稿を削除'),
        description: text(
            'For Twitter/X secondary extract mode, also deletes the original link-only message after a matching tweet is expanded.',
            'Twitter/Xのセカンダリ展開モードでも、条件に合うツイートを展開したときリンクだけの元投稿を削除します。'
        ),
        kind: 'bool',
        settingKey: 'deletemessageifonlypostedtweetlink_secoundaryextractmode',
    },
    suppress_source_embeds_if_only_posted_tweet_link_secondary_extract_mode: {
        key: 'suppress_source_embeds_if_only_posted_tweet_link_secondary_extract_mode',
        label: text('Suppress link preview in secondary mode', 'セカンダリ展開時の元リンクプレビュー抑制'),
        description: text(
            'For Twitter/X secondary extract mode, suppresses Discord\'s built-in preview when a matching tweet was posted as the only message content.',
            'Twitter/Xのセカンダリ展開モードで条件に合うツイートを展開したとき、元投稿がリンクのみならDiscord標準リンクプレビューを抑制します。'
        ),
        kind: 'bool',
        settingKey: 'suppress_source_embeds_if_only_posted_tweet_link_secondary_extract_mode',
    },
    alwaysreplyifpostedtweetlink: {
        key: 'alwaysreplyifpostedtweetlink',
        label: text('Reply to the source message', '元投稿への返信として送信'),
        description: text(
            'Sends the bot expansion as a Discord reply to the original message instead of a normal channel message.',
            'Botの展開結果を通常のチャンネル投稿ではなく、元メッセージへのDiscord返信として送信します。'
        ),
        kind: 'bool',
        settingKey: 'alwaysreplyifpostedtweetlink',
    },
    anonymous_expand: {
        key: 'anonymous_expand',
        label: text('Hide requester name', '展開者名を隠す'),
        description: text(
            'Replaces the requester shown in embed author/footer text with an anonymous label.',
            '埋め込みのauthorやfooterに表示される展開リクエスト者名を匿名表示に置き換えます。'
        ),
        kind: 'bool',
        settingKey: 'anonymous_expand',
    },
    non_nsfw_channel_sensitive_restriction_enabled: nonNsfwSensitiveRestrictionSpec(
        'non_nsfw_channel_sensitive_restriction_enabled',
        text('Sensitive content in non-NSFW channels', '非NSFWチャンネルでのセンシティブコンテンツの取り扱い'),
        text(
            'Suppresses sensitive content expansion in channels that are not marked NSFW unless an allow target matches.',
            'NSFW指定されていないチャンネルでは、許可ターゲットが一致しない場合にセンシティブコンテンツの展開を抑止します。'
        )
    ),
    sensitive_content_allowed_targets: sensitiveTargetSpec(
        'sensitive_content_allowed_targets',
        text('Sensitive content allow targets', 'センシティブ許可ターゲット'),
        text(
            'Users, channels, or roles allowed to bypass the non-NSFW channel sensitive-content policy.',
            '非NSFWチャンネル用のセンシティブ制限を上書きして許可するユーザー、チャンネル、ロールです。'
        )
    ),
    sensitive_content_excluded_targets: sensitiveTargetSpec(
        'sensitive_content_excluded_targets',
        text('Sensitive content block targets', 'センシティブ除外ターゲット'),
        text(
            'Users, channels, or roles where sensitive content expansion is suppressed.',
            'センシティブコンテンツの展開を抑止するユーザー、チャンネル、ロールです。'
        )
    ),
    quote_repost_do_not_extract: {
        key: 'quote_repost_do_not_extract',
        label: text('Skip quoted reposts', '引用リポストを展開しない'),
        description: text(
            'For Twitter/X, expands only the posted tweet and does not add extra embeds for quoted reposts.',
            'Twitter/Xで、投稿されたツイートだけを展開し、引用リポスト分の追加埋め込みを作りません。'
        ),
        kind: 'bool',
        settingKey: 'quote_repost_do_not_extract',
    },
    quote_repost_max_depth: {
        key: 'quote_repost_max_depth',
        label: text('Quoted repost depth', '引用リポストの展開段数'),
        description: text(
            'For Twitter/X, controls how many nested quoted reposts are added as follow-up embeds. 0 means unlimited.',
            'Twitter/Xで、引用リポストを何段先まで追加埋め込みとして展開するかを指定します。0は無制限です。'
        ),
        kind: 'choice',
        settingKey: 'quote_repost_max_depth',
        choices: Array.from({ length: 11 }, (_value, index) => ({
            label: index === 0 ? text('Unlimited', '無制限') : String(index),
            value: String(index),
        })),
        parseValue: value => Number(value),
    },
    legacy_mode: {
        key: 'legacy_mode',
        label: text('Suppress original preview', '元リンクのプレビューを抑制'),
        description: text(
            'After sending the bot embed, suppresses Discord\'s built-in link preview on the original message when possible.',
            'Botの埋め込み送信後、可能な場合は元メッセージに出るDiscord標準リンクプレビューを抑制します。'
        ),
        kind: 'bool',
        settingKey: 'legacy_mode',
    },
    passive_mode: {
        key: 'passive_mode',
        label: text('Compact Twitter output', 'Twitter出力を簡易表示'),
        description: text(
            'For Twitter/X compact embeds, removes tweet text and keeps the output focused on media-view buttons.',
            'Twitter/Xの簡易埋め込みで本文表示を省き、メディア表示ボタン中心の出力にします。'
        ),
        kind: 'bool',
        settingKey: 'passive_mode',
    },
    secondary_extract_mode: {
        key: 'secondary_extract_mode',
        label: text('Twitter media-only trigger', 'Twitterのメディア条件付き展開'),
        description: text(
            'For Twitter/X, sends an expansion only when the tweet has selected media types such as multiple images or video.',
            'Twitter/Xで、複数画像や動画など選択したメディア条件に合う投稿だけ展開します。'
        ),
        kind: 'bool',
        settingKey: 'secondary_extract_mode',
    },
    secondary_extract_mode_multiple_images: {
        key: 'secondary_extract_mode_multiple_images',
        label: text('Trigger on multiple images', '複数画像で展開'),
        description: text(
            'For Twitter/X secondary mode, expands tweets that contain more than one image.',
            'Twitter/Xのセカンダリ展開で、画像が複数あるツイートを展開対象にします。'
        ),
        kind: 'bool',
        settingKey: 'secondary_extract_mode_multiple_images',
    },
    secondary_extract_mode_video: {
        key: 'secondary_extract_mode_video',
        label: text('Trigger on videos', '動画で展開'),
        description: text(
            'For Twitter/X secondary mode, expands tweets that contain video media.',
            'Twitter/Xのセカンダリ展開で、動画を含むツイートを展開対象にします。'
        ),
        kind: 'bool',
        settingKey: 'secondary_extract_mode_video',
    },
    pixiv_images_per_step: {
        key: 'pixiv_images_per_step',
        label: text('Pixiv images per message', 'Pixivの1投稿あたり画像数'),
        description: text(
            'Controls how many Pixiv artwork images are included in one bot response before follow-up steps are needed.',
            'Pixiv作品を展開するとき、Botの1回の応答に含める画像枚数を変更します。'
        ),
        kind: 'choice',
        settingKey: 'pixiv_images_per_step',
        choices: [
            { label: '4', value: '4' },
            { label: '10', value: '10' },
        ],
        parseValue: value => Number(value),
    },
    youtube_description_max_length: {
        key: 'youtube_description_max_length',
        label: text('YouTube description length', 'YouTube説明文の長さ'),
        description: text(
            'Controls the maximum number of description characters shown in YouTube video, playlist, and channel embeds. 0 hides descriptions.',
            'YouTubeの動画、プレイリスト、チャンネル埋め込みに表示する説明文の最大文字数を変更します。0にすると説明文を非表示にします。'
        ),
        kind: 'choice',
        settingKey: 'youtube_description_max_length',
        choices: [
            { label: text('Hide descriptions', '説明文を非表示'), value: '0' },
            { label: text('200 characters', '200文字'), value: '200' },
            { label: text('500 characters', '500文字'), value: '500' },
            { label: text('700 characters', '700文字'), value: '700' },
            { label: text('1000 characters', '1000文字'), value: '1000' },
            { label: text('1400 characters', '1400文字'), value: '1400' },
        ],
        parseValue: value => Number(value),
    },
    youtube_video_list_limit: {
        key: 'youtube_video_list_limit',
        label: text('YouTube video list count', 'YouTube video list count'),
        description: text(
            'Controls how many playlist or channel videos are listed in YouTube embeds. 0 hides the list.',
            'Controls how many playlist or channel videos are listed in YouTube embeds. 0 hides the list.'
        ),
        kind: 'choice',
        settingKey: 'youtube_video_list_limit',
        choices: [
            { label: text('Hide video list', 'Hide video list'), value: '0' },
            { label: '3', value: '3' },
            { label: '5', value: '5' },
            { label: '10', value: '10' },
        ],
        parseValue: value => Number(value),
    },
    tiktok_hq: {
        key: 'tiktok_hq',
        label: text('TikTok high-quality video', 'TikTok動画を高画質優先'),
        description: text(
            'When a TikTok video is attached as a file, prefers a higher-quality video source when one is available.',
            'TikTok動画を添付ファイルとして送るとき、利用可能なら高画質の動画ソースを優先します。'
        ),
        kind: 'bool',
        settingKey: 'tiktok_hq',
    },
    hidden_output_items: {
        key: 'hidden_output_items',
        label: text('Hidden output items', '非表示にする出力項目'),
        description: text(
            'Hides selected fields or content blocks from this provider’s embeds. This is separate from response button visibility.',
            'このプロバイダーの埋め込みに出るフィールドや内容ブロックを選んで非表示にします。応答ボタンの非表示設定とは別です。'
        ),
        kind: 'outputVisibility',
        settingKey: 'hidden_output_items',
        outputItems: [],
    },
    display_density: {
        key: 'display_density',
        label: text('Output density', 'Output density'),
        description: text(
            'Chooses how much optional metadata this provider includes in embeds.',
            'Chooses how much optional metadata this provider includes in embeds.'
        ),
        kind: 'choice',
        settingKey: 'display_density',
        choices: [
            { label: text('Compact', 'Compact'), value: 'compact' },
            { label: text('Standard', 'Standard'), value: 'standard' },
            { label: text('Detail', 'Detail'), value: 'detail' },
        ],
    },
    media_display_mode: {
        key: 'media_display_mode',
        label: text('Media display mode', 'Media display mode'),
        description: text(
            'Chooses whether provider media is shown as embed media, attachments, thumbnails, or links only where supported.',
            'Chooses whether provider media is shown as embed media, attachments, thumbnails, or links only where supported.'
        ),
        kind: 'choice',
        settingKey: 'media_display_mode',
        choices: [
            { label: text('Embed media', 'Embed media'), value: 'embed' },
            { label: text('Attach files', 'Attach files'), value: 'attachment' },
            { label: text('Thumbnail only', 'Thumbnail only'), value: 'thumbnail_only' },
            { label: text('Links only', 'Links only'), value: 'link_only' },
        ],
    },
    failure_display_policy: {
        key: 'failure_display_policy',
        label: text('Fetch failure output', 'Fetch failure output'),
        description: text(
            'Chooses what the bot sends when provider metadata cannot be fetched.',
            'Chooses what the bot sends when provider metadata cannot be fetched.'
        ),
        kind: 'choice',
        settingKey: 'failure_display_policy',
        choices: [
            { label: text('Send nothing', 'Send nothing'), value: 'silent' },
            { label: text('Send source link', 'Send source link'), value: 'source_link' },
            { label: text('Send short error summary', 'Send short error summary'), value: 'error_summary' },
        ],
    },
    tiktok_description_max_length: descriptionLengthSpec('tiktok_description_max_length', 'TikTok', 900, 900),
    tiktok_image_limit: {
        key: 'tiktok_image_limit',
        label: text('TikTok photo count', 'TikTok photo count'),
        description: text(
            'Controls how many TikTok photo-post images are shown. If unset, compact density shows 1 and standard/detail show up to 10.',
            'Controls how many TikTok photo-post images are shown. If unset, compact density shows 1 and standard/detail show up to 10.'
        ),
        kind: 'choice',
        settingKey: 'tiktok_image_limit',
        choices: [
            { label: '1', value: '1' },
            { label: '4', value: '4' },
            { label: '10', value: '10' },
        ],
        parseValue: value => Number(value),
    },
    tiktok_video_fallback_mode: {
        key: 'tiktok_video_fallback_mode',
        label: text('TikTok video attachment fallback', 'TikTok video attachment fallback'),
        description: text(
            'Chooses what to show when a TikTok video cannot be attached as a file.',
            'Chooses what to show when a TikTok video cannot be attached as a file.'
        ),
        kind: 'choice',
        settingKey: 'tiktok_video_fallback_mode',
        choices: [
            { label: text('Show video URL', 'Show video URL'), value: 'video_url' },
            { label: text('Thumbnail only', 'Thumbnail only'), value: 'thumbnail_only' },
            { label: text('Send nothing extra', 'Send nothing extra'), value: 'silent' },
        ],
    },
    niconico_description_max_length: descriptionLengthSpec('niconico_description_max_length', 'Niconico', 1400, 1400),
    spotify_description_max_length: descriptionLengthSpec('spotify_description_max_length', 'Spotify', 350, 700),
    twitch_description_max_length: descriptionLengthSpec('twitch_description_max_length', 'Twitch', 1500, 1500),
    steam_description_max_length: descriptionLengthSpec('steam_description_max_length', 'Steam', 900, 900),
    steam_image_source: {
        key: 'steam_image_source',
        label: text('Steam image source', 'Steam image source'),
        description: text(
            'Chooses which Steam app image is used as the embed media when available.',
            'Chooses which Steam app image is used as the embed media when available.'
        ),
        kind: 'choice',
        settingKey: 'steam_image_source',
        choices: [
            { label: text('Header image', 'Header image'), value: 'header' },
            { label: text('First screenshot', 'First screenshot'), value: 'screenshot' },
            { label: text('Capsule thumbnail', 'Capsule thumbnail'), value: 'thumbnail' },
        ],
    },
    amazon_description_max_length: descriptionLengthSpec('amazon_description_max_length', 'Amazon', 700, 700),
    amazon_extract_targets: {
        key: 'amazon_extract_targets',
        label: text('Amazon expansion targets', 'Amazon expansion targets'),
        description: text(
            'Chooses which Amazon surfaces this provider expands: product pages, Prime Video, and Amazon Music.',
            'Chooses which Amazon surfaces this provider expands: product pages, Prime Video, and Amazon Music.'
        ),
        kind: 'multiChoice',
        settingKey: 'amazon_extract_targets',
        choices: [
            { label: text('Amazon products', 'Amazon products'), value: 'product' },
            { label: text('Prime Video', 'Prime Video'), value: 'prime_video' },
            { label: text('Amazon Music', 'Amazon Music'), value: 'music' },
        ],
    },
    booth_description_max_length: descriptionLengthSpec('booth_description_max_length', 'Booth', 350, 700),
    booth_image_limit: {
        key: 'booth_image_limit',
        label: text('Booth image count', 'Booth image count'),
        description: text(
            'Controls how many Booth item images are shown. If unset, compact density shows 1 and standard/detail show up to 10.',
            'Controls how many Booth item images are shown. If unset, compact density shows 1 and standard/detail show up to 10.'
        ),
        kind: 'choice',
        settingKey: 'booth_image_limit',
        choices: [
            { label: '1', value: '1' },
            { label: '4', value: '4' },
            { label: '10', value: '10' },
        ],
        parseValue: value => Number(value),
    },
    booth_adult_display_mode: {
        key: 'booth_adult_display_mode',
        label: text('Booth adult item media', 'Booth adult item media'),
        description: text(
            'Controls media display for Booth items explicitly marked adult by Booth metadata.',
            'Controls media display for Booth items explicitly marked adult by Booth metadata.'
        ),
        kind: 'choice',
        settingKey: 'booth_adult_display_mode',
        choices: [
            { label: text('Normal media', 'Normal media'), value: 'normal' },
            { label: text('Metadata only', 'Metadata only'), value: 'metadata_only' },
            { label: text('Spoiler attachments', 'Spoiler attachments'), value: 'spoiler_attachment' },
            { label: text('Suppress expansion', 'Suppress expansion'), value: 'suppress' },
        ],
    },
    twitter_stats_layout: {
        key: 'twitter_stats_layout',
        label: text('Twitter stats layout', 'Twitter stats layout'),
        description: text(
            'Controls whether reply, repost, and like counts are shown in the description, as embed fields, or hidden.',
            'Controls whether reply, repost, and like counts are shown in the description, as embed fields, or hidden.'
        ),
        kind: 'choice',
        settingKey: 'twitter_stats_layout',
        choices: [
            { label: text('Description line', 'Description line'), value: 'description' },
            { label: text('Embed fields', 'Embed fields'), value: 'fields' },
            { label: text('Hidden', 'Hidden'), value: 'hidden' },
        ],
    },
    twitter_text_mode: {
        key: 'twitter_text_mode',
        label: text('Twitter text display', 'Twitter本文の表示'),
        description: text(
            'Changes the text area of Twitter/X embeds: show the tweet body, show only the source link, or hide the text area.',
            'Twitter/Xの埋め込み本文欄を変更します。ツイート本文を出す、元リンクだけ出す、本文欄を隠す、を選べます。'
        ),
        kind: 'choice',
        settingKey: 'twitter_text_mode',
        choices: [
            { label: text('Tweet text + source link', 'ツイート本文 + 元リンク'), value: 'normal' },
            { label: text('Source link only', '元リンクだけ'), value: 'link_only' },
            { label: text('Hide text area', '本文欄を隠す'), value: 'hidden' },
        ],
    },
    twitter_quote_mode: {
        key: 'twitter_quote_mode',
        label: text('Quoted tweet display', 'Quoted tweet display'),
        description: text(
            'Controls whether quoted Twitter/X posts are expanded fully, shown as a short summary, or hidden.',
            'Controls whether quoted Twitter/X posts are expanded fully, shown as a short summary, or hidden.'
        ),
        kind: 'choice',
        settingKey: 'twitter_quote_mode',
        choices: [
            { label: text('Full embed', 'Full embed'), value: 'full' },
            { label: text('Short summary', 'Short summary'), value: 'summary' },
            { label: text('Hidden', 'Hidden'), value: 'hidden' },
        ],
    },
    twitter_quote_layout: {
        key: 'twitter_quote_layout',
        label: text('Quoted tweet layout', '引用ツイートの並べ方'),
        description: text(
            'Controls whether quoted Twitter/X embeds are sent as follow-up replies or appended to the same bot response when Discord limits allow it.',
            'Twitter/Xの引用ツイートを、後続返信として分けるか、Discordの上限内なら同じBot返信内の追加embedとしてまとめるかを変更します。'
        ),
        kind: 'choice',
        settingKey: 'twitter_quote_layout',
        choices: [
            { label: text('Follow-up replies', '後続返信に分ける'), value: 'separate' },
            { label: text('Append to same response', '同じ返信にまとめる'), value: 'inline' },
        ],
    },
    pixiv_caption_max_length: {
        key: 'pixiv_caption_max_length',
        label: text('Pixiv description length', 'Pixiv説明文の長さ'),
        description: text(
            'Controls the maximum number of characters shown in the Pixiv embed description. 0 hides the description text.',
            'Pixiv作品の埋め込み本文欄に表示する説明文の最大文字数を変更します。0にすると説明文を非表示にします。'
        ),
        kind: 'choice',
        settingKey: 'pixiv_caption_max_length',
        choices: [
            { label: text('Hide description', '説明文を隠す'), value: '0' },
            { label: text('140 characters', '140文字'), value: '140' },
            { label: text('350 characters', '350文字'), value: '350' },
            { label: text('700 characters', '700文字'), value: '700' },
            { label: text('1200 characters', '1200文字'), value: '1200' },
        ],
        parseValue: value => Number(value),
    },
    pixiv_tag_limit: {
        key: 'pixiv_tag_limit',
        label: text('Pixiv tag count', 'Pixiv tag count'),
        description: text(
            'Controls how many Pixiv tags are shown. 0 hides tags; All shows every fetched tag.',
            'Controls how many Pixiv tags are shown. 0 hides tags; All shows every fetched tag.'
        ),
        kind: 'choice',
        settingKey: 'pixiv_tag_limit',
        choices: [
            { label: text('Hide tags', 'Hide tags'), value: '0' },
            { label: '5', value: '5' },
            { label: '10', value: '10' },
            { label: '20', value: '20' },
            { label: text('All tags', 'All tags'), value: 'all' },
        ],
        parseValue: value => (value === 'all' ? 'all' : Number(value)),
    },
    pixiv_r18_display_mode: sensitiveDisplayModeSpec(
        'pixiv_r18_display_mode',
        text('Pixiv R-18 media', 'Pixiv R-18メディア'),
        text(
            'Controls how Pixiv artworks marked R-18, explicitly tagged R-18, or fetched as strongly sensitive are expanded.',
            'PixivでR-18として取得された作品、R-18タグが付いた作品、またはセンシティブ判定が強い作品の展開方法を選びます。'
        )
    ),
    pixiv_r18g_display_mode: sensitiveDisplayModeSpec(
        'pixiv_r18g_display_mode',
        text('Pixiv R-18G media', 'Pixiv R-18Gメディア'),
        text(
            'Controls how Pixiv artworks marked R-18G, or explicitly tagged R-18G, are expanded.',
            'PixivでR-18Gとして取得された作品、またはR-18Gタグが付いた作品の展開方法を選びます。'
        )
    ),
    pixiv_r18_non_nsfw_channel_sensitive_restriction_enabled: nonNsfwSensitiveRestrictionSpec(
        'pixiv_r18_non_nsfw_channel_sensitive_restriction_enabled',
        text('Pixiv R-18 in non-NSFW channels', 'Pixiv R-18: 非NSFWチャンネルでの取り扱い'),
        text(
            'Suppresses Pixiv R-18 expansion in channels that are not marked NSFW unless an R-18 allow target matches.',
            'NSFW指定されていないチャンネルでは、R-18用の許可ターゲットが一致しない場合にPixiv R-18の展開を抑止します。'
        )
    ),
    pixiv_r18_sensitive_content_allowed_targets: sensitiveTargetSpec(
        'pixiv_r18_sensitive_content_allowed_targets',
        text('Pixiv R-18 allow targets', 'Pixiv R-18許可ターゲット'),
        text(
            'Users, channels, or roles allowed to bypass the Pixiv R-18 non-NSFW channel restriction.',
            'Pixiv R-18の非NSFWチャンネル制限を上書きして許可するユーザー、チャンネル、ロールです。'
        )
    ),
    pixiv_r18_sensitive_content_excluded_targets: sensitiveTargetSpec(
        'pixiv_r18_sensitive_content_excluded_targets',
        text('Pixiv R-18 block targets', 'Pixiv R-18除外ターゲット'),
        text(
            'Users, channels, or roles where Pixiv R-18 expansion is suppressed.',
            'Pixiv R-18の展開を抑止するユーザー、チャンネル、ロールです。'
        )
    ),
    pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled: nonNsfwSensitiveRestrictionSpec(
        'pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled',
        text('Pixiv R-18G in non-NSFW channels', 'Pixiv R-18G: 非NSFWチャンネルでの取り扱い'),
        text(
            'Suppresses Pixiv R-18G expansion in channels that are not marked NSFW unless an R-18G allow target matches.',
            'NSFW指定されていないチャンネルでは、R-18G用の許可ターゲットが一致しない場合にPixiv R-18Gの展開を抑止します。'
        )
    ),
    pixiv_r18g_sensitive_content_allowed_targets: sensitiveTargetSpec(
        'pixiv_r18g_sensitive_content_allowed_targets',
        text('Pixiv R-18G allow targets', 'Pixiv R-18G許可ターゲット'),
        text(
            'Users, channels, or roles allowed to bypass the Pixiv R-18G non-NSFW channel restriction.',
            'Pixiv R-18Gの非NSFWチャンネル制限を上書きして許可するユーザー、チャンネル、ロールです。'
        )
    ),
    pixiv_r18g_sensitive_content_excluded_targets: sensitiveTargetSpec(
        'pixiv_r18g_sensitive_content_excluded_targets',
        text('Pixiv R-18G block targets', 'Pixiv R-18G除外ターゲット'),
        text(
            'Users, channels, or roles where Pixiv R-18G expansion is suppressed.',
            'Pixiv R-18Gの展開を抑止するユーザー、チャンネル、ロールです。'
        )
    ),
    instagram_caption_max_length: {
        key: 'instagram_caption_max_length',
        label: text('Instagram caption length', 'Instagramキャプションの長さ'),
        description: text(
            'Controls the maximum number of caption characters shown in Instagram post/reel embed descriptions. 0 hides captions.',
            'Instagram投稿やリールの埋め込み本文欄に表示するキャプションの最大文字数を変更します。0にするとキャプションを非表示にします。'
        ),
        kind: 'choice',
        settingKey: 'instagram_caption_max_length',
        choices: [
            { label: text('Hide captions', 'キャプションを隠す'), value: '0' },
            { label: text('500 characters', '500文字'), value: '500' },
            { label: text('1200 characters', '1200文字'), value: '1200' },
            { label: text('3000 characters', '3000文字'), value: '3000' },
        ],
        parseValue: value => Number(value),
    },
    instagram_media_limit: {
        key: 'instagram_media_limit',
        label: text('Instagram media count', 'Instagramメディア数'),
        description: text(
            'Controls how many Instagram carousel images/videos are included in one bot response.',
            'Instagramのカルーセル投稿で、Botの1回の返信に含める画像や動画の最大数を変更します。'
        ),
        kind: 'choice',
        settingKey: 'instagram_media_limit',
        choices: [
            { label: '1', value: '1' },
            { label: '4', value: '4' },
            { label: '10', value: '10' },
        ],
        parseValue: value => Number(value),
    },
    github_card_style: {
        key: 'github_card_style',
        label: text('GitHub repo card source', 'GitHubリポジトリカードの種類'),
        description: text(
            'Chooses between the bot-generated repository card and GitHub’s own OpenGraph repository card image.',
            'Botが生成するリポジトリカード画像と、GitHubが用意しているOpenGraphリポジトリカード画像のどちらを使うかを選びます。'
        ),
        kind: 'choice',
        settingKey: 'github_card_style',
        choices: [
            { label: text('Bot-generated card', 'Bot生成カード'), value: 'generated' },
            { label: text('GitHub official card', 'GitHub公式カード'), value: 'github' },
        ],
    },
};

function overviewSpec() {
    return {
        key: DEFAULT_SETTING_KEY,
        label: text('Overview', '概要'),
        description: text(
            'Shows the current GUI-editable settings and their output effects.',
            'GUIで変更できる現在の設定と、出力への影響を一覧表示します。'
        ),
        kind: 'overview',
    };
}

function cloneSpec(spec) {
    return {
        ...spec,
        choices: Array.isArray(spec.choices)
            ? spec.choices.map(choice => ({ ...choice }))
            : spec.choices,
        outputItems: Array.isArray(spec.outputItems)
            ? spec.outputItems.map(item => ({ ...item }))
            : spec.outputItems,
    };
}

function normalizeSettingSpec(entry) {
    if (typeof entry === 'string') {
        const spec = SETTING_SPEC_CATALOG[entry];
        return spec ? cloneSpec(spec) : null;
    }
    if (!entry || typeof entry !== 'object') return null;
    const key = entry.key || entry.settingKey;
    if (!key) return null;
    const base = SETTING_SPEC_CATALOG[key] || {};
    return cloneSpec({
        ...base,
        ...entry,
        key,
        settingKey: entry.settingKey || base.settingKey || key,
    });
}

function providerSettingEntries(provider) {
    const raw = provider?.settings ?? provider?.settingSpecs ?? [];
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.extra)) return raw.extra;
    return [];
}

function uniqueSpecs(specs) {
    const out = [];
    const seen = new Set();
    for (const spec of specs) {
        if (!spec || seen.has(spec.key)) continue;
        seen.add(spec.key);
        out.push(spec);
    }
    return out;
}

function getProviderSettingSpecs(provider, options = {}) {
    const specs = [];
    if (options.includeOverview !== false) specs.push(overviewSpec());
    if (options.includeCommon !== false) specs.push(...COMMON_SETTING_SPECS.map(cloneSpec));
    specs.push(...providerSettingEntries(provider).map(normalizeSettingSpec).filter(Boolean));
    return uniqueSpecs(specs);
}

function getBulkSettingSpecs() {
    return [
        overviewSpec(),
        ...COMMON_SETTING_SPECS.filter(spec => BULK_SETTING_KEYS.has(spec.key)).map(cloneSpec),
    ];
}

module.exports = {
    BULK_SETTING_KEYS,
    COMMON_SETTING_SPECS,
    DEFAULT_SETTING_KEY,
    SETTING_SPEC_CATALOG,
    getBulkSettingSpecs,
    getProviderSettingSpecs,
    normalizeSettingSpec,
    overviewSpec,
};
