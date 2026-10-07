'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const load = require('./helpers/load-dashboard.cjs');
const local = createRequire(path.resolve(__dirname, '../../dashboard/package.json'));
const authDirectory = path.dirname(path.dirname(local.resolve('next-auth/react')));
const parseProviders = local(path.join(authDirectory, 'core/lib/providers.js')).default;
const { openidClient } = local(path.join(authDirectory, 'core/lib/oauth/client.js'));
const { TokenSet } = local('openid-client');
const { authOptions } = load('features/auth/options.ts', { '@/lib/env': {
    getClientId: () => 'fixture-client', getClientSecret: () => 'fixture-secret', getNextAuthSecret: () => 'fixture-session-secret',
} });
const options = () => ({ provider: parseProviders({ url: 'https://local.test/api/auth', providerId: 'discord', providers: authOptions.providers }).provider });

test('Discord issuer response completes actual NextAuth/openid-client OAuth exchange and produces a Dashboard session', async () => {
    const opt = options(); assert.equal(opt.provider.authorization.params.scope, 'identify guilds');
    assert(opt.provider.checks.includes('state'));
    const client = await openidClient(opt); let exchanges = 0;
    client.grant = async body => { exchanges++; assert.equal(body.grant_type, 'authorization_code'); return new TokenSet({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'Bearer' }); };
    const tokens = await client.oauthCallback(opt.provider.callbackUrl, { code: 'fixture-code', state: 'fixture-state', iss: 'https://discord.com' }, { state: 'fixture-state' });
    assert.equal(exchanges, 1); assert.equal(tokens.access_token, 'fixture-access');
    const token = await authOptions.callbacks.jwt({ token: {}, account: { ...tokens, expires_at: Math.floor(Date.now() / 1000) + 3600 }, profile: { id: '111111111111111111', username: 'Fixture', avatar: null } });
    const session = await authOptions.callbacks.session({ session: { user: {} }, token });
    assert.equal(session.user.id, '111111111111111111'); assert.equal(session.accessToken, 'fixture-access');
});

test('wrong issuer and mismatched/missing state are rejected before token exchange', async () => {
    for (const params of [
        { iss: 'https://attacker.test', state: 'fixture-state' },
        { iss: 'https://discord.com', state: 'wrong-state' },
        { iss: 'https://discord.com' },
    ]) {
        const client = await openidClient(options()); client.grant = async () => assert.fail('Invalid authorization response contacted token endpoint');
        await assert.rejects(client.oauthCallback('https://local.test/api/auth/callback/discord', { code: 'fixture-code', ...params }, { state: 'fixture-state' }), /iss mismatch|state mismatch|state missing/);
    }
});

test('the previously deployed provider without issuer reproduces the reported callback error', async () => {
    const opt = options(); delete opt.provider.issuer;
    const client = await openidClient(opt); client.grant = async () => assert.fail('Issuer failure occurs before exchange');
    await assert.rejects(client.oauthCallback(opt.provider.callbackUrl, { code: 'fixture-code', state: 'fixture-state', iss: 'https://discord.com' }, { state: 'fixture-state' }), /issuer must be configured on the issuer/);
});

test('login errors are actionable and never reflect raw query strings or backend details', () => {
    const { authenticationErrorMessage } = load('features/auth/errors.ts');
    assert.equal(authenticationErrorMessage(undefined), null);
    assert.match(authenticationErrorMessage('OAuthCallback'), /Discord認証/);
    assert.doesNotMatch(authenticationErrorMessage('<script>credential=secret</script>'), /script|credential|secret/);
});
