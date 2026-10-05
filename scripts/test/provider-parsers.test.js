'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const providersRoot = path.resolve(__dirname, '../../src/providers');
const examples = {
    amazon(parser) {
        const info = parser.extractProductInfo(
            '<script type="application/ld+json">{"@type":"Product","name":"Portable product"}</script>',
            { canonicalUrl: 'https://www.amazon.com/dp/B08N5WRWNW' },
        );
        assert.equal(info.title, 'Portable product');
    },
    booth(parser) {
        assert.deepEqual(parser.extractItemIds('<a href="/items/12">a</a><i data-url="/items/34"></i><a href="/items/12">b</a>'), ['12', '34']);
        assert.equal(parser.stripHtml('First<br>Second &amp; third'), 'First\nSecond & third');
        assert.equal(parser.extractSalePeriod({ sale_starts_at: '2026-01-01T00:00:00Z' }).startAt.toISOString(), '2026-01-01T00:00:00.000Z');
    },
    github(parser) {
        const data = parser.parseContributionCalendar('<td class="ContributionCalendar-day" data-date="2026-01-01" data-level="2"></td>');
        assert.deepEqual(data.cells, [{ date: '2026-01-01', level: 2 }]);
    },
    instagram(parser) {
        const data = parser.parseInstagramOEmbed(JSON.stringify({
            title: 'Portable post', author_name: 'creator', thumbnail_url: 'https://example.com/image.jpg',
        }));
        assert.equal(data.caption, 'Portable post');
        assert.equal(data.medias[0].url, 'https://example.com/image.jpg');
    },
    spotify(parser) {
        const source = { props: { pageProps: { state: { data: { entity: { name: 'Portable track' } } } } } };
        const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(source)}</script>`;
        assert.equal(parser.parseSpotifyPage(html, 'track', 'abc').name, 'Portable track');
    },
    steam(parser) {
        const data = parser.parseSteamPage('<meta property="og:title" content="Portable game on Steam"><meta property="og:image" content="/cover.jpg">', 'https://store.steampowered.com/app/123');
        assert.equal(data.title, 'Portable game');
        assert.equal(data.imageUrl, 'https://store.steampowered.com/cover.jpg');
    },
    tiktok(parser) {
        const item = { id: '123', desc: 'Portable post' };
        const source = { __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: item } } } };
        const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(source)}</script>`;
        assert.deepEqual(parser.parseTikTokVideoHtml(html), item);
    },
    twitter(parser) {
        const data = { tweetURL: 'https://x.com/creator/status/123', text: 'Portable tweet' };
        assert.deepEqual(parser.parseTweetApiResponse(JSON.stringify(data)), data);
    },
    youtube(parser) {
        const player = { videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'A {quoted} "title"', author: 'creator' } };
        const parsed = parser.parseInitialPlayerResponse(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`);
        assert.equal(parser.normalizePlayerResponse(parsed).title, player.videoDetails.title);
        assert.deepEqual(parser.parseFeedEntries('<feed><entry><yt:videoId>abc</yt:videoId><title><![CDATA[A &amp; B]]></title><published>2026-01-01</published></entry></feed>'), [
            { videoId: 'abc', title: 'A & B', published: '2026-01-01' },
        ]);
    },
};

test('source parser folders remain inside their provider and cover the portability fixtures', () => {
    const providers = fs.readdirSync(providersRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(providersRoot, entry.name, `${entry.name}SourceParser/index.js`)))
        .map(entry => entry.name).sort();
    assert.deepEqual(providers, Object.keys(examples).sort());
});

for (const [provider, verify] of Object.entries(examples)) {
    test(`${provider} parser: copied folder parses source without importing its provider`, t => {
        const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-parser-'));
        const moduleName = `${provider}SourceParser`;
        const copiedFolder = path.join(temporaryRoot, moduleName);
        t.after(() => {
            assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
            assert.ok(path.basename(temporaryRoot).startsWith('cbte-parser-'));
            fs.rmSync(temporaryRoot, { recursive: true, force: true });
        });
        fs.cpSync(path.join(providersRoot, provider, moduleName), copiedFolder, { recursive: true });

        for (const entry of fs.readdirSync(copiedFolder, { recursive: true, withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
            const filename = path.join(entry.parentPath, entry.name);
            const source = fs.readFileSync(filename, 'utf8');
            for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
                assert.ok(match[1].startsWith('.'), `${filename} must not require application/npm modules`);
                const resolved = require.resolve(path.resolve(path.dirname(filename), match[1]));
                assert.ok(resolved.startsWith(copiedFolder + path.sep), `${filename} dependency must stay inside ${moduleName}/`);
            }
        }
        verify(require(copiedFolder));
    });
}

test('twitter parser preserves expected unavailability versus transient and malformed responses', () => {
    const parser = require('../../src/providers/twitter/twitterSourceParser');
    assert.throws(() => parser.parseTweetApiResponse('{"error":"private tweet"}'), error => parser.isExpectedNonExpandableTweetError(error));
    assert.throws(() => parser.parseTweetApiResponse('<html>service unavailable</html>'), error => !parser.isExpectedNonExpandableTweetError(error));
    assert.throws(() => parser.parseTweetApiResponse('{bad JSON'), SyntaxError);
    assert.throws(() => parser.parseTweetApiResponse('{}'), /without tweet data/);
});

test('youtube parser preserves missing data and malformed JSON behavior', () => {
    const parser = require('../../src/providers/youtube/youtubeSourceParser');
    assert.equal(parser.parseInitialPlayerResponse('<html>No metadata</html>'), null);
    assert.equal(parser.parseInitialData('ytInitialData = {"unterminated":true'), null);
    assert.throws(() => parser.parseInitialData('ytInitialData = {invalid}'), SyntaxError);
    assert.equal(parser.normalizePlayerResponse({}), null);
    assert.equal(parser.channelIdFromHtml('<html>No channel ID</html>'), null);
});
