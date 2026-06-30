'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const boothModulePath = require.resolve('../../src/providers/booth');
const fetchModulePath = require.resolve('node-fetch');

function loadBoothProviderWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalBoothModule = require.cache[boothModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[boothModulePath];

    try {
        return require(boothModulePath);
    } finally {
        delete require.cache[boothModulePath];
        if (originalBoothModule) require.cache[boothModulePath] = originalBoothModule;
        if (originalFetchModule) require.cache[fetchModulePath] = originalFetchModule;
        else delete require.cache[fetchModulePath];
    }
}

function createMessage(content) {
    const url = content || 'https://booth.pm/ja/items/123456';
    return {
        guild: { id: 'guild-1' },
        author: { username: 'tester', id: 'user-1' },
        user: { username: 'tester', id: 'user-1' },
        content: url,
    };
}

function createInfo(imageCount, overrides = {}) {
    return {
        id: 123456,
        name: 'sample item',
        url: 'https://shop.booth.pm/items/123456',
        description: '<p>desc &amp; more</p>',
        price: '1,000 JPY',
        category: { id: 1, name: 'VRoid' },
        shop: { name: 'shopname', subdomain: 'shop', thumbnail_url: 'https://i.example/shop.jpg', url: 'https://shop.booth.pm/' },
        tags: [{ name: 'tag1', url: 'x' }, { name: 'tag2', url: 'y' }],
        is_adult: false,
        images: Array.from({ length: imageCount }, (_, idx) => ({ original: `https://i.example/${idx + 1}.jpg`, resized: `https://i.example/${idx + 1}_r.jpg` })),
        ...overrides,
    };
}

function fieldValue(embed, name) {
    return (embed.fields || []).find(field => field.name === name)?.value;
}

test('booth extract: builds embeds for shop subdomain url', async () => {
    let calledUrl = null;
    const provider = loadBoothProviderWithFetch(async (apiUrl) => {
        calledUrl = apiUrl;
        return { ok: true, json: async () => createInfo(3) };
    });

    const url = 'https://shop.booth.pm/items/123456';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(calledUrl, 'https://shop.booth.pm/items/123456.json');
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].embeds.length, 3);
    assert.equal(result[0].embeds[0].title, 'sample item');
    assert.ok(result[0].embeds[0].fields.some(f => f.value === '1,000 JPY'));
    assert.ok(result[0].embeds[0].fields.some(f => f.value === 'VRoid'));
});

test('booth extract: honors description length setting', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true,
        json: async () => createInfo(1, {
            description: '<p>0123456789abcdefghijklmnopqrstuvwxyz</p>',
        }),
    }));

    const url = 'https://shop.booth.pm/items/123456';
    const result = await provider.extract(createMessage(url), url, {
        booth_description_max_length: 8,
    });

    assert.equal(result[0].embeds[0].description, '0123456\u2026');

    const hidden = await provider.extract(createMessage(url), url, {
        booth_description_max_length: 0,
    });

    assert.equal(hidden[0].embeds[0].description, undefined);
});

test('booth extract: media_display_mode attachment sends item images as files', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true,
        json: async () => createInfo(3),
    }));

    const url = 'https://shop.booth.pm/items/123456';
    const result = await provider.extract(createMessage(url), url, {
        media_display_mode: 'attachment',
    });

    const step = result[0];
    assert.equal(step.embeds.length, 1);
    assert.equal(step.embeds[0].image, undefined);
    assert.equal(step.embeds[0].thumbnail, undefined);
    assert.deepEqual(step.files, [
        'https://i.example/1.jpg',
        'https://i.example/2.jpg',
        'https://i.example/3.jpg',
    ]);
    assert.equal(step.components[0].components[0].data.custom_id, 'translate');
});

test('booth extract: lang-prefixed booth.pm/ja/items url', async () => {
    let calledUrl = null;
    const provider = loadBoothProviderWithFetch(async (apiUrl) => {
        calledUrl = apiUrl;
        return { ok: true, json: async () => createInfo(1) };
    });

    const url = 'https://booth.pm/ja/items/777';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(calledUrl, 'https://booth.pm/ja/items/777.json');
    assert.ok(Array.isArray(result));
});

test('booth extract: caps embeds at 10 and groups image urls every 4', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true, json: async () => createInfo(20),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(result[0].embeds.length, 10);
    const urls = result[0].embeds.map(e => e.url);
    assert.equal(urls[0], urls[3], 'images 1-4 share group url');
    assert.notEqual(urls[3], urls[4], 'image 5 starts new group');
    assert.equal(urls[4], urls[7], 'images 5-8 share group url');
});

test('booth extract: image limit controls embeds and attachment media', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true, json: async () => createInfo(6),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const limited = await provider.extract(createMessage(url), url, {
        booth_image_limit: 4,
    });

    assert.equal(limited[0].embeds.length, 4);
    assert.equal(fieldValue(limited[0].embeds[0], 'Images'), '4 / 6');

    const attachments = await provider.extract(createMessage(url), url, {
        media_display_mode: 'attachment',
        booth_image_limit: 4,
    });

    assert.equal(attachments[0].embeds.length, 1);
    assert.deepEqual(attachments[0].files, [
        'https://i.example/1.jpg',
        'https://i.example/2.jpg',
        'https://i.example/3.jpg',
        'https://i.example/4.jpg',
    ]);

    const compact = await provider.extract(createMessage(url), url, {
        display_density: 'compact',
    });

    assert.equal(compact[0].embeds.length, 1);
    assert.equal(fieldValue(compact[0].embeds[0], 'Images'), undefined);
});

test('booth extract: adult display mode can hide media or send spoiler attachments', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true, json: async () => createInfo(3, { is_adult: true }),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const metadataOnly = await provider.extract(createMessage(url), url, {
        booth_adult_display_mode: 'metadata_only',
    });

    assert.equal(metadataOnly[0].embeds.length, 1);
    assert.equal(metadataOnly[0].embeds[0].title, 'sample item [R-18]');
    assert.equal(metadataOnly[0].embeds[0].image, undefined);
    assert.equal(metadataOnly[0].files, undefined);
    assert.equal(metadataOnly[0].content, undefined);
    assert.equal(fieldValue(metadataOnly[0].embeds[0], 'Images'), undefined);

    const spoiler = await provider.extract(createMessage(url), url, {
        booth_adult_display_mode: 'spoiler_attachment',
    });

    assert.equal(spoiler[0].embeds.length, 1);
    assert.equal(spoiler[0].embeds[0].image, undefined);
    assert.deepEqual(spoiler[0].files, [
        { attachment: 'https://i.example/1.jpg', name: 'SPOILER_booth-1-1.jpg', fallbackUrl: 'https://i.example/1.jpg' },
        { attachment: 'https://i.example/2.jpg', name: 'SPOILER_booth-1-2.jpg', fallbackUrl: 'https://i.example/2.jpg' },
        { attachment: 'https://i.example/3.jpg', name: 'SPOILER_booth-1-3.jpg', fallbackUrl: 'https://i.example/3.jpg' },
    ]);
    assert.equal(spoiler[0].components[0].components[0].data.custom_id, 'translate');
    assert.equal(fieldValue(spoiler[0].embeds[0], 'Images'), '3 / 3');
});

test('booth extract: returns null for non-booth url', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({ ok: true, json: async () => ({}) }));
    const url = 'https://example.com/items/1';
    const result = await provider.extract(createMessage(url), url, {});
    assert.equal(result, null);
});

test('booth extract: anonymous_expand hides requester username', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true, json: async () => createInfo(1),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const result = await provider.extract(createMessage(url), url, { anonymous_expand: true, defaultLanguage: 'en' });
    const footer = result[0].embeds[0].footer.text;
    assert.ok(footer.includes('Anonymous requester'));
    assert.ok(!footer.includes('tester'));
});

test('booth urlPattern: matches booth.pm variants and ignores accounts subdomain', () => {
    const provider = loadBoothProviderWithFetch(async () => ({ ok: true, json: async () => ({}) }));
    const re = new RegExp(provider.urlPattern.source, provider.urlPattern.flags);
    const sample = 'a https://booth.pm/ja/items/1 b https://shop.booth.pm/items/2 c https://accounts.booth.pm/items/3 d https://booth.pm/items/4';
    const matches = sample.match(re) || [];
    assert.ok(matches.includes('https://booth.pm/ja/items/1'));
    assert.ok(matches.includes('https://shop.booth.pm/items/2'));
    assert.ok(matches.includes('https://accounts.booth.pm/items/3'), 'pattern matches; parser excludes accounts subdomain');
    assert.ok(matches.includes('https://booth.pm/items/4'));
});

test('booth extract: rejects accounts subdomain at parser level', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({ ok: true, json: async () => createInfo(1) }));
    const url = 'https://accounts.booth.pm/items/1';
    const result = await provider.extract(createMessage(url), url, {});
    assert.equal(result, null);
});

test('booth extract: shows up to 5 variations with prices', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true,
        json: async () => createInfo(1, {
            variations: [
                { id: 1, name: 'A', price: 0, status: 'free_download' },
                { id: 2, name: 'B', price: 1500 },
                { id: 3, name: 'C', price: '¥2,000' },
                { id: 4, name: 'D', price: 3000, status: 'sold_out' },
                { id: 5, name: 'E', price: 500 },
                { id: 6, name: 'F', price: 600 },
                { id: 7, name: 'G', price: 700 },
            ],
        }),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const result = await provider.extract(createMessage(url), url, { defaultLanguage: 'ja' });
    const variationField = result[0].embeds[0].fields.find(f => f.name === 'バリエーション');
    assert.ok(variationField, 'variations field should exist');
    const lines = variationField.value.split('\n');
    assert.equal(lines.length, 6, '5 variations + 1 "more" line');
    assert.ok(lines[0].includes('A'));
    assert.ok(lines[0].includes('無料'));
    assert.ok(lines[1].includes('¥1,500'));
    assert.ok(lines[2].includes('¥2,000'));
    assert.ok(lines[3].includes('売り切れ'));
    assert.ok(lines[5].includes('ほか 2'));
});

test('booth extract: GUI output setting can hide variations field', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true,
        json: async () => createInfo(1, {
            variations: [
                { id: 1, name: 'A', price: 0 },
            ],
        }),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const result = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['variations'],
    });

    const fields = result[0].embeds[0].fields || [];
    assert.equal(fields.some(f => f.name === 'Variations' || f.name === 'バリエーション'), false);
    assert.ok(fields.some(f => f.value === '1,000 JPY'));
});

test('booth extract: sale status and variation price range can be hidden', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true,
        json: async () => createInfo(1, {
            sale_starts_at: future.toISOString(),
            variations: [
                { id: 1, name: 'A', price: 0 },
                { id: 2, name: 'B', price: 1500 },
                { id: 3, name: 'C', price: '¥3,000' },
            ],
        }),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const visible = await provider.extract(createMessage(url), url, { defaultLanguage: 'en' });
    assert.equal(fieldValue(visible[0].embeds[0], 'Status'), 'Upcoming');
    assert.equal(fieldValue(visible[0].embeds[0], 'Price range'), 'Free - ¥3,000');

    const hidden = await provider.extract(createMessage(url), url, {
        defaultLanguage: 'en',
        hidden_output_items: ['status', 'price_range'],
    });
    assert.equal(fieldValue(hidden[0].embeds[0], 'Status'), undefined);
    assert.equal(fieldValue(hidden[0].embeds[0], 'Price range'), undefined);
});

test('booth extract: sale status distinguishes live ended and sold out items', async () => {
    const now = Date.now();
    const cases = [
        {
            overrides: {
                sale_starts_at: new Date(now - 60 * 60 * 1000).toISOString(),
                sale_ends_at: new Date(now + 60 * 60 * 1000).toISOString(),
            },
            expected: 'Live',
        },
        {
            overrides: {
                sale_starts_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
                sale_ends_at: new Date(now - 60 * 60 * 1000).toISOString(),
            },
            expected: 'Ended',
        },
        {
            overrides: {
                is_sold_out: true,
                sale_starts_at: new Date(now - 60 * 60 * 1000).toISOString(),
                sale_ends_at: new Date(now + 60 * 60 * 1000).toISOString(),
            },
            expected: 'Sold out',
        },
    ];

    for (const { overrides, expected } of cases) {
        const provider = loadBoothProviderWithFetch(async () => ({
            ok: true,
            json: async () => createInfo(1, overrides),
        }));
        const url = 'https://shop.booth.pm/items/1';
        const result = await provider.extract(createMessage(url), url, { defaultLanguage: 'en' });
        assert.equal(fieldValue(result[0].embeds[0], 'Status'), expected);
    }
});

test('booth extract: handles unnamed variation and missing price', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true,
        json: async () => createInfo(1, {
            variations: [
                { id: 1, name: null, price: 0 },
                { id: 2, name: 'X', price: null },
            ],
        }),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const result = await provider.extract(createMessage(url), url, { defaultLanguage: 'en' });
    const variationField = result[0].embeds[0].fields.find(f => f.name === 'Variations');
    assert.ok(variationField);
    assert.ok(variationField.value.includes('(unnamed)'));
    assert.ok(variationField.value.includes('Free'));
});

test('booth extract: omits variations field when none returned', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true, json: async () => createInfo(1, { variations: [] }),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const result = await provider.extract(createMessage(url), url, {});
    const has = (result[0].embeds[0].fields || []).some(f => f.name === 'Variations' || f.name === 'バリエーション');
    assert.equal(has, false);
});

test('booth extract: shows sale period field with discord timestamp markdown when sale_starts_at present', async () => {
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true,
        json: async () => createInfo(1, {
            sale_starts_at: future.toISOString(),
            sale_ends_at: new Date(future.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        }),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const result = await provider.extract(createMessage(url), url, { defaultLanguage: 'en' });
    const periodField = result[0].embeds[0].fields.find(f => f.name === 'Sale period');
    assert.ok(periodField, 'Sale period field should exist');
    assert.match(periodField.value, /<t:\d+:F>/);
    assert.match(periodField.value, /<t:\d+:R>/);
});

test('booth extract: adds notify-on-sale button when start time is in the future', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true,
        json: async () => createInfo(0, { sale_starts_at: future.toISOString() }),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const result = await provider.extract(createMessage(url), url, { defaultLanguage: 'en' });
    const allButtons = result[0].components.flatMap(row => row.components || []);
    const notifyBtn = allButtons.find(b => typeof b.data?.custom_id === 'string' && b.data.custom_id.startsWith('notifyBoothSale:'));
    assert.ok(notifyBtn, 'notifyBoothSale button should be present');
    const parts = notifyBtn.data.custom_id.split(':');
    assert.equal(parts[0], 'notifyBoothSale');
    assert.equal(parts[1], '1');
    assert.equal(parts[2], 'en');
    assert.equal(Number(parts[3]), Math.floor(future.getTime() / 1000));
});

test('booth extract: omits notify button when start time is in the past', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true,
        json: async () => createInfo(0, { sale_starts_at: past.toISOString() }),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const result = await provider.extract(createMessage(url), url, { defaultLanguage: 'en' });
    const allButtons = result[0].components.flatMap(row => row.components || []);
    const notifyBtn = allButtons.find(b => typeof b.data?.custom_id === 'string' && b.data.custom_id.startsWith('notifyBoothSale:'));
    assert.equal(notifyBtn, undefined);
});

test('booth extract: omits sale period field and notify button when no period info', async () => {
    const provider = loadBoothProviderWithFetch(async () => ({
        ok: true, json: async () => createInfo(1),
    }));

    const url = 'https://shop.booth.pm/items/1';
    const result = await provider.extract(createMessage(url), url, { defaultLanguage: 'en' });
    const periodField = (result[0].embeds[0].fields || []).find(f => f.name === 'Sale period' || f.name === '販売期間');
    assert.equal(periodField, undefined);
    const allButtons = result[0].components.flatMap(row => row.components || []);
    const notifyBtn = allButtons.find(b => typeof b.data?.custom_id === 'string' && b.data.custom_id.startsWith('notifyBoothSale:'));
    assert.equal(notifyBtn, undefined);
});

test('booth notify handler: parses customId correctly', () => {
    const { _internal } = require('../../src/components/notifyBoothSale');
    const parsed = _internal.parseCustomId('notifyBoothSale:42:ja:1700000000');
    assert.equal(parsed.itemId, '42');
    assert.equal(parsed.lang, 'ja');
    assert.equal(parsed.notifyAt.getTime(), 1700000000 * 1000);
    assert.equal(_internal.parseCustomId('notifyBoothSale:42'), null);
    assert.equal(_internal.parseCustomId('other:42:ja:1'), null);
});

test('booth _sale: extractSalePeriod picks variation-level period when top-level missing', () => {
    const { extractSalePeriod } = require('../../src/providers/booth/_sale');
    const out = extractSalePeriod({
        variations: [
            { id: 1, sales_started_at: '2030-01-01T00:00:00Z', sales_ended_at: '2030-01-02T00:00:00Z' },
        ],
    });
    assert.ok(out);
    assert.equal(out.startAt.toISOString(), '2030-01-01T00:00:00.000Z');
    assert.equal(out.endAt.toISOString(),   '2030-01-02T00:00:00.000Z');
    assert.equal(extractSalePeriod({}), null);
});


