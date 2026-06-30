'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const githubModulePath = require.resolve('../../src/providers/github');
const fetchModulePath = require.resolve('node-fetch');

function loadGitHubProviderWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalGitHubModule = require.cache[githubModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[githubModulePath];

    try {
        return require(githubModulePath);
    } finally {
        delete require.cache[githubModulePath];
        if (originalGitHubModule) require.cache[githubModulePath] = originalGitHubModule;
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
    return { ok: true, json: async () => json };
}

function fieldValue(embed, name) {
    return (embed.fields || []).find(field => field.name === name)?.value;
}

test('github extract: builds a repository embed from GitHub REST metadata', async () => {
    const requests = [];
    const provider = loadGitHubProviderWithFetch(async (url, options) => {
        requests.push({ url, options });
        return okJson({
            full_name: 'openai/codex',
            html_url: 'https://github.com/openai/codex',
            description: 'Lightweight coding agent.',
            stargazers_count: 12345,
            forks_count: 456,
            open_issues_count: 78,
            language: 'JavaScript',
            license: { spdx_id: 'MIT' },
            pushed_at: '2026-06-01T12:00:00Z',
            owner: {
                login: 'openai',
                html_url: 'https://github.com/openai',
                avatar_url: 'https://avatars.example/openai.png',
            },
        });
    });

    const url = 'https://github.com/openai/codex';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.github.com/repos/openai/codex');
    assert.equal(requests[0].options.headers.Accept, 'application/vnd.github+json');
    assert.equal(result.length, 1);

    const step = result[0];
    const embed = step.embeds[0];
    assert.equal(embed.title, 'openai/codex');
    assert.equal(embed.url, 'https://github.com/openai/codex');
    assert.equal(embed.description, 'Lightweight coding agent.');
    assert.equal(embed.author.name, 'openai');
    assert.equal(embed.thumbnail.url, 'https://avatars.example/openai.png');
    assert.equal(fieldValue(embed, 'Stars'), '12,345');
    assert.equal(fieldValue(embed, 'Forks'), '456');
    assert.equal(fieldValue(embed, 'Issues'), '78');
    assert.equal(fieldValue(embed, 'Language'), 'JavaScript');
    assert.equal(fieldValue(embed, 'License'), 'MIT');
    assert.equal(step.components[0].components[0].data.url, 'https://github.com/openai/codex');
    assert.deepEqual(
        step.components[1].components.map(button => button.data.custom_id),
        ['translate', 'delete:github']
    );
    assert.equal(step.suppressSourceEmbeds, true);
});

test('github extract: builds issue embeds with state, labels, and assignees', async () => {
    const provider = loadGitHubProviderWithFetch(async (url) => {
        assert.equal(url, 'https://api.github.com/repos/owner/repo/issues/42');
        return okJson({
            title: 'Fix the login redirect',
            body: 'Redirect loops when cookies are disabled.',
            html_url: 'https://github.com/owner/repo/issues/42',
            state: 'open',
            comments: 3,
            updated_at: '2026-06-02T00:00:00Z',
            labels: [{ name: 'bug' }, { name: 'auth' }],
            assignees: [{ login: 'octo' }],
            user: {
                login: 'reporter',
                html_url: 'https://github.com/reporter',
                avatar_url: 'https://avatars.example/reporter.png',
            },
        });
    });

    const url = 'https://github.com/owner/repo/issues/42';
    const result = await provider.extract(createMessage(url), url, {});
    const embed = result[0].embeds[0];

    assert.equal(embed.title, '#42 Fix the login redirect');
    assert.equal(embed.description, 'Redirect loops when cookies are disabled.');
    assert.equal(embed.author.name, 'reporter');
    assert.equal(fieldValue(embed, 'State'), 'open');
    assert.equal(fieldValue(embed, 'Comments'), '3');
    assert.equal(fieldValue(embed, 'Labels'), 'bug, auth');
    assert.equal(fieldValue(embed, 'Assignees'), 'octo');
});

test('github extract: builds pull request embeds with merged state and change summary', async () => {
    const provider = loadGitHubProviderWithFetch(async (url) => {
        assert.equal(url, 'https://api.github.com/repos/owner/repo/pulls/7');
        return okJson({
            title: 'Add provider dispatch',
            body: 'Moves extraction to providers.',
            html_url: 'https://github.com/owner/repo/pull/7',
            state: 'closed',
            merged_at: '2026-06-03T00:00:00Z',
            additions: 120,
            deletions: 34,
            commits: 5,
            changed_files: 8,
            comments: 2,
            review_comments: 4,
            updated_at: '2026-06-03T01:00:00Z',
            user: { login: 'contributor' },
        });
    });

    const url = 'https://github.com/owner/repo/pull/7';
    const result = await provider.extract(createMessage(url), url, {});
    const embed = result[0].embeds[0];

    assert.equal(embed.title, '#7 Add provider dispatch');
    assert.equal(fieldValue(embed, 'State'), 'merged');
    assert.equal(fieldValue(embed, 'Changes'), '+120 / -34');
    assert.equal(fieldValue(embed, 'Commits'), '5');
    assert.equal(fieldValue(embed, 'Files'), '8');
    assert.equal(fieldValue(embed, 'Comments'), '6');
});

test('github extract: builds commit embeds from commit metadata', async () => {
    const provider = loadGitHubProviderWithFetch(async (url) => {
        assert.equal(url, 'https://api.github.com/repos/owner/repo/commits/abc1234');
        return okJson({
            sha: 'abc1234def5678',
            html_url: 'https://github.com/owner/repo/commit/abc1234',
            commit: {
                message: 'Fix parser\n\nHandle trailing punctuation.',
                author: {
                    name: 'Coder',
                    date: '2026-06-04T00:00:00Z',
                },
            },
            author: {
                login: 'coder',
                html_url: 'https://github.com/coder',
                avatar_url: 'https://avatars.example/coder.png',
            },
            stats: { additions: 10, deletions: 2 },
            files: [{ filename: 'src/a.js' }, { filename: 'src/b.js' }],
        });
    });

    const url = 'https://github.com/owner/repo/commit/abc1234';
    const result = await provider.extract(createMessage(url), url, {});
    const embed = result[0].embeds[0];

    assert.equal(embed.title, 'Fix parser');
    assert.equal(embed.description, 'Handle trailing punctuation.');
    assert.equal(fieldValue(embed, 'SHA'), 'abc1234def5678');
    assert.equal(fieldValue(embed, 'Author'), 'coder');
    assert.equal(fieldValue(embed, 'Files'), '2');
    assert.equal(fieldValue(embed, 'Changes'), '+10 / -2');
});

test('github extract: builds latest and tagged release embeds', async () => {
    const requests = [];
    const provider = loadGitHubProviderWithFetch(async (url) => {
        requests.push(url);
        return okJson({
            name: 'Version 1.2.3',
            tag_name: 'v1.2.3',
            body: 'Release notes.',
            html_url: 'https://github.com/owner/repo/releases/tag/v1.2.3',
            draft: false,
            prerelease: true,
            assets: [{ name: 'app.zip' }],
            published_at: '2026-06-05T00:00:00Z',
            author: { login: 'maintainer' },
        });
    });

    const latest = 'https://github.com/owner/repo/releases/latest';
    const tagged = 'https://github.com/owner/repo/releases/tag/v1.2.3';
    const latestResult = await provider.extract(createMessage(latest), latest, {});
    const taggedResult = await provider.extract(createMessage(tagged), tagged, {});

    assert.deepEqual(requests, [
        'https://api.github.com/repos/owner/repo/releases/latest',
        'https://api.github.com/repos/owner/repo/releases/tags/v1.2.3',
    ]);
    assert.equal(latestResult[0].embeds[0].title, 'Version 1.2.3');
    assert.equal(fieldValue(taggedResult[0].embeds[0], 'Tag'), 'v1.2.3');
    assert.equal(fieldValue(taggedResult[0].embeds[0], 'State'), 'prerelease');
    assert.equal(fieldValue(taggedResult[0].embeds[0], 'Assets'), '1');
});

test('github extract: builds blob and tree embeds from repository contents', async () => {
    const requests = [];
    const provider = loadGitHubProviderWithFetch(async (url) => {
        requests.push(url);
        if (url.endsWith('/contents/README.md?ref=main')) {
            return okJson({
                type: 'file',
                name: 'README.md',
                size: 1536,
                html_url: 'https://github.com/owner/repo/blob/main/README.md',
            });
        }
        return okJson([
            { type: 'file', name: 'index.js' },
            { type: 'dir', name: 'src' },
        ]);
    });

    const blob = 'https://github.com/owner/repo/blob/main/README.md';
    const tree = 'https://github.com/owner/repo/tree/main/src';
    const blobResult = await provider.extract(createMessage(blob), blob, {});
    const treeResult = await provider.extract(createMessage(tree), tree, {});

    assert.deepEqual(requests, [
        'https://api.github.com/repos/owner/repo/contents/README.md?ref=main',
        'https://api.github.com/repos/owner/repo/contents/src?ref=main',
    ]);
    assert.equal(blobResult[0].embeds[0].title, 'README.md');
    assert.equal(fieldValue(blobResult[0].embeds[0], 'Type'), 'file');
    assert.equal(fieldValue(blobResult[0].embeds[0], 'Size'), '1.5 KB');
    assert.equal(treeResult[0].embeds[0].title, 'src');
    assert.equal(fieldValue(treeResult[0].embeds[0], 'Files'), '2');
    assert.ok(treeResult[0].embeds[0].description.includes('[file] index.js'));
    assert.ok(treeResult[0].embeds[0].description.includes('[dir] src'));
});

test('github extract: supports profile and gist URLs', async () => {
    const requests = [];
    const provider = loadGitHubProviderWithFetch(async (url) => {
        requests.push(url);
        if (url === 'https://api.github.com/users/octocat') {
            return okJson({
                login: 'octocat',
                name: 'The Octocat',
                bio: 'GitHub mascot.',
                html_url: 'https://github.com/octocat',
                avatar_url: 'https://avatars.example/octocat.png',
                type: 'User',
                public_repos: 8,
                followers: 100,
                location: 'San Francisco',
                updated_at: '2026-06-06T00:00:00Z',
            });
        }
        return okJson({
            description: 'Example gist',
            html_url: 'https://gist.github.com/octocat/abcdef',
            public: true,
            comments: 1,
            updated_at: '2026-06-07T00:00:00Z',
            owner: { login: 'octocat' },
            files: {
                'hello.js': {
                    filename: 'hello.js',
                    content: 'console.log("hello");\n',
                },
            },
        });
    });

    const profile = 'https://github.com/octocat';
    const gist = 'https://gist.github.com/octocat/abcdef';
    const profileResult = await provider.extract(createMessage(profile), profile, {});
    const gistResult = await provider.extract(createMessage(gist), gist, {});

    assert.deepEqual(requests, [
        'https://api.github.com/users/octocat',
        'https://api.github.com/gists/abcdef',
    ]);
    assert.equal(profileResult[0].embeds[0].title, 'The Octocat');
    assert.equal(fieldValue(profileResult[0].embeds[0], 'Repositories'), '8');
    assert.equal(fieldValue(profileResult[0].embeds[0], 'Followers'), '100');
    assert.equal(gistResult[0].embeds[0].title, 'Example gist');
    assert.equal(gistResult[0].embeds[0].description, 'console.log("hello");');
    assert.equal(fieldValue(gistResult[0].embeds[0], 'Files'), 'hello.js');
});

test('github extract: honors reply, delete source, anonymous, and banned word settings', async () => {
    const provider = loadGitHubProviderWithFetch(async () => okJson({
        full_name: 'owner/repo',
        html_url: 'https://github.com/owner/repo',
        description: 'Allowed description.',
        owner: { login: 'owner' },
    }));

    const url = 'https://github.com/owner/repo';
    const result = await provider.extract(createMessage(url), url, {
        alwaysreplyifpostedtweetlink: true,
        deletemessageifonlypostedtweetlink: true,
        anonymous_expand: true,
    });
    const blocked = await provider.extract(createMessage(url), url, {
        bannedWords: ['Allowed'],
    });

    assert.equal(result[0].send, 'reply-source');
    assert.equal(result[0].deleteSource, true);
    assert.ok(result[0].embeds[0].footer.text.includes('Anonymous requester'));
    assert.equal(blocked, null);
});

test('github urlPattern and parser: match supported URLs and reject reserved/non-GitHub URLs', () => {
    const provider = require('../../src/providers/github');
    const sample = [
        'https://github.com/openai/codex',
        'https://github.com/owner/repo/issues/1',
        'https://github.com/owner/repo/pull/2',
        'https://github.com/owner/repo/commit/abcdef1',
        'https://github.com/owner/repo/releases/latest',
        'https://github.com/owner/repo/releases/tag/v1.2.3',
        'https://github.com/owner/repo/blob/main/README.md',
        'https://gist.github.com/octocat/abcdef',
        'https://raw.githubusercontent.com/owner/repo/main/file.js',
    ].join(' ');

    const matches = sample.match(new RegExp(provider.urlPattern.source, provider.urlPattern.flags)) || [];
    assert.deepEqual(matches, [
        'https://github.com/openai/codex',
        'https://github.com/owner/repo/issues/1',
        'https://github.com/owner/repo/pull/2',
        'https://github.com/owner/repo/commit/abcdef1',
        'https://github.com/owner/repo/releases/latest',
        'https://github.com/owner/repo/releases/tag/v1.2.3',
        'https://github.com/owner/repo/blob/main/README.md',
        'https://gist.github.com/octocat/abcdef',
    ]);

    assert.equal(provider._internal.parseGitHubUrl('https://github.com/settings'), null);
    assert.equal(provider._internal.parseGitHubUrl('https://example.com/owner/repo'), null);
    assert.deepEqual(
        provider._internal.parseGitHubUrl('https://github.com/owner/repo/releases/tag/mobile%2Fv1.0.0').tag,
        'mobile/v1.0.0'
    );
});
