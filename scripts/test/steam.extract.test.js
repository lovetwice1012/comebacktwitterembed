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
