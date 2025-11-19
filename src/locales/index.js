const ja = require('./ja');
const en = require('./en');

/**
 * Get localized string
 * @param {string} key - Localization key
 * @param {string} locale - Locale code (ja, en, en-US, etc.)
 * @param {boolean} default_ja - Use Japanese as default instead of English
 * @returns {string} - Localized string
 */
function t(key, locale = 'en', default_ja = false) {
    const locales = { ja, en, 'en-US': en };

    // Normalize locale
    if (locale && locale.startsWith('en-')) {
        locale = 'en';
    }
    if (locale === 'jp') {
        locale = 'ja';
    }

    // Try to get the localized string
    if (locales[locale] && locales[locale][key] !== undefined) {
        return locales[locale][key];
    }

    // Fallback to Japanese if default_ja is true
    if (default_ja && locales['ja'][key] !== undefined) {
        return locales['ja'][key];
    }

    // Final fallback to English
    return locales['en'][key] || key;
}

/**
 * Get localized object (for Discord command localizations)
 * @param {string} key - Localization key
 * @returns {Object} - Object with ja and en keys
 */
function getLocaleObject(key) {
    return {
        ja: ja[key],
        en: en[key]
    };
}

/**
 * Convert en locale to en-US format for Discord
 * @param {Object} obj - Localization object
 * @returns {Object}
 */
function convEnToEnUS(obj) {
    if (!obj) return undefined;
    const result = { ...obj };
    if (result.en !== undefined) {
        result['en-US'] = result.en;
        delete result.en;
    }
    return result;
}

module.exports = {
    t,
    getLocaleObject,
    convEnToEnUS,
    ja,
    en
};
