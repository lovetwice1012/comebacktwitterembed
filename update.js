const mysql = require('mysql');
const settings = require('./settings.json');

// データベース接続設定
const connection = mysql.createConnection({
    host: 'your_host',
    user: 'your_username',
    password: 'your_password',
    database: 'your_database'
});

function boolToInt(bool) {
    return bool ? 1 : 0;
}

// 新しい設定オブジェクトの初期化
let new_settings = {};
/*
{
        "disable": {
            "user": [],
            "channel": [],
            "role": {},
        },
        "bannedWords": {},
        "defaultLanguage": {},
        "editOriginalIfTranslate": {},
        "sendMediaAsAttachmentsAsDefault": {},
        "deletemessageifonlypostedtweetlink": {},
        "alwaysreplyifpostedtweetlink": {},
        "button_invisible": {},
        "button_disabled": {},
        "extract_bot_message": {},
        "quote_repost_do_not_extract": {},
        "legacy_mode": {},
        "secondary_extract_mode": {},
        "save_tweet_quota_override": {},
        "deletemessageifonlypostedtweetlink_secoundaryextractmode": {},
    }
*/


Object.keys(settings).forEach(key => {
    const config = settings[key];
    Object.keys(config).forEach(guildId => {
        if (!new_settings[guildId]) {
            new_settings[guildId] = {};
        }

        switch (key) {
            case 'disable':
                if (config[guildId].role) new_settings[guildId]['disable_roles'] = config[guildId].role.join(',');
                break;
            case 'bannedWords':
                new_settings[guildId]['bannedWords'] = config[guildId].join(',');
                break;
            case 'defaultLanguage':
                new_settings[guildId]['defaultLanguage'] = config[guildId] === 'en' ? 'en-US' : config[guildId];
                break;
            case 'editOriginalIfTranslate':
            case 'sendMediaAsAttachmentsAsDefault':
            case 'deletemessageifonlypostedtweetlink':
            case 'alwaysreplyifpostedtweetlink':
            case 'extract_bot_message':
            case 'legacy_mode':
            case 'secondary_extract_mode':
            case 'deletemessageifonlypostedtweetlink_secoundaryextractmode':
                new_settings[guildId][key] = boolToInt(config[guildId]);
                break;
            case 'button_invisible':
                Object.keys(config[guildId]).forEach(subKey => {
                    new_settings[guildId][`button_invisible_${subKey}`] = boolToInt(config[guildId][subKey]);
                });
                break;
            case 'button_disabled':
                ['users', 'channels', 'roles'].forEach(type => {
                    if (config[guildId][type]) new_settings[guildId][`button_disabled_${type}`] = config[guildId][type].join(',');
                });
                break;
            case 'quote_repost_do_not_extract':
                new_settings[guildId]['maxExtractQuotedTweet'] = config[guildId] ? 0 : 3; // ここでは条件に基づいて値を設定
                break;
            //他の設定も同様に追加

        }
    });
});

// データベースに挿入する関数
function insertSettings() {
    Object.entries(new_settings).forEach(([guildId, settings]) => {
        const columns = Object.keys(settings).join(', ');
        const placeholders = new Array(Object.keys(settings).length).fill('?').join(', ');
        const sql = `INSERT INTO settings (guildId, ${columns}) VALUES (?, ${placeholders}) ON DUPLICATE KEY UPDATE ${Object.keys(settings).map(key => `${key}=VALUES(${key})`).join(', ')}`;

        connection.query(sql, [guildId, ...Object.values(settings)], (error, results) => {
            if (error) return console.error(error.message);
            console.log(`Settings updated for guildId: ${guildId}`);
        });
    });
}

// データベース挿入処理の実行
insertSettings();

// データベース接続を終了
connection.end();
