'use strict';

const { Locale } = require('discord.js');

const DEFAULT_DISCORD_LOCALE = 'en-US';

const DISCORD_LOCALE_OPTIONS = Object.freeze([
    { value: 'id', flag: '🇮🇩', languageName: 'Indonesian', nativeName: 'Bahasa Indonesia' },
    { value: 'da', flag: '🇩🇰', languageName: 'Danish', nativeName: 'Dansk' },
    { value: 'de', flag: '🇩🇪', languageName: 'German', nativeName: 'Deutsch' },
    { value: 'en-GB', flag: '🇬🇧', languageName: 'English, UK', nativeName: 'English, UK' },
    { value: 'en-US', flag: '🇺🇸', languageName: 'English, US', nativeName: 'English, US' },
    { value: 'es-ES', flag: '🇪🇸', languageName: 'Spanish', nativeName: 'Español' },
    { value: 'es-419', flag: '🌎', languageName: 'Spanish, LATAM', nativeName: 'Español, LATAM' },
    { value: 'fr', flag: '🇫🇷', languageName: 'French', nativeName: 'Français' },
    { value: 'hr', flag: '🇭🇷', languageName: 'Croatian', nativeName: 'Hrvatski' },
    { value: 'it', flag: '🇮🇹', languageName: 'Italian', nativeName: 'Italiano' },
    { value: 'lt', flag: '🇱🇹', languageName: 'Lithuanian', nativeName: 'Lietuviškai' },
    { value: 'hu', flag: '🇭🇺', languageName: 'Hungarian', nativeName: 'Magyar' },
    { value: 'nl', flag: '🇳🇱', languageName: 'Dutch', nativeName: 'Nederlands' },
    { value: 'no', flag: '🇳🇴', languageName: 'Norwegian', nativeName: 'Norsk' },
    { value: 'pl', flag: '🇵🇱', languageName: 'Polish', nativeName: 'Polski' },
    { value: 'pt-BR', flag: '🇧🇷', languageName: 'Portuguese, Brazilian', nativeName: 'Português do Brasil' },
    { value: 'ro', flag: '🇷🇴', languageName: 'Romanian, Romania', nativeName: 'Română' },
    { value: 'fi', flag: '🇫🇮', languageName: 'Finnish', nativeName: 'Suomi' },
    { value: 'sv-SE', flag: '🇸🇪', languageName: 'Swedish', nativeName: 'Svenska' },
    { value: 'vi', flag: '🇻🇳', languageName: 'Vietnamese', nativeName: 'Tiếng Việt' },
    { value: 'tr', flag: '🇹🇷', languageName: 'Turkish', nativeName: 'Türkçe' },
    { value: 'cs', flag: '🇨🇿', languageName: 'Czech', nativeName: 'Čeština' },
    { value: 'el', flag: '🇬🇷', languageName: 'Greek', nativeName: 'Ελληνικά' },
    { value: 'bg', flag: '🇧🇬', languageName: 'Bulgarian', nativeName: 'български' },
    { value: 'ru', flag: '🇷🇺', languageName: 'Russian', nativeName: 'Русский' },
    { value: 'uk', flag: '🇺🇦', languageName: 'Ukrainian', nativeName: 'Українська' },
    { value: 'hi', flag: '🇮🇳', languageName: 'Hindi', nativeName: 'हिन्दी' },
    { value: 'th', flag: '🇹🇭', languageName: 'Thai', nativeName: 'ไทย' },
    { value: 'zh-CN', flag: '🇨🇳', languageName: 'Chinese, China', nativeName: '中文' },
    { value: 'ja', flag: '🇯🇵', languageName: 'Japanese', nativeName: '日本語' },
    { value: 'zh-TW', flag: '🇹🇼', languageName: 'Chinese, Taiwan', nativeName: '繁體中文' },
    { value: 'ko', flag: '🇰🇷', languageName: 'Korean', nativeName: '한국어' },
]);

const DISCORD_LOCALES = Object.freeze(Object.values(Locale));
const DISCORD_LOCALE_SET = new Set(DISCORD_LOCALES);
const LOCALE_ALIASES = Object.freeze({
    en: 'en-US',
    jp: 'ja',
    'ko-KR': 'ko',
});

const optionByLocale = new Map(DISCORD_LOCALE_OPTIONS.map(option => [option.value, option]));
const localeByLowercase = new Map();
for (const locale of DISCORD_LOCALES) localeByLowercase.set(locale.toLowerCase(), locale);
for (const [alias, locale] of Object.entries(LOCALE_ALIASES)) localeByLowercase.set(alias.toLowerCase(), locale);

function normalizeDiscordLocale(locale, fallback = null) {
    const text = String(locale || '').trim();
    if (!text) return fallback;
    return localeByLowercase.get(text.toLowerCase()) || fallback;
}

function isSupportedDiscordLocale(locale) {
    return normalizeDiscordLocale(locale) === locale;
}

function discordLocaleOption(locale) {
    const normalized = normalizeDiscordLocale(locale);
    return normalized ? optionByLocale.get(normalized) || null : null;
}

function formatDiscordLocaleName(locale, options = {}) {
    const option = discordLocaleOption(locale);
    if (!option) return String(locale || '');
    const code = options.includeCode === false ? '' : ` (${option.value})`;
    const flag = options.includeFlag === false ? '' : `${option.flag} `;
    return `${flag}${option.nativeName}${code}`;
}

function toApiLocaleFamily(locale) {
    const normalized = normalizeDiscordLocale(locale, DEFAULT_DISCORD_LOCALE);
    return normalized === 'ja' ? 'ja' : 'en';
}

module.exports = {
    DEFAULT_DISCORD_LOCALE,
    DISCORD_LOCALE_OPTIONS,
    DISCORD_LOCALES,
    DISCORD_LOCALE_SET,
    LOCALE_ALIASES,
    discordLocaleOption,
    formatDiscordLocaleName,
    isSupportedDiscordLocale,
    normalizeDiscordLocale,
    toApiLocaleFamily,
};
