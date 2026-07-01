'use strict';

const {
    DEFAULT_DISCORD_LOCALE,
    DISCORD_LOCALES,
    DISCORD_LOCALE_SET,
    LOCALE_ALIASES,
    normalizeDiscordLocale,
} = require('./discordLocales');

const DEFAULT_LOCALE = DEFAULT_DISCORD_LOCALE;
const SUPPORTED_LOCALES = DISCORD_LOCALES;

function loadCatalog(locale) {
    const catalog = require(`./i18n/locales/${locale}`);
    const legacy = require(`./i18n/legacy/${locale}`);
    return { ...catalog, legacy };
}

const CATALOGS = Object.fromEntries(SUPPORTED_LOCALES.map(locale => [
    locale,
    loadCatalog(locale),
]));

function normalizeLocale(locale) {
    return normalizeDiscordLocale(locale, locale ? String(locale) : DEFAULT_LOCALE);
}

function getLocaleCandidates(locale, options = {}) {
    const normalized = normalizeLocale(locale);
    const defaultLocale = options.defaultLocale || DEFAULT_LOCALE;
    const candidates = [];

    const add = value => {
        if (value && !candidates.includes(value)) candidates.push(value);
    };

    add(normalized);
    if (normalized === 'en-US') add('en');
    if (normalized.includes('-') && normalized !== 'en-US' && normalized !== 'es-ES' && normalized !== 'pt-BR' && !normalized.startsWith('zh-')) {
        add(normalized.split('-')[0]);
    }
    if (options.defaultJa === true) add('ja');
    add(defaultLocale);
    add(DEFAULT_LOCALE);
    if (DEFAULT_LOCALE === 'en-US') add('en');

    return candidates;
}

function localize(localizedValues, locale, options = {}) {
    if (localizedValues === undefined || localizedValues === null) return undefined;
    if (typeof localizedValues === 'string') return localizedValues;

    for (const candidate of getLocaleCandidates(locale, options)) {
        if (localizedValues[candidate] !== undefined) return localizedValues[candidate];
    }
    return undefined;
}

function formatTemplate(template, replacements = {}) {
    if (template === undefined || template === null) return undefined;
    let text = String(template ?? '');
    for (const [key, value] of Object.entries(replacements)) {
        text = text.replaceAll(`{${key}}`, String(value));
    }
    return text;
}

function translate(localizedValues, locale, replacements = {}, options = {}) {
    return formatTemplate(localize(localizedValues, locale, options), replacements);
}

function localizeByKey(dictionary, key, locale, replacements = {}, options = {}) {
    const entry = dictionary?.[key];
    return translate(entry, locale, replacements, options);
}

function getPathValue(object, keyPath) {
    if (!object || !keyPath) return undefined;
    return String(keyPath).split('.').reduce((current, segment) => {
        if (current === undefined || current === null) return undefined;
        return current[segment];
    }, object);
}

function catalogText(keyPath, locale, replacements = {}, options = {}) {
    for (const candidate of getLocaleCandidates(locale, options)) {
        const value = getPathValue(CATALOGS[candidate], keyPath);
        if (value !== undefined) return formatTemplate(value, replacements);
    }
    return undefined;
}

function toDiscordLocalizations(localizedValues) {
    if (!localizedValues) return undefined;
    const defaultValue = localizedValues[DEFAULT_LOCALE] ?? localizedValues.en;
    if (defaultValue === undefined) return undefined;

    const out = {};
    for (const [locale, value] of Object.entries(localizedValues)) {
        const normalized = normalizeLocale(locale);
        const discordLocale = normalized === DEFAULT_LOCALE ? DEFAULT_DISCORD_LOCALE : normalized;
        if (!DISCORD_LOCALE_SET.has(discordLocale)) continue;
        out[discordLocale] = value;
    }
    if (out[DEFAULT_DISCORD_LOCALE] === undefined) out[DEFAULT_DISCORD_LOCALE] = defaultValue;
    return out;
}

function toDiscordLocalizationsForKey(keyPath) {
    const localizedValues = {};
    for (const locale of SUPPORTED_LOCALES) {
        const value = getPathValue(CATALOGS[locale], keyPath);
        if (value !== undefined) localizedValues[locale] = value;
    }
    return toDiscordLocalizations(localizedValues);
}

function collectCatalogValues(keyPath, requiredLocales = SUPPORTED_LOCALES) {
    const localizedValues = {};
    for (const locale of requiredLocales) {
        const value = getPathValue(CATALOGS[locale], keyPath);
        if (value !== undefined) localizedValues[locale] = value;
    }
    return localizedValues;
}

function isLocaleFamily(locale, family) {
    return normalizeLocale(locale).toLowerCase().split('-')[0] === family.toLowerCase();
}

function missingLocales(localizedValues, requiredLocales = SUPPORTED_LOCALES) {
    if (!localizedValues || typeof localizedValues !== 'object') return [...requiredLocales];
    return requiredLocales.filter(locale => localizedValues[locale] === undefined);
}

function collectLeafPaths(object, prefix = '') {
    if (!object || typeof object !== 'object') return [];
    const paths = [];
    for (const [key, value] of Object.entries(object)) {
        const nextPrefix = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object') {
            paths.push(...collectLeafPaths(value, nextPrefix));
        } else {
            paths.push(nextPrefix);
        }
    }
    return paths;
}

function missingCatalogKeys(namespace = null, requiredLocales = SUPPORTED_LOCALES) {
    const base = namespace ? getPathValue(CATALOGS[DEFAULT_LOCALE], namespace) : CATALOGS[DEFAULT_LOCALE];
    const basePrefix = namespace ? `${namespace}.` : '';
    const keys = collectLeafPaths(base).map(key => basePrefix + key);
    const missing = [];

    for (const locale of requiredLocales) {
        for (const key of keys) {
            if (getPathValue(CATALOGS[locale], key) === undefined) {
                missing.push({ locale, key });
            }
        }
    }

    return missing;
}

module.exports = {
    DEFAULT_LOCALE,
    DEFAULT_DISCORD_LOCALE,
    DISCORD_LOCALES,
    LOCALE_ALIASES,
    SUPPORTED_LOCALES,
    catalogText,
    collectCatalogValues,
    getLocaleCandidates,
    getPathValue,
    isLocaleFamily,
    localize,
    localizeByKey,
    missingCatalogKeys,
    missingLocales,
    normalizeLocale,
    toDiscordLocalizationsForKey,
    toDiscordLocalizations,
    translate,
};
