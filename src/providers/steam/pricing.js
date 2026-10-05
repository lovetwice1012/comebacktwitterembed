'use strict';

const { normalizeDiscordLocale } = require('../../discordLocales');
const { cleanText } = require('./steamSourceParser');

// Discord language settings select the default market; an explicit Store cc wins.
// es-419 covers several countries, so Mexico is the default for that locale.
const MARKETS = {
    id: ['id', 'indonesian'], da: ['dk', 'danish'], de: ['de', 'german'],
    'en-GB': ['gb', 'english'], 'en-US': ['us', 'english'],
    'es-ES': ['es', 'spanish'], 'es-419': ['mx', 'latam'], fr: ['fr', 'french'],
    hr: ['hr', 'english'], it: ['it', 'italian'], lt: ['lt', 'english'],
    hu: ['hu', 'hungarian'], nl: ['nl', 'dutch'], no: ['no', 'norwegian'],
    pl: ['pl', 'polish'], 'pt-BR': ['br', 'brazilian'], ro: ['ro', 'romanian'],
    fi: ['fi', 'finnish'], 'sv-SE': ['se', 'swedish'], vi: ['vn', 'vietnamese'],
    tr: ['tr', 'turkish'], cs: ['cz', 'czech'], el: ['gr', 'greek'],
    bg: ['bg', 'bulgarian'], ru: ['ru', 'russian'], uk: ['ua', 'ukrainian'],
    hi: ['in', 'english'], th: ['th', 'thai'], 'zh-CN': ['cn', 'schinese'],
    ja: ['jp', 'japanese'], 'zh-TW': ['tw', 'tchinese'], ko: ['kr', 'koreana'],
};

const COUNTRY_CODES = new Set(('ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz '
    + 'ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy '
    + 'hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz '
    + 'na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz '
    + 'ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw').split(' '));

function resolveSteamLocale(settings, parsed) {
    const locale = normalizeDiscordLocale(settings?.defaultLanguage, 'en-US');
    const [defaultCountry, language] = MARKETS[locale] || MARKETS['en-US'];
    let country = defaultCountry;
    try {
        const explicitCountry = new URL(parsed?.openUrl || parsed?.canonicalUrl).searchParams.get('cc')?.toLowerCase();
        if (COUNTRY_CODES.has(explicitCountry)) country = explicitCountry;
    } catch { /* No explicit Store country. */ }
    return { locale, country, language };
}

function steamPriceAmount(value) {
    // Store APIs and data-price-final use hundredths even for JPY and KRW.
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number / 100 : null;
}

function validDiscount(value) {
    const discount = Number(value);
    return Number.isFinite(discount) && discount > 0 && discount <= 100 ? discount : 0;
}

function formatSteamDiscount(value, lang) {
    const discount = validDiscount(value);
    return discount ? `${discount}% ${lang === 'ja' ? 'オフ' : 'off'}` : '';
}

function formatSteamPrice(price, locale, lang) {
    if (!price || typeof price !== 'object') return '';
    let label = cleanText(price.final_formatted || '');
    if (!label) {
        const amount = steamPriceAmount(price.final);
        const currency = String(price.currency || '').toUpperCase();
        if (amount === null || !/^[A-Z]{3}$/.test(currency)) return '';
        try {
            label = new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
        } catch {
            return '';
        }
    }
    const discount = formatSteamDiscount(price.discount_percent, lang);
    return discount ? `${label} (${discount})` : label;
}

module.exports = { resolveSteamLocale, steamPriceAmount, formatSteamPrice, formatSteamDiscount };
