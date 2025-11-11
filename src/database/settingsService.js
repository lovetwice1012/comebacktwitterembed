const NodeCache = require('node-cache');
const pool = require('./dbPool');

// 設定キャッシュ（TTL: 10分）
const settingsCache = new NodeCache({
    stdTTL: 600,           // 10分でキャッシュ期限切れ
    checkperiod: 120,      // 2分ごとに期限切れチェック
    useClones: false       // パフォーマンス向上のためクローンしない
});

// デフォルト設定
const DEFAULT_SETTINGS = {
    bannedWords: null,
    defaultLanguage: 'en-US',
    editOriginalIfTranslate: 0,
    sendMediaAsAttachmentsAsDefault: 0,
    deleteMessageIfOnlyPostedTweetLink: 0,
    alwaysReply: 0,
    button_invisible_showMediaAsAttachments: 0,
    button_invisible_showAttachmentsAsEmbedsImage: 0,
    button_invisible_translate: 0,
    button_invisible_delete: 0,
    button_invisible_reload: 0,
    button_disabled_users: null,
    button_disabled_channels: null,
    button_disabled_roles: null,
    disable_users: null,
    disable_channels: null,
    disable_roles: null,
    extractBotMessage: 0,
    extractWebhookMessage: 0,
    sendMovieAsLink: 0,
    anonymous_users: null,
    anonymous_channels: null,
    anonymous_roles: null,
    maxExtractQuotedTweet: 3,
};

class SettingsService {
    /**
     * ギルドの設定を取得（キャッシュ優先）
     * @param {string} guildId - ギルドID
     * @returns {Promise<Object>} 設定オブジェクト
     */
    static async getSettings(guildId) {
        // キャッシュチェック
        const cacheKey = `settings:${guildId}`;
        const cachedSettings = settingsCache.get(cacheKey);
        
        if (cachedSettings) {
            return cachedSettings;
        }

        // DBから取得
        try {
            const [results] = await pool.query(
                'SELECT * FROM settings WHERE guildId = ?',
                [guildId]
            );

            let settings;
            if (results.length === 0) {
                // デフォルト設定を作成
                settings = { ...DEFAULT_SETTINGS, guildId };
                await pool.query('INSERT INTO settings SET ?', [settings]);
                console.log(`デフォルト設定を作成: guildId=${guildId}`);
            } else {
                settings = results[0];
            }

            // キャッシュに保存
            settingsCache.set(cacheKey, settings);
            return settings;
        } catch (error) {
            console.error('設定取得エラー:', error);
            // エラー時はデフォルト設定を返す（キャッシュはしない）
            return { ...DEFAULT_SETTINGS, guildId };
        }
    }

    /**
     * 設定を更新
     * @param {string} guildId - ギルドID
     * @param {Object} updates - 更新する設定
     * @returns {Promise<boolean>} 成功/失敗
     */
    static async updateSettings(guildId, updates) {
        try {
            // 更新するデータにguildIdを含める
            const updateData = { ...updates, guildId };
            
            await pool.query(
                'INSERT INTO settings SET ? ON DUPLICATE KEY UPDATE ?',
                [updateData, updates]
            );

            // キャッシュを削除（次回取得時に再キャッシュ）
            const cacheKey = `settings:${guildId}`;
            settingsCache.del(cacheKey);
            
            console.log(`設定を更新: guildId=${guildId}`);
            return true;
        } catch (error) {
            console.error('設定更新エラー:', error);
            return false;
        }
    }

    /**
     * キャッシュをクリア（特定のギルドまたは全体）
     * @param {string|null} guildId - ギルドID（nullの場合は全体）
     */
    static clearCache(guildId = null) {
        if (guildId) {
            const cacheKey = `settings:${guildId}`;
            settingsCache.del(cacheKey);
            console.log(`キャッシュクリア: ${cacheKey}`);
        } else {
            settingsCache.flushAll();
            console.log('全キャッシュクリア');
        }
    }

    /**
     * キャッシュ統計を取得
     * @returns {Object} キャッシュ統計
     */
    static getCacheStats() {
        return settingsCache.getStats();
    }
}

module.exports = SettingsService;
