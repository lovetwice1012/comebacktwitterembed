const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../../settings.json');

/**
 * Initialize settings file with default structure
 */
function initializeSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) {
        const defaultSettings = {
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
            "passive_mode": {},
            "secondary_extract_mode": {},
            "save_tweet_quota_override": {},
            "deletemessageifonlypostedtweetlink_secoundaryextractmode": {},
        };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 4));
    }
}

/**
 * Load settings from file
 * @returns {Object} - Settings object
 */
function loadSettings() {
    initializeSettings();
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return migrateSettings(settings);
}

/**
 * Migrate settings to ensure all required fields exist
 * @param {Object} settings - Current settings
 * @returns {Object} - Migrated settings
 */
function migrateSettings(settings) {
    let modified = false;

    const requiredFields = [
        'disable.role',
        'defaultLanguage',
        'editOriginalIfTranslate',
        'sendMediaAsAttachmentsAsDefault',
        'deletemessageifonlypostedtweetlink',
        'alwaysreplyifpostedtweetlink',
        'button_invisible',
        'button_disabled',
        'extract_bot_message',
        'quote_repost_do_not_extract',
        'legacy_mode',
        'passive_mode',
        'secondary_extract_mode',
        'save_tweet_quota_override',
        'deletemessageifonlypostedtweetlink_secoundaryextractmode'
    ];

    // Ensure nested disable.role exists
    if (settings.disable && settings.disable.role === undefined) {
        settings.disable.role = {};
        modified = true;
    }

    // Ensure all other required fields exist
    for (const field of requiredFields) {
        if (field.includes('.')) {
            const [parent, child] = field.split('.');
            if (settings[parent] && settings[parent][child] === undefined) {
                settings[parent][child] = {};
                modified = true;
            }
        } else if (settings[field] === undefined) {
            settings[field] = {};
            modified = true;
        }
    }

    if (modified) {
        saveSettings(settings);
    }

    return settings;
}

/**
 * Save settings to file
 * @param {Object} settings - Settings object
 */
function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
}

/**
 * Get current settings
 * @returns {Object}
 */
function getSettings() {
    return loadSettings();
}

module.exports = {
    initializeSettings,
    loadSettings,
    saveSettings,
    getSettings
};
