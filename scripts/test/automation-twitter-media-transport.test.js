'use strict';

// Exercise the real Twitter extractor and transport preparation with a closed
// network fixture. No Discord, X, DNS or database service is contacted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');

function isolated(filename, mocks) {
    const actualRequire = createRequire(filename), mod = { exports: {} };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports', 'console'], { filename: `${filename}.fixture.cjs` })(
        id => Object.hasOwn(mocks, id) ? mocks[id] : actualRequire(id), mod, mod.exports,
        { log() {}, warn() {}, error() {} });
    return mod.exports;
}

const OWNER = '222222222222222222', CHANNEL = '333333333333333333';
const GUILD = '444444444444444444', WEBHOOK = '555555555555555555';
const POST_URL = 'https://x.com/fixture/status/1234567890123456789';
const images = Array.from({ length: 20 }, (_, i) => `https://pbs.twimg.com/media/photo-${i + 1}.jpg`);

async function prepare(destinationKind, legacyMode, options = {}) {
    const seenImages = [], posts = [], rateEvents = [];
    const fakeFetch = async value => {
        const url = new URL(String(value));
        if (url.hostname === 'pbs.twimg.com') {
            seenImages.push(url.href);
            const index = Number(url.pathname.match(/photo-(\d+)/)?.[1]) - 1;
            return { ok: true, status: 200, buffer: async () => options.sizes
                ? Buffer.alloc(options.sizes[index], index + 1) : Buffer.from(`fixture-${url.pathname.split('/').pop()}`) };
        }
        if (url.hostname === 'altterx.sprink.cloud') return { text: async () => 'ok' };
        assert.equal(url.hostname, 'api.vxtwitter.com', 'unexpected network destination');
        return { text: async () => JSON.stringify({ tweetURL: POST_URL, text: 'fixture post', user_name: 'fixture',
            user_screen_name: 'fixture', date: '2026-01-01T00:00:00Z', mediaURLs: options.imageUrls || images }) };
    };
    const provider = isolated(require.resolve('../../src/providers/twitter'), {
        '../../providerFetch': { withDeadline: () => fakeFetch },
        '../../adminSupport/providerSources': { resolvePlan: async () => ({ sources: [{ origin: 'https://api.vxtwitter.com' }] }) },
    });
    const { createTransport } = isolated(require.resolve('../../src/automation/transport'), {
        'node:dns': { promises: { lookup: async () => [{ address: '8.8.8.8', family: 4 }] } },
        'node:https': { Agent: class { destroy() {} } },
        '../providerFetch': { withDeadline: () => fakeFetch },
        '../providers/_loader': { loadProviders: () => options.provider ? [options.provider] : [{ ...provider, id: options.providerId || 'twitter', ...(options.steps ? { extract: async () => options.steps } : {}) }] },
        '../providers/_provider_settings': {
            PROVIDER_DEFAULTS: { legacy_mode: undefined },
            getProviderSettings: async () => ({ enabled: true, legacy_mode: legacyMode, twitter_grid_details_position: options.detailsPosition, ...options.providerSettings }),
        },
    });
    const db = options.db || { queryDatabase: async () => [{ webhook_url: `https://discord.com/api/webhooks/${WEBHOOK}/${'a'.repeat(60)}` }] };
    const rest = {
        post: async (route, payload) => {
            if (route === '/users/@me/channels') return { id: CHANNEL, recipients: [{ id: OWNER, username: 'fixture' }] };
            posts.push({ route, payload });
            if (options.failPost === posts.length) throw Object.assign(new Error('synthetic failure'), options.failStatus ? { status: options.failStatus } : { code: 'ETIMEDOUT' });
            return { id: String(666666666666666660n + BigInt(posts.length)), channel_id: CHANNEL };
        },
        get: async () => ({ id: WEBHOOK, channel_id: CHANNEL, guild_id: GUILD, type: 1 }),
    };
    const destinations = { verifyChannel: async () => ({ member: { user: { username: 'fixture' }, roles: [] }, channel: { nsfw: false } }) };
    const rateLimiter = options.rateLimiter || {
        reserveNotifications: async (_principal, count) => { rateEvents.push(['reserve', count]); if (options.failReserve) throw Error('synthetic DB failure'); return { count, expiresAtMs: Number.MAX_SAFE_INTEGER }; },
        beginNotification: async (_reservation, index) => { rateEvents.push(['begin', index]); },
        commitNotification: async (_reservation, index) => { rateEvents.push(['commit', index]); },
        releaseNotifications: async (_reservation, index) => { rateEvents.push(['release', index]); },
        retainUnknownNotification: async (_reservation, index) => { rateEvents.push(['unknown', index]); },
    };
    let entitlementCalls = 0;
    const transport = createTransport(db, destinations, { options: { jsonTransformer: value => value } }, {
        rest, rateLimiter, safety: { assertNotification: async () => {} }, skipProviderBudget: true,
        entitlementResolver: async () => { if (options.failEntitlementAfter && ++entitlementCalls > options.failEntitlementAfter) throw Error('synthetic DB failure'); return { slotId: `${OWNER}:1`, slotIndex: 1, minuteLimit: 5, dayLimit: 24 }; },
        membershipResolver: async (_db, job) => [{ targetKind: job.target_kind, targetId: String(job.target_id) }],
    });
    const job = { id: 'fixture', owner_user_id: OWNER, target_kind: options.targetKind || 'x', target_id: '1', plan: {
        context: { locale: 'ja' }, event: { providerId: options.providerId || 'twitter', url: options.eventUrl || POST_URL }, schedules: [],
        display: { format: 'expanded', media: options.media || 'inherit' }, text: options.text ?? 'notification fixture',
    } };
    const destination = destinationKind === 'dm' ? { kind: 'dm', dm_user_id: OWNER }
        : { kind: 'webhook', guild_id: GUILD, webhook_endpoint_id: '1' };
    return { prepared: await transport.prepare(job, destination), seenImages, transport, job, destination, db, posts, rateEvents };
}

test('expanded X automatic notifications prepare all 20 images in order for DM and webhook contexts', async () => {
    for (const [kind, mode] of [['dm', undefined], ['webhook', undefined], ['webhook', true]]) {
        const { prepared, seenImages } = await prepare(kind, mode);
        assert.equal(prepared.payloads.length, 2, `${kind}: message count`);
        assert.deepEqual(prepared.payloads.map(part => part.files.length), [10, 10]);
        assert.deepEqual(seenImages, images);
        assert.deepEqual(prepared.payloads.flatMap(part => part.files.map(file => file.data.toString())),
            images.map(url => `fixture-${new URL(url).pathname.split('/').pop()}`));
        assert.match(prepared.payloads[0].body.content, /notification fixture/);
        assert.ok(!prepared.payloads[1].body.content);
        assert.ok(!prepared.payloads[0].body.embeds?.length);
        assert.equal(prepared.payloads[1].body.embeds.length, 1);
    }
});

test('link display preserves all long media links and reserves every resulting message', async () => {
    const links = Array.from({ length: 20 }, (_, index) => `https://pbs.twimg.com/media/photo-${index + 1}.jpg?fixture=${'x'.repeat(210)}`);
    const steps = [{ files: links.slice(0, 10) }, { files: links.slice(10), embeds: [{ title: 'post details' }], twitterGridLastRoot: { groupId: 'a'.repeat(32) } }];
    for (const kind of ['dm', 'webhook']) {
        const { prepared, transport, job, rateEvents, posts } = await prepare(kind, undefined, { steps, media: 'links' });
        const messages = prepared.payloads.map(part => part.body.content || '');
        assert(prepared.payloads.length > 2);
        assert(messages.every(content => content.length <= 1900));
        assert.deepEqual(messages.flatMap(content => content.split('\n')).filter(line => line.startsWith('https://')), links);
        assert.equal(prepared.payloads.at(-1).body.embeds[0].title, 'post details');
        assert(prepared.payloads.slice(0, -1).every(part => !part.body.embeds?.length));
        await transport.reserve(prepared, job);
        assert.deepEqual(rateEvents, [['reserve', prepared.payloads.length]]);
        for (let index = 0; index < prepared.payloads.length; index++) await transport.sendStep(prepared, job, index);
        assert.equal(posts.length, prepared.payloads.length);
        assert.deepEqual(posts.flatMap(post => String(post.payload.body.content || '').split('\n')).filter(line => line.startsWith('https://')), links);
        assert.equal(rateEvents.filter(event => event[0] === 'commit').length, prepared.payloads.length);
    }
});

test('real X extraction with twenty long image URLs keeps every link in order', async () => {
    const links = Array.from({ length: 20 }, (_, index) => `https://pbs.twimg.com/media/${'x'.repeat(210)}-${index + 1}.jpg`);
    const { prepared } = await prepare('webhook', undefined, { media: 'links', imageUrls: links });
    const contents = prepared.payloads.map(part => part.body.content || '');
    assert(prepared.payloads.length > 2);
    assert.deepEqual(contents.flatMap(content => content.split('\n')).filter(line => line.startsWith('https://')), links);
    assert(prepared.payloads.at(-1).body.embeds?.length > 0);
});

test('link splitting also preserves non-X provider media', async () => {
    const links = Array.from({ length: 12 }, (_, index) => `https://media.example.test/photo-${index + 1}?fixture=${'x'.repeat(210)}`);
    const { prepared } = await prepare('webhook', undefined, { providerId: 'other', media: 'links', steps: [{ files: links }] });
    assert(prepared.payloads.length > 1);
    assert.deepEqual(prepared.payloads.flatMap(part => String(part.body.content || '').split('\n')).filter(line => line.startsWith('https://')), links);
});

test('URL-less generated GitHub images are attached while text and ordinary media links remain', async () => {
    const visual = require('../../src/providers/github/visuals').buildVisualAttachment({ login: 'fixture', contributions: {
        fromDate: '2026-01-01', toDate: '2026-01-07', cells: [{ date: '2026-01-01', level: 1 }],
    } }, { type: 'user', login: 'fixture' }, {});
    assert(Buffer.isBuffer(visual?.attachment?.attachment));
    const source = visual.attachment, link = 'https://example.test/photo.png';
    const steps = [{ content: 'provider text', embeds: [{ title: 'GitHub', url: 'https://github.com/fixture', image: { url: `attachment://${source.name}` },
        thumbnail: { url: 'https://example.test/thumbnail.png' } }],
        files: [source, link] }];
    for (const kind of ['dm', 'webhook']) {
        const { prepared, transport, job, posts, rateEvents } = await prepare(kind, undefined, { providerId: 'github', media: 'links', steps });
        assert.equal(prepared.payloads.length, 1);
        assert.match(prepared.payloads[0].body.content, /notification fixture\nprovider text/);
        assert.match(prepared.payloads[0].body.content, /https:\/\/example\.test\/photo\.png/);
        assert.match(prepared.payloads[0].body.content, /https:\/\/example\.test\/thumbnail\.png/);
        assert.equal(prepared.payloads[0].body.embeds[0].title, 'GitHub');
        assert.equal(prepared.payloads[0].body.embeds[0].image, undefined);
        assert.equal(prepared.payloads[0].files.length, 1);
        assert.equal(prepared.payloads[0].files[0].name, source.name);
        assert.deepEqual(prepared.payloads[0].files[0].data, source.attachment);
        const safety = require('../../src/automation/safety').createSafety({ matcher: { matchNotification: async () => [] } });
        await safety.assertNotification(prepared, job);
        job.plan.event.sensitive = true;
        await assert.rejects(safety.assertNotification(prepared, job), { code: 'SAFETY_SENSITIVE_DESTINATION' });
        delete job.plan.event.sensitive;
        await transport.reserve(prepared, job); await transport.sendStep(prepared, job, 0);
        assert.equal(posts.length, 1); assert.deepEqual(posts[0].payload.files[0].data, source.attachment);
        assert(rateEvents.some(event => event[0] === 'commit' && event[1] === 0));
    }
});

test('real GitHub profile extraction produces an attached contribution graph in link mode', async () => {
    const profile = 'https://github.com/fixture', github = isolated(require.resolve('../../src/providers/github'), {
        './client': { createGitHubClient: () => ({ fetchGitHubData: async () => ({ login: 'fixture', name: 'Fixture', html_url: profile,
            contributions: { fromDate: '2026-01-01', toDate: '2026-01-07', cells: [{ date: '2026-01-01', level: 1 }], total: 1 } }) }) },
    });
    for (const kind of ['dm', 'webhook']) {
        const { prepared, transport, job, posts } = await prepare(kind, undefined,
            { provider: github, providerId: 'github', targetKind: 'auto', eventUrl: profile, media: 'links' });
        assert.equal(prepared.payloads.length, 1);
        assert.equal(prepared.payloads[0].files.length, 1);
        assert.equal(prepared.payloads[0].files[0].name, 'github-contributions-fixture.png');
        assert.match(prepared.payloads[0].body.content, /notification fixture/);
        assert.equal(prepared.payloads[0].body.embeds[0].url, profile);
        await transport.reserve(prepared, job); await transport.sendStep(prepared, job, 0);
        assert.equal(posts.length, 1); assert.equal(posts[0].payload.files[0].name, 'github-contributions-fixture.png');
    }
    const hidden = await prepare('webhook', undefined,
        { provider: github, providerId: 'github', targetKind: 'auto', eventUrl: profile, media: 'hide' });
    assert.equal(hidden.prepared.payloads[0].files.length, 0);
    assert.equal(hidden.prepared.payloads[0].body.embeds[0].image, undefined);
    const serverLinkOnly = await prepare('webhook', undefined,
        { provider: github, providerId: 'github', targetKind: 'auto', eventUrl: profile, media: 'links', providerSettings: { media_display_mode: 'link_only' } });
    assert.equal(serverLinkOnly.prepared.payloads[0].files[0].name, 'github-contributions-fixture.png');
});

test('link mode splits URL-less images without duplicating text, links or metadata', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const files = Array.from({ length: 12 }, (_, index) => ({ name: `generated-${index}.png`, attachment: png }));
    const links = Array.from({ length: 10 }, (_, index) => `https://example.test/${index}?fixture=${'x'.repeat(210)}`);
    const { prepared, transport, job, rateEvents } = await prepare('webhook', undefined, { providerId: 'twitter', media: 'links',
        steps: [{ content: 'provider body', files: [...files, ...links], embeds: [{ title: 'details' }], twitterGridLastRoot: { groupId: 'a'.repeat(32) } }] });
    assert.deepEqual(prepared.payloads.map(part => part.files.length).filter(Boolean), [10, 2]);
    assert.equal(prepared.payloads.reduce((n, part) => n + (part.files || []).length, 0), 12);
    const contents = prepared.payloads.map(part => part.body.content || '');
    assert.equal(contents.filter(content => content.includes('provider body')).length, 1);
    assert.deepEqual(contents.flatMap(content => content.split('\n')).filter(line => line.startsWith('https://')), links);
    assert.equal(prepared.payloads.at(-1).body.embeds[0].title, 'details');
    await transport.reserve(prepared, job);
    assert.deepEqual(rateEvents, [['reserve', prepared.payloads.length]]);
});

test('an uncertain generated-image continuation is not retried or followed by later parts', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const files = Array.from({ length: 22 }, (_, index) => ({ name: `generated-${index}.png`, attachment: png }));
    const { prepared, transport, job, posts, rateEvents } = await prepare('webhook', undefined,
        { providerId: 'github', media: 'links', steps: [{ files }], failPost: 2 });
    assert.deepEqual(prepared.payloads.map(part => part.files.length), [10, 10, 2]);
    await transport.reserve(prepared, job); await transport.sendStep(prepared, job, 0);
    await assert.rejects(transport.sendStep(prepared, job, 1), { code: 'ETIMEDOUT' });
    assert(rateEvents.some(event => event[0] === 'unknown' && event[1] === 1));
    await assert.rejects(transport.sendStep(prepared, job, 1), { name: 'SafetyError' });
    await assert.rejects(transport.sendStep(prepared, job, 2), { name: 'SafetyError' });
    assert.equal(posts.length, 2);
});

test('missing generated image data or non-image bytes cannot silently disappear in link mode', async () => {
    for (const step of [
        { embeds: [{ image: { url: 'attachment://missing.png' } }] },
        { files: [{ name: 'file.png', attachment: Buffer.from('not an image') }] },
        { files: [{ name: 'file.exe', attachment: Buffer.from('89504e470d0a1a0a', 'hex') }] },
        { files: [{ name: 'file.png', attachment: '/private/local.png' }] },
        { embeds: [{ video: { url: 'attachment://video.png' } }], files: [{ name: 'video.png', attachment: Buffer.from('89504e470d0a1a0a', 'hex') }] },
    ]) await assert.rejects(prepare('webhook', undefined, { providerId: 'github', media: 'links', steps: [step] }),
        { code: 'SAFETY_INVALID_ATTACHMENT', decision: 'error' });
});

test('an oversized generated image is rejected before any message can be sent', async () => {
    const bytes = new Uint8Array(24 * 1024 * 1024 + 1);
    bytes.set(Buffer.from('89504e470d0a1a0a', 'hex'));
    await assert.rejects(prepare('webhook', undefined, { providerId: 'github', media: 'links', steps: [{ files: [bytes] }] }),
        { code: 'ATTACHMENT_LIMIT' });
});

test('malformed remaining embed metadata is still rejected by the real safety check', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const steps = [{ embeds: [{ title: 42, image: { url: 'attachment://generated.png' } }],
        files: [{ name: 'generated.png', attachment: png }] }];
    const { prepared, job } = await prepare('webhook', undefined, { providerId: 'github', media: 'links', steps });
    const safety = require('../../src/automation/safety').createSafety({ matcher: { matchNotification: async () => [] } });
    await assert.rejects(safety.assertNotification(prepared, job), { code: 'SAFETY_INVALID_PAYLOAD' });
});

test('an image-only Embed retains its source link when the generated image becomes an attachment', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex'), sourceUrl = 'https://github.com/fixture';
    const steps = [{ embeds: [{ url: sourceUrl, image: { url: 'attachment://generated.png' } }],
        files: [{ name: 'generated.png', attachment: png }] }];
    const { prepared, job } = await prepare('webhook', undefined, { providerId: 'github', media: 'links', steps });
    assert.match(prepared.payloads[0].body.content, /https:\/\/github\.com\/fixture/);
    assert.equal(prepared.payloads[0].body.embeds?.length || 0, 0); assert.equal(prepared.payloads[0].files.length, 1);
    await require('../../src/automation/safety').createSafety({ matcher: { matchNotification: async () => [] } }).assertNotification(prepared, job);
});

test('explicit hide still removes generated images and inherit keeps the existing attachment', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const steps = [{ content: 'visible text', embeds: [{ title: 'GitHub', image: { url: 'attachment://generated.png' } }],
        files: [{ name: 'generated.png', attachment: png }] }];
    const hidden = await prepare('webhook', undefined, { providerId: 'github', media: 'hide', steps });
    assert.equal(hidden.prepared.payloads[0].files.length, 0); assert.equal(hidden.prepared.payloads[0].body.embeds[0].image, undefined);
    const inherited = await prepare('webhook', undefined, { providerId: 'github', media: 'inherit', steps });
    assert.equal(inherited.prepared.payloads[0].files.length, 1); assert.equal(inherited.prepared.payloads[0].body.embeds[0].image.url, 'attachment://generated.png');
});

test('URL-less non-image files retain the existing link-mode behavior', async () => {
    const video = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex');
    const steps = [{ content: 'clip notification', embeds: [{ title: 'Twitch clip', url: 'https://clips.twitch.tv/Fixture' }],
        files: [{ name: 'twitch-fixture.mp4', attachment: video }] }];
    const { prepared, transport, job, posts } = await prepare('webhook', undefined, { providerId: 'twitch', media: 'links', steps });
    assert.equal(prepared.payloads[0].files.length, 0);
    assert.match(prepared.payloads[0].body.content, /clip notification/);
    assert.equal(prepared.payloads[0].body.embeds[0].url, 'https://clips.twitch.tv/Fixture');
    await transport.reserve(prepared, job); await transport.sendStep(prepared, job, 0); assert.equal(posts.length, 1);
});

test('an existing public image URL is preferred over attaching its buffered copy', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex'), publicUrl = 'https://example.test/image.png';
    const steps = [{ embeds: [{ title: 'image', image: { url: 'attachment://copy.png' } }],
        files: [{ name: 'copy.png', attachment: png, fallbackUrl: publicUrl }] }];
    const { prepared } = await prepare('webhook', undefined, { providerId: 'github', media: 'links', steps });
    assert.equal(prepared.payloads[0].files.length, 0);
    assert.match(prepared.payloads[0].body.content, /https:\/\/example\.test\/image\.png/);
});

test('a raw generated image receives a usable image filename', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const { prepared } = await prepare('webhook', undefined, { providerId: 'github', media: 'links', steps: [{ files: [png] }] });
    assert.equal(prepared.payloads[0].files[0].name, 'generated-0.png');
    assert.deepEqual(prepared.payloads[0].files[0].data, png);
    const typed = await prepare('webhook', undefined, { providerId: 'github', media: 'links', steps: [{ files: [new Uint8Array(png)] }] });
    assert.equal(typed.prepared.payloads[0].files[0].name, 'generated-0.png');
    assert.deepEqual(typed.prepared.payloads[0].files[0].data, png);
    const extensionless = await prepare('webhook', undefined, { providerId: 'github', media: 'links', steps: [{
        embeds: [{ image: { url: 'attachment://graph' } }], files: [{ name: 'graph', attachment: png }],
    }] });
    assert.equal(extensionless.prepared.payloads[0].files[0].name, 'graph.png');
    const mismatchedImage = await prepare('webhook', undefined, { providerId: 'github', media: 'links', steps: [{ files: [{ name: 'graph.jpg', attachment: png }] }] });
    assert.equal(mismatchedImage.prepared.payloads[0].files[0].name, 'graph.png');
    const longName = await prepare('webhook', undefined, { providerId: 'github', media: 'links', steps: [{ files: [{ name: `${'x'.repeat(140)}.png`, attachment: png }] }] });
    assert.equal(longName.prepared.payloads[0].files[0].name.length, 120);
    assert.match(longName.prepared.payloads[0].files[0].name, /\.png$/);
});

test('a generated spoiler image stays covered when link mode falls back to an attachment', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const steps = [{ embeds: [{ fields: [], image: { url: 'attachment://generated.png' } }],
        files: [{ name: 'generated.png', attachment: png, spoiler: true }] }];
    const { prepared, job } = await prepare('webhook', undefined, { providerId: 'github', media: 'links', steps });
    assert.equal(prepared.payloads[0].files[0].name, 'SPOILER_generated.png');
    const safety = require('../../src/automation/safety').createSafety({ matcher: { matchNotification: async () => [] } });
    await safety.assertNotification(prepared, job);
    job.plan.event.sensitive = true;
    await assert.rejects(safety.assertNotification(prepared, job), { code: 'SAFETY_SENSITIVE_DESTINATION' });
    const lowercase = await prepare('webhook', undefined, { providerId: 'github', media: 'links', steps: [{
        files: [{ name: 'spoiler_generated.png', attachment: png, spoiler: true }],
    }] });
    assert.equal(lowercase.prepared.payloads[0].files[0].name, 'SPOILER_spoiler_generated.png');
});

test('a media link longer than Discord can carry fails before any message is sent', async () => {
    const prefix = 'https://example.test/';
    const longest = prefix + 'a'.repeat(2000 - prefix.length);
    const { prepared } = await prepare('webhook', undefined, { steps: [{ files: [longest] }], media: 'links' });
    assert(prepared.payloads.some(part => part.body.content === longest));
    const steps = [{ files: [`${longest}x`] }];
    await assert.rejects(prepare('webhook', undefined, { steps, media: 'links' }), { code: 'SAFETY_INPUT_LIMIT', decision: 'error' });
});

test('link continuations remain unsent when the full message reservation fails', async () => {
    const files = Array.from({ length: 12 }, (_, index) => `https://example.test/${index}?fixture=${'x'.repeat(210)}`);
    const { prepared, transport, job, posts } = await prepare('webhook', undefined,
        { steps: [{ files }], media: 'links', failReserve: true });
    assert(prepared.payloads.length > 1);
    await assert.rejects(transport.reserve(prepared, job), /synthetic DB failure/);
    assert.equal(posts.length, 0);
});

test('an uncertain link continuation is not retried and later parts stay unsent', async () => {
    const files = Array.from({ length: 20 }, (_, index) => `https://example.test/${index}?fixture=${'x'.repeat(210)}`);
    const { prepared, transport, job, posts, rateEvents } = await prepare('webhook', undefined,
        { steps: [{ files }], media: 'links', failPost: 2 });
    assert(prepared.payloads.length > 2);
    await transport.reserve(prepared, job); await transport.sendStep(prepared, job, 0);
    await assert.rejects(transport.sendStep(prepared, job, 1), { code: 'ETIMEDOUT' });
    assert(rateEvents.some(event => event[0] === 'unknown' && event[1] === 1));
    await assert.rejects(transport.sendStep(prepared, job, 1), { name: 'SafetyError' });
    await assert.rejects(transport.sendStep(prepared, job, 2), { name: 'SafetyError' });
    assert.equal(posts.length, 2);
});

test('a long configured notification does not truncate provider-supplied text', async () => {
    const text = 'configured '.repeat(172), providerText = 'provider continuation';
    for (const providerId of ['twitter', 'other']) {
        const { prepared, transport, job, posts, rateEvents } = await prepare('webhook', undefined,
            { providerId, steps: [{ content: providerText, embeds: [{ title: 'provider detail' }] }], media: 'inherit', text });
        assert.deepEqual(prepared.payloads.map(part => part.body.content), [text, providerText]);
        assert.equal(prepared.payloads[1].body.embeds[0].title, 'provider detail');
        await transport.reserve(prepared, job);
        for (let index = 0; index < prepared.payloads.length; index++) await transport.sendStep(prepared, job, index);
        assert.deepEqual(posts.map(post => post.payload.body.content), [text, providerText]);
        assert.equal(rateEvents.filter(event => event[0] === 'commit').length, 2);
    }
});

test('long configured text and long media links are both preserved in link mode', async () => {
    const text = 'configured '.repeat(172), providerText = 'provider continuation';
    const links = Array.from({ length: 10 }, (_, index) => `https://media.example.test/${index}?fixture=${'x'.repeat(210)}`);
    const { prepared } = await prepare('webhook', undefined,
        { steps: [{ content: providerText, embeds: [{ title: 'details' }], files: links }], media: 'links', text });
    const contents = prepared.payloads.map(part => part.body.content || '');
    assert.equal(contents[0], text); assert.match(contents[1], /^provider continuation/);
    assert.deepEqual(contents.flatMap(content => content.split('\n')).filter(line => line.startsWith('https://')), links);
    assert.equal(prepared.payloads.flatMap(part => part.body.embeds || []).filter(embed => embed.title === 'details').length, 1);
});

test('hiding media does not truncate a later provider message', async () => {
    const text = '後続本文'.repeat(600);
    const { prepared } = await prepare('webhook', undefined, { media: 'hide', steps: [
        { content: 'first' }, { content: text, embeds: [{ title: 'details', image: { url: 'https://example.test/image.png' } }] },
    ] });
    const contents = prepared.payloads.map(part => part.body.content || '');
    assert.equal(contents.slice(1).join(''), text);
    assert(prepared.payloads.every(part => part.body.content?.length <= 1900));
    assert.equal(prepared.payloads.flatMap(part => part.body.embeds || []).some(embed => embed.image), false);
});

test('large expanded X images split by request bytes in order for DM and webhook without duplicating post details', async () => {
    const sizes = Array(20).fill(3 * 1024 * 1024);
    for (const kind of ['dm', 'webhook']) {
        const { prepared, seenImages, transport, job, rateEvents } = await prepare(kind, undefined, { sizes });
        assert.deepEqual(prepared.payloads.map(part => part.files.length), [8, 2, 8, 2]);
        assert.deepEqual(seenImages, images);
        assert.deepEqual(prepared.payloads.flatMap(part => part.files.map(file => file.data[0])), Array.from({ length: 20 }, (_, i) => i + 1));
        assert(prepared.payloads.every(part => part.files.reduce((n, file) => n + file.data.length, 0) <= 24 * 1024 * 1024));
        assert(prepared.payloads.every(part => part.files.reduce((n, file) => n + file.data.length, 0) + Buffer.byteLength(JSON.stringify(part.body)) + 64 * 1024 <= 25 * 1024 * 1024));
        assert.match(prepared.payloads[0].body.content, /notification fixture/);
        assert.equal(prepared.payloads.at(-1).body.embeds.length, 1);
        assert(prepared.payloads.slice(0, -1).every(part => !part.body.embeds?.length && !part.body.components?.length));
        assert(prepared.payloads.slice(1).every(part => !part.body.content));
        await transport.reserve(prepared, job);
        assert.deepEqual(rateEvents, [['reserve', 4]], 'reserve actual Discord message count before sending');
    }
});

test('explicit first-details setting survives byte-based splits', async () => {
    const { prepared } = await prepare('webhook', undefined, { detailsPosition: 'first', sizes: Array(20).fill(3 * 1024 * 1024) });
    assert.deepEqual(prepared.payloads.map(part => part.files.length), [8, 2, 8, 2]);
    assert.equal(prepared.payloads[0].body.embeds.length, 1);
    assert(prepared.payloads.slice(1).every(part => !part.body.embeds?.length));
});

test('single images too large for the safe multipart budget and non-X totals fail before posting', async () => {
    await assert.rejects(prepare('dm', undefined, { sizes: [24 * 1024 * 1024 + 1, ...Array(19).fill(1)] }), { code: 'ATTACHMENT_LIMIT' });
    // This new X-specific splitting must not change unrelated providers.
    await assert.rejects(prepare('dm', undefined, { providerId: 'other', sizes: Array(20).fill(3 * 1024 * 1024) }), { code: 'ATTACHMENT_LIMIT' });
});

test('size continuations preserve inline quote embeds on the first message only', async () => {
    const parts = [{ content: '元投稿', embeds: [{ title: '投稿', description: '本文' }, { title: '引用', description: '引用本文' }],
        files: Array.from({ length: 10 }, (_, i) => ({ attachment: Buffer.alloc(3 * 1024 * 1024, i + 1), name: `photo-${i}.jpg` })) }];
    const { prepared } = await prepare('dm', undefined, { steps: parts });
    assert.deepEqual(prepared.payloads.map(part => part.files.length), [8, 2]);
    assert.deepEqual(prepared.payloads[0].body.embeds.map(embed => embed.title), ['投稿', '引用']);
    assert.match(prepared.payloads[0].body.content, /元投稿/);
    assert.equal(prepared.payloads[1].body.embeds?.length || 0, 0); assert(!prepared.payloads[1].body.content);
});

test('reservation/entitlement DB failures leave every split part unsent', async () => {
    for (const options of [{ failReserve: true }, { failEntitlementAfter: 1 }]) {
        const { prepared, transport, job, posts } = await prepare('dm', undefined, { ...options, sizes: Array(20).fill(3 * 1024 * 1024) });
        await assert.rejects(transport.reserve(prepared, job)); assert.equal(posts.length, 0);
    }
});

test('an unknown Discord result in the second split part cannot be resent or continue the batch', async () => {
    const { prepared, transport, job, posts, rateEvents } = await prepare('dm', undefined, { failPost: 2, sizes: Array(20).fill(3 * 1024 * 1024) });
    await transport.reserve(prepared, job);
    await transport.sendStep(prepared, job, 0);
    await assert.rejects(transport.sendStep(prepared, job, 1), { code: 'ETIMEDOUT' });
    assert(rateEvents.some(event => event[0] === 'commit' && event[1] === 0));
    assert(rateEvents.some(event => event[0] === 'unknown' && event[1] === 1));
    await assert.rejects(transport.sendStep(prepared, job, 1), { name: 'SafetyError' });
    await assert.rejects(transport.sendStep(prepared, job, 2), { name: 'SafetyError' });
    assert.equal(posts.length, 2);
});

test('runner stops size-split delivery at known or unknown Discord failures without replaying confirmed parts', async () => {
    const { createRunner } = require('../../src/automation/runtime');
    for (const [failure, expected] of [[{ failPost: 1, failStatus: 400 }, 'failed'], [{ failPost: 2, failStatus: 400 }, 'partial'], [{ failPost: 2 }, 'unknown']]) {
        const f = await prepare('dm', undefined, { ...failure, sizes: Array(20).fill(3 * 1024 * 1024) });
        const acks = [], transitions = [];
        const queue = {
            claim: async () => f.job, check: async () => ({ state: 'ready', destination: f.destination }),
            beginSend: async () => ({ state: 'sending', attempts: 1 }),
            acknowledgeStep: async (_job, id) => { acks.push(id); },
            transition: async (_job, state, code) => { transitions.push({ state, code }); return true; },
        };
        const db = { queryDatabase: async () => ({ affectedRows: 1 }), withDatabaseTransaction: async work => work(async sql =>
            sql.startsWith('SELECT expires') ? [{ expires_at_ms: 0 }] : { affectedRows: 1 }) };
        const runnerTransport = { prepare: async () => f.prepared, reserve: f.transport.reserve, sendStep: f.transport.sendStep, release: f.transport.release };
        const runner = createRunner(db, queue, runnerTransport, { clock: () => 2000, assertAllowed: () => {}, notificationAllowed: () => true });
        const result = await runner.tick();
        assert.equal(result.state, expected); assert.equal(f.posts.length, failure.failPost);
        assert.equal(acks.length, failure.failPost - 1); assert.equal(transitions.at(-1).state, expected);
    }
});

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
test('real SQL reserves every byte-split message, retains an unknown and releases only unsent parts', { skip: !port, timeout: 60000 }, async () => {
    assert([33621, 33622].includes(port), 'only an explicit isolated database port is permitted');
    const db = await require('../lib/automation-test-db').createTestDatabase(port);
    try {
        const limiter = require('../../src/automation/rate-limits').createRateLimiter(db);
        const { prepared, transport, job, posts } = await prepare('dm', undefined, { db, rateLimiter: limiter, failPost: 2, sizes: Array(20).fill(3 * 1024 * 1024) });
        await transport.reserve(prepared, job);
        let usage = await limiter.getSlotUsage(`${OWNER}:1`);
        assert.equal(usage.todayUsed, 0); assert.equal(usage.todayReserved, 4);
        await transport.sendStep(prepared, job, 0);
        await assert.rejects(transport.sendStep(prepared, job, 1), { code: 'ETIMEDOUT' });
        usage = await limiter.getSlotUsage(`${OWNER}:1`);
        assert.equal(usage.todayUsed, 1); assert.equal(usage.todayReserved, 1);
        const rows = await db.queryDatabase('SELECT parts_json FROM automation_rate_reservations WHERE owner_user_id=?', [OWNER]);
        assert.equal(rows.length, 1); assert.deepEqual(JSON.parse(rows[0].parts_json), ['committed', 'unknown', 'released', 'released']);
        await assert.rejects(transport.sendStep(prepared, job, 2), { name: 'SafetyError' });
        assert.equal(posts.length, 2);

        // An actual SQL transaction failure after reservation writes must roll
        // back every counter and must never admit any Discord post.
        await db.queryDatabase('DELETE FROM automation_rate_reservations');
        await db.queryDatabase('DELETE FROM automation_counters');
        let failTransaction = false, injected = 0;
        const failedDb = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(async query => {
            let wroteCounters = false;
            const wrapped = async (sql, params, options) => {
                if (/^INSERT INTO automation_counters/i.test(sql)) wroteCounters = true;
                return query(sql, params, options);
            };
            const result = await work(wrapped);
            if (failTransaction && wroteCounters) { injected++; throw Error('synthetic transaction failure after counter writes'); }
            return result;
        }) };
        const failedLimiter = require('../../src/automation/rate-limits').createRateLimiter(failedDb);
        const failed = await prepare('dm', undefined, { db: failedDb, rateLimiter: failedLimiter, sizes: Array(20).fill(3 * 1024 * 1024) });
        failTransaction = true;
        await assert.rejects(failed.transport.reserve(failed.prepared, failed.job));
        assert.equal(injected, 1);
        assert.equal(failed.posts.length, 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_counters'))[0].n), 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_rate_reservations'))[0].n), 0);

        // The existing plan limit applies to physical messages, including the
        // new continuations; exceeding it must not reserve or send a prefix.
        const tooMany = await prepare('dm', undefined, { db, rateLimiter: limiter, sizes: Array(20).fill(5 * 1024 * 1024) });
        assert.equal(tooMany.prepared.payloads.length, 6);
        await assert.rejects(tooMany.transport.reserve(tooMany.prepared, tooMany.job), { code: 'AUTOMATION_DELIVERY_SIZE_LIMIT' });
        assert.equal(tooMany.posts.length, 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_counters'))[0].n), 0);
    } finally { await db.close(); }
});

test('real SQL charges generated-image parts separately and retains unknown delivery', { skip: !port, timeout: 60000 }, async () => {
    assert([33621, 33622].includes(port), 'only an explicit isolated database port is permitted');
    const db = await require('../lib/automation-test-db').createTestDatabase(port);
    try {
        const limiter = require('../../src/automation/rate-limits').createRateLimiter(db);
        const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
        const files = Array.from({ length: 12 }, (_, index) => ({ name: `generated-${index}.png`, attachment: png }));
        const { prepared, transport, job, posts } = await prepare('dm', undefined,
            { db, rateLimiter: limiter, providerId: 'github', media: 'links', steps: [{ files }], failPost: 2 });
        assert.deepEqual(prepared.payloads.map(part => part.files.length), [10, 2]);
        await transport.reserve(prepared, job);
        assert.equal((await limiter.getSlotUsage(`${OWNER}:1`)).todayReserved, 2);
        await transport.sendStep(prepared, job, 0);
        await assert.rejects(transport.sendStep(prepared, job, 1), { code: 'ETIMEDOUT' });
        const rows = await db.queryDatabase('SELECT parts_json FROM automation_rate_reservations WHERE owner_user_id=?', [OWNER]);
        assert.deepEqual(JSON.parse(rows[0].parts_json), ['committed', 'unknown']);
        await assert.rejects(transport.sendStep(prepared, job, 1), { name: 'SafetyError' });
        assert.equal(posts.length, 2);
    } finally { await db.close(); }
});
