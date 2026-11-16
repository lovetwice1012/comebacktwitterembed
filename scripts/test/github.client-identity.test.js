'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubClient } = require('../../src/providers/github/client');

test('GitHub profiles reject mismatched identities but allow verified account redirects', async () => {
    const parsed = { type: 'user', login: 'expected' };
    const run = response => createGitHubClient(async url => String(url).includes('/contributions')
        ? { ok: true, text: async () => '<html></html>' }
        : { ok: true, json: async () => response.body, redirected: response.redirected, url: response.url }).fetchGitHubData(parsed);
    await assert.rejects(run({ body: { id: 123, login: 'other' } }), { code: 'GITHUB_IDENTITY_MISMATCH' });
    await assert.rejects(run({ body: { id: 123, login: 'other' }, redirected: true, url: 'https://evil.example/user/123' }), { code: 'GITHUB_IDENTITY_MISMATCH' });
    await assert.rejects(run({ body: { id: 123 } }), { code: 'GITHUB_IDENTITY_MISMATCH' });
    assert.equal((await run({ body: { id: 123, login: 'EXPECTED' } })).login, 'EXPECTED');
    assert.equal((await run({ body: { id: 123, login: 'renamed' }, redirected: true, url: 'https://api.github.com/user/123' })).login, 'renamed');
    assert.equal((await run({ body: { id: 123, login: 'renamed' }, redirected: true, url: 'https://api.github.com/users/renamed' })).login, 'renamed');
});

test('GitHub repositories reject unrelated metadata and accept verified repository redirects', async () => {
    const parsed = { type: 'repo', owner: 'old', repo: 'project' };
    const run = response => createGitHubClient(async () => ({ ok: true, json: async () => response.body,
        redirected: response.redirected, url: response.url })).fetchGitHubData(parsed, { display_density: 'compact' });
    await assert.rejects(run({ body: { id: 123, full_name: 'other/project' } }), { code: 'GITHUB_IDENTITY_MISMATCH' });
    await assert.rejects(run({ body: { id: 123, full_name: 'other/project' }, redirected: true, url: 'https://evil.example/repositories/123' }), { code: 'GITHUB_IDENTITY_MISMATCH' });
    await assert.rejects(run({ body: { id: 123 } }), { code: 'GITHUB_IDENTITY_MISMATCH' });
    assert.equal((await run({ body: { id: 123, full_name: 'Old/Project' } })).full_name, 'Old/Project');
    assert.equal((await run({ body: { id: 123, full_name: 'new/project' }, redirected: true, url: 'https://api.github.com/repositories/123' })).full_name, 'new/project');
});
