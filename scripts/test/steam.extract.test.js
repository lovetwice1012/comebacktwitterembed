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
    assert.equal(step.components[0].components.length, 1);
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
