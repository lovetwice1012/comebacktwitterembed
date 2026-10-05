'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const steamModulePath = require.resolve('../../src/providers/steam');
const fetchModulePath = require.resolve('node-fetch');

function loadSteamProviderWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalSteamModule = require.cache[steamModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[steamModulePath];

    try {
        return require(steamModulePath);
    } finally {
        delete require.cache[steamModulePath];
        if (originalSteamModule) require.cache[steamModulePath] = originalSteamModule;
        if (originalFetchModule) require.cache[fetchModulePath] = originalFetchModule;
        else delete require.cache[fetchModulePath];
    }
}

function createMessage(content) {
    return {
        guild: { id: 'guild-1' },
        author: { username: 'tester', id: 'user-1' },
        user: { username: 'tester', id: 'user-1' },
        content,
    };
}

function okJson(json) {
    return {
        ok: true,
        json: async () => json,
    };
}

function okHtml(html, finalUrl) {
    return {
        ok: true,
        url: finalUrl,
        text: async () => html,
    };
}

function appDetailsPayload(appId = '730') {
    return {
        [appId]: {
            success: true,
            data: {
                type: 'game',
                name: 'Counter-Strike 2',
                short_description: 'For over two decades, Counter-Strike has offered elite competitive action.',
                header_image: 'https://cdn.example/steam/header.jpg',
                capsule_image: 'https://cdn.example/steam/capsule.jpg',
                screenshots: [
                    {
                        path_thumbnail: 'https://cdn.example/steam/screenshot-thumb.jpg',
                        path_full: 'https://cdn.example/steam/screenshot-full.jpg',
                    },
                ],
                is_free: true,
                release_date: { coming_soon: false, date: 'Aug 21, 2012' },
                developers: ['Valve'],
                publishers: ['Valve'],
                genres: [{ description: 'Action' }, { description: 'Free To Play' }],
                platforms: { windows: true, mac: false, linux: true },
                recommendations: { total: 1000000 },
            },
        },
    };
}

function workshopHtml() {
    return `
        <html>
            <head>
                <meta property="og:title" content="Steam Community :: Guide :: Sample Build">
                <meta property="og:description" content="A useful guide from the Workshop.">
                <meta property="og:image" content="//images.example/workshop.jpg">
            </head>
        </html>
    `;
}

function fieldValue(embed, name) {
    return (embed.fields || []).find(field => field.name === name)?.value;
}

test('steam extract: builds a Steam app embed from appdetails data', async () => {
    const requests = [];
    const provider = loadSteamProviderWithFetch(async (url) => {
        requests.push(String(url));
        return okJson(appDetailsPayload());
    });

    const url = 'https://store.steampowered.com/app/730/CounterStrike_2/?snr=1';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(result.length, 1);
    assert.equal(new URL(requests[0]).origin + new URL(requests[0]).pathname, 'https://store.steampowered.com/api/appdetails');
    assert.equal(new URL(requests[0]).searchParams.get('appids'), '730');
    assert.equal(new URL(requests[0]).searchParams.get('l'), 'english');
    assert.equal(new URL(requests[0]).searchParams.get('cc'), 'us');

    const step = result[0];
    const embed = step.embeds[0];
    assert.equal(embed.title, 'Counter-Strike 2');
    assert.equal(embed.url, 'https://store.steampowered.com/app/730');
    assert.equal(embed.description, 'For over two decades, Counter-Strike has offered elite competitive action.');
    assert.equal(embed.image.url, 'https://cdn.example/steam/header.jpg');
    assert.equal(fieldValue(embed, 'Type'), 'Game');
    assert.equal(fieldValue(embed, 'Price'), 'Free To Play');
    assert.equal(fieldValue(embed, 'Release date'), 'Aug 21, 2012');
    assert.equal(fieldValue(embed, 'Developer'), 'Valve');
    assert.equal(fieldValue(embed, 'Publisher'), 'Valve');
    assert.equal(fieldValue(embed, 'Genres'), 'Action, Free To Play');
    assert.equal(fieldValue(embed, 'Platforms'), 'Windows, Linux');
    assert.equal(fieldValue(embed, 'Recommendations'), '1,000,000');
    assert.equal(fieldValue(embed, 'ID'), '730');
    assert.equal(step.components[0].components[0].data.label, 'Open in Steam Store');
    assert.equal(step.components[0].components[0].data.url, 'https://store.steampowered.com/app/730/CounterStrike_2/');
    assert.equal(step.components[0].components[1].data.custom_id, 'showMediaAsAttachments');
    assert.equal(step.suppressSourceEmbeds, true);
});

test('steam extract: GUI output settings can hide price and platform fields', async () => {
    const provider = loadSteamProviderWithFetch(async () => okJson(appDetailsPayload()));

    const url = 'https://store.steampowered.com/app/730/CounterStrike_2/';
    const result = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['price', 'platforms'],
    });

    const embed = result[0].embeds[0];
    assert.equal(fieldValue(embed, 'Price'), undefined);
    assert.equal(fieldValue(embed, 'Platforms'), undefined);
    assert.equal(fieldValue(embed, 'Developer'), 'Valve');
});

test('steam extract: honors description length setting', async () => {
    const payload = appDetailsPayload();
    payload['730'].data.short_description = '0123456789abcdefghijklmnopqrstuvwxyz';
    const provider = loadSteamProviderWithFetch(async () => okJson(payload));

    const url = 'https://store.steampowered.com/app/730/CounterStrike_2/';
    const limited = await provider.extract(createMessage(url), url, {
        steam_description_max_length: 10,
    });

    assert.equal(limited[0].embeds[0].description, '0123456...');

    const hidden = await provider.extract(createMessage(url), url, {
        steam_description_max_length: 0,
    });

    assert.equal(hidden[0].embeds[0].description, undefined);
});

test('steam extract: sale and review-adjacent fields can be hidden', async () => {
    const payload = appDetailsPayload();
    payload['730'].data.is_free = false;
    payload['730'].data.price_overview = {
        final_formatted: '$9.99',
        discount_percent: 50,
        discount_expiration: 1710003600,
    };
    payload['730'].data.metacritic = {
        score: 88,
        url: 'https://www.metacritic.com/game/counter-strike-2/',
    };
    const provider = loadSteamProviderWithFetch(async () => okJson(payload));

    const url = 'https://store.steampowered.com/app/730/CounterStrike_2/';
    const visible = await provider.extract(createMessage(url), url, {});
    const visibleEmbed = visible[0].embeds[0];
    assert.equal(fieldValue(visibleEmbed, 'Price'), '$9.99 (50% off)');
    assert.equal(fieldValue(visibleEmbed, 'Discount'), '50% off');
    assert.equal(fieldValue(visibleEmbed, 'Sale ends'), '<t:1710003600:R>');
    assert.equal(fieldValue(visibleEmbed, 'Metacritic'), '[88](https://www.metacritic.com/game/counter-strike-2/)');

    const hidden = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['discount', 'sale_ends', 'metacritic'],
    });
    const hiddenEmbed = hidden[0].embeds[0];
    assert.equal(fieldValue(hiddenEmbed, 'Discount'), undefined);
    assert.equal(fieldValue(hiddenEmbed, 'Sale ends'), undefined);
    assert.equal(fieldValue(hiddenEmbed, 'Metacritic'), undefined);
});

test('steam extract: current players and review summary are optional fields', async () => {
    const requests = [];
    const provider = loadSteamProviderWithFetch(async (url) => {
        const rawUrl = String(url);
        requests.push(rawUrl);
        if (rawUrl.includes('/api/appdetails')) return okJson(appDetailsPayload());
        if (rawUrl.includes('/ISteamUserStats/GetNumberOfCurrentPlayers/')) {
            return okJson({ response: { result: 1, player_count: 54321 } });
        }
        if (rawUrl.includes('/appreviews/730')) {
            return okJson({
                success: 1,
                query_summary: {
                    review_score_desc: 'Very Positive',
                    total_reviews: 123456,
                    total_positive: 110000,
                    total_negative: 13456,
                },
            });
        }
        throw new Error(`Unexpected Steam fetch: ${rawUrl}`);
    });

    const url = 'https://store.steampowered.com/app/730/CounterStrike_2/';
    const visible = await provider.extract(createMessage(url), url, {});
    const visibleEmbed = visible[0].embeds[0];

    assert.equal(fieldValue(visibleEmbed, 'Current players'), '54,321');
    assert.equal(fieldValue(visibleEmbed, 'Review summary'), 'Very Positive (123,456)');
    assert.ok(requests.some(request => request.includes('/ISteamUserStats/GetNumberOfCurrentPlayers/')));
    assert.ok(requests.some(request => request.includes('/appreviews/730')));

    requests.length = 0;
    const hidden = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['current_players', 'review_summary'],
    });
    const hiddenEmbed = hidden[0].embeds[0];

    assert.equal(fieldValue(hiddenEmbed, 'Current players'), undefined);
    assert.equal(fieldValue(hiddenEmbed, 'Review summary'), undefined);
    assert.equal(requests.some(request => request.includes('/ISteamUserStats/GetNumberOfCurrentPlayers/')), false);
    assert.equal(requests.some(request => request.includes('/appreviews/730')), false);
    assert.equal(hidden[0].analytics.metrics.current_players, undefined);
    assert.equal(hidden[0].analytics.metrics.review_count, undefined);
    assert.equal(hidden[0].analyticsEnrichers.length, 1);

    const enriched = await hidden[0].analyticsEnrichers[0]();
    assert.equal(requests.some(request => request.includes('/ISteamUserStats/GetNumberOfCurrentPlayers/')), true);
    assert.equal(requests.some(request => request.includes('/appreviews/730')), true);
    assert.equal(enriched.metrics.current_players, 54321);
    assert.equal(enriched.metrics.review_count, 123456);
});

test('steam extract: image source setting picks screenshots or capsule thumbnails', async () => {
    const provider = loadSteamProviderWithFetch(async () => okJson(appDetailsPayload()));
    const url = 'https://store.steampowered.com/app/730/CounterStrike_2/';

    const screenshot = await provider.extract(createMessage(url), url, {
        steam_image_source: 'screenshot',
    });
    assert.equal(screenshot[0].embeds[0].image.url, 'https://cdn.example/steam/screenshot-full.jpg');

    const thumbnail = await provider.extract(createMessage(url), url, {
        steam_image_source: 'thumbnail',
    });
    assert.equal(thumbnail[0].embeds[0].image.url, 'https://cdn.example/steam/capsule.jpg');
});

test('steam extract: compact density hides metadata and attachment mode sends image file', async () => {
    const provider = loadSteamProviderWithFetch(async () => okJson(appDetailsPayload()));

    const url = 'https://store.steampowered.com/app/730/CounterStrike_2/';
    const result = await provider.extract(createMessage(url), url, {
        display_density: 'compact',
        media_display_mode: 'attachment',
    });

    const step = result[0];
    const embed = step.embeds[0];
    assert.equal(embed.image, undefined);
    assert.deepEqual(embed.fields, []);
    assert.deepEqual(step.files, ['https://cdn.example/steam/header.jpg']);
    assert.equal(step.components[0].components.length, 2);
    assert.match(step.components[0].components[1].data.custom_id, /^priceWatch:s:app:730:/);
});

test('steam extract: falls back to OpenGraph metadata for Workshop links', async () => {
    const requests = [];
    const provider = loadSteamProviderWithFetch(async (url) => {
        requests.push(String(url));
        return okHtml(workshopHtml(), String(url));
    });

    const url = 'https://steamcommunity.com/sharedfiles/filedetails/?id=12345';
    const result = await provider.extract(createMessage(url), url, {});
    const step = result[0];
    const embed = step.embeds[0];

    assert.deepEqual(requests, [url]);
    assert.equal(embed.title, 'Guide :: Sample Build');
    assert.equal(embed.url, 'https://steamcommunity.com/sharedfiles/filedetails/?id=12345');
    assert.equal(embed.description, 'A useful guide from the Workshop.');
    assert.equal(embed.image.url, 'https://images.example/workshop.jpg');
    assert.equal(fieldValue(embed, 'Type'), 'Workshop item');
    assert.equal(fieldValue(embed, 'ID'), '12345');
    assert.equal(step.components[0].components[0].data.label, 'Open in Steam Community');
});

test('steam extract: can delete source message when only the Steam link was posted', async () => {
    const provider = loadSteamProviderWithFetch(async () => okJson(appDetailsPayload()));

    const url = 'https://s.team/a/730';
    const result = await provider.extract(createMessage(url), url, { deletemessageifonlypostedtweetlink: true });

    assert.equal(result[0].deleteSource, true);
    assert.equal(result[0].embeds[0].url, 'https://store.steampowered.com/app/730');
});

test('steam urlPattern: matches Store, Community, and short Steam links', () => {
    const provider = loadSteamProviderWithFetch(async () => okJson(appDetailsPayload()));
    const sample = [
        'https://store.steampowered.com/app/730/CounterStrike_2/?snr=1',
        'https://store.steampowered.com/sub/12345/',
        'https://store.steampowered.com/bundle/6789/',
        'https://steamcommunity.com/sharedfiles/filedetails/?id=12345',
        'https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline',
        'https://s.team/a/730',
        'https://example.com/app/730',
    ].join(' ');

    const matches = sample.match(new RegExp(provider.urlPattern.source, provider.urlPattern.flags)) || [];
    assert.deepEqual(matches, [
        'https://store.steampowered.com/app/730/CounterStrike_2/?snr=1',
        'https://store.steampowered.com/sub/12345/',
        'https://store.steampowered.com/bundle/6789/',
        'https://steamcommunity.com/sharedfiles/filedetails/?id=12345',
        'https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline',
        'https://s.team/a/730',
    ]);
});

test('steam parse: rejects unsupported Steam and non-Steam pages', () => {
    const provider = require('../../src/providers/steam');

    assert.equal(provider._internal.parseSteamUrl('https://store.steampowered.com/app/730).').id, '730');
    assert.equal(provider._internal.parseSteamUrl('https://store.steampowered.com/search/?term=portal'), null);
    assert.equal(provider._internal.parseSteamUrl('https://steamcommunity.com/groups/example'), null);
    assert.equal(provider._internal.parseSteamUrl('https://example.com/app/730'), null);
});

test('steam prices: requests the configured market and Steam language without converting prices', async () => {
    const cases = [
        ['ja', 'jp', 'japanese', 'JPY', 120000, '¥ 1,200'],
        ['en-GB', 'gb', 'english', 'GBP', 850, '£8.50'],
        ['de', 'de', 'german', 'EUR', 975, '9,75€'],
        ['pt-BR', 'br', 'brazilian', 'BRL', 1999, 'R$ 19,99'],
        ['zh-TW', 'tw', 'tchinese', 'TWD', 18800, 'NT$ 188'],
        ['ko', 'kr', 'koreana', 'KRW', 1100000, '₩ 11,000'],
        ['es-419', 'mx', 'latam', 'MXN', 12399, 'Mex$ 123.99'],
        ['hi', 'in', 'english', 'INR', 58900, '₹ 589'],
    ];
    for (const [locale, country, language, currency, final, formatted] of cases) {
        let request;
        const provider = loadSteamProviderWithFetch(async (url) => {
            request = new URL(String(url));
            const payload = appDetailsPayload();
            Object.assign(payload['730'].data, {
                is_free: false, price_overview: { currency, final, final_formatted: formatted },
            });
            return okJson(payload);
        });
        const url = 'https://store.steampowered.com/app/730';
        const [step] = await provider.extract(createMessage(url), url, {
            defaultLanguage: locale, hidden_output_items: ['current_players', 'review_summary'],
        });
        assert.equal(request.searchParams.get('cc'), country, locale);
        assert.equal(request.searchParams.get('l'), language, locale);
        assert.equal(fieldValue(step.embeds[0], locale === 'ja' ? '価格' : 'Price'), formatted, locale);
        assert.equal(step.analytics.metrics.price, final / 100, locale);
        assert.ok(step.analytics.facets.some(item => item.key === 'price_currency' && item.value === currency), locale);
    }
});

test('steam prices: explicit valid cc overrides language market on Store and short links', async () => {
    const requests = [];
    const provider = loadSteamProviderWithFetch(async url => {
        requests.push(new URL(String(url)));
        return okJson(appDetailsPayload());
    });
    for (const [url, expectedCountry] of [
        ['https://store.steampowered.com/app/730?cc=DE', 'de'],
        ['https://s.team/a/730?cc=GB', 'gb'],
        ['https://store.steampowered.com/app/730?cc=zz', 'jp'],
        ['https://store.steampowered.com/app/730?cc=419', 'jp'],
    ]) {
        const [step] = await provider.extract(createMessage(url), url, {
            defaultLanguage: 'ja', hidden_output_items: ['current_players', 'review_summary'],
        });
        assert.equal(requests.at(-1).searchParams.get('cc'), expectedCountry);
        assert.equal(requests.at(-1).searchParams.get('l'), 'japanese');
        assert.equal(fieldValue(step.embeds[0], '価格'), '無料プレイ');
    }
});

test('steam prices: numeric fallbacks use Steam hundredths including zero-decimal currencies', async () => {
    for (const [locale, currency, final, amount] of [
        ['ja', 'JPY', 120000, 1200], ['ko', 'KRW', 1100000, 11000],
        ['de', 'EUR', 999, 9.99], ['en-GB', 'GBP', 0, 0],
    ]) {
        const payload = appDetailsPayload();
        Object.assign(payload['730'].data, {
            is_free: false, price_overview: { currency, final, discount_percent: 20 },
        });
        const provider = loadSteamProviderWithFetch(async () => okJson(payload));
        const url = 'https://store.steampowered.com/app/730';
        const settings = { defaultLanguage: locale, hidden_output_items: ['current_players', 'review_summary'] };
        const [step] = await provider.extract(createMessage(url), url, settings);
        const expected = new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount).replace(/\s+/g, ' ');
        const discount = locale === 'ja' ? '20% オフ' : '20% off';
        assert.equal(fieldValue(step.embeds[0], locale === 'ja' ? '価格' : 'Price'), `${expected} (${discount})`);
        assert.equal(fieldValue(step.embeds[0], locale === 'ja' ? '割引' : 'Discount'), discount);
        assert.equal(step.analytics.metrics.price, amount);

        const [hidden] = await provider.extract(createMessage(url), url, {
            ...settings, hidden_output_items: [...settings.hidden_output_items, 'price'],
        });
        assert.equal(fieldValue(hidden.embeds[0], locale === 'ja' ? '価格' : 'Price'), undefined);
        assert.equal(hidden.analytics.metrics.price, amount);
    }
});

test('steam prices: missing or invalid price data never becomes a free price', async () => {
    for (const price of [undefined, {}, { final: null, currency: 'USD' }, { final: '', currency: 'USD' },
        { final: false, currency: 'USD' }, { final: -1, currency: 'USD' },
        { final: 'unknown', currency: 'USD' }, { final: 1234 }, { final: 1234, currency: '$' }]) {
        const payload = appDetailsPayload();
        Object.assign(payload['730'].data, { is_free: false, price_overview: price });
        const provider = loadSteamProviderWithFetch(async () => okJson(payload));
        const url = 'https://store.steampowered.com/app/730';
        const [step] = await provider.extract(createMessage(url), url, {
            hidden_output_items: ['current_players', 'review_summary'],
        });
        assert.equal(fieldValue(step.embeds[0], 'Price'), undefined, JSON.stringify(price));
    }
});

test('steam prices: package and bundle HTML requests retain localized prices and identity', async () => {
    for (const [route, id, method] of [['sub', '7877', 'addToCart'], ['bundle', '234', 'addBundleToCart']]) {
        let request;
        const provider = loadSteamProviderWithFetch(async url => {
            request = new URL(String(url));
            return okHtml(`<title>Store product</title>
                <div class="game_purchase_action_bg"><div class="game_purchase_price" data-price-final="100">¥ 1</div>
                    <a href="javascript:${method}(999)">Unrelated</a></div>
                <div class="game_purchase_action_bg"><div class="discount_block" data-price-final="180000" data-discount="25">
                    <div class="discount_final_price">¥ 1,800</div></div>
                    <a href="javascript:${method}(${id})">Buy</a></div>`, String(url));
        });
        const url = `https://store.steampowered.com/${route}/${id}?cc=JP`;
        const [step] = await provider.extract(createMessage(url), url, { defaultLanguage: 'ja' });
        assert.equal(request.searchParams.get('cc'), 'jp');
        assert.equal(request.searchParams.get('l'), 'japanese');
        assert.equal(fieldValue(step.embeds[0], '価格'), '¥ 1,800 (25% オフ)');
        assert.equal(step.analytics.metrics.price, 1800);
        assert.equal(step.embeds[0].url, `https://store.steampowered.com/${route}/${id}`);
    }
});

test('steam prices: app HTML fallback localizes requests and ignores cheaper DLC purchase blocks', async () => {
    const requests = [];
    const provider = loadSteamProviderWithFetch(async url => {
        requests.push(new URL(String(url)));
        if (String(url).includes('/api/appdetails')) throw new Error('API temporarily unavailable');
        return okHtml(`<title>Portal 2</title>
            <div itemprop="offers" itemscope itemtype="http://schema.org/Offer">
                <meta itemprop="priceCurrency" content="EUR"><meta itemprop="price" content="9,75"></div>
            <div class="game_purchase_action_bg"><div class="game_purchase_price" data-price-final="99">0,99€</div></div>`, String(url));
    });
    const url = 'https://s.team/a/620?cc=de';
    const [step] = await provider.extract(createMessage(url), url, { defaultLanguage: 'ja' });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].pathname, '/app/620');
    assert.equal(requests[1].searchParams.get('cc'), 'de');
    assert.equal(requests[1].searchParams.get('l'), 'japanese');
    assert.equal(fieldValue(step.embeds[0], '価格'), new Intl.NumberFormat('ja', { style: 'currency', currency: 'EUR' }).format(9.75));
    assert.equal(step.analytics.metrics.price, 9.75);
});
