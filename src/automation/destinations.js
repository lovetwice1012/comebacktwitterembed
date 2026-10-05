'use strict';

const { AutomationError, requireActor, hash } = require('./service');
const ID = /^\d{16,22}$/;
const VIEW = 1n << 10n, SEND = 1n << 11n, MANAGE_WEBHOOKS = 1n << 29n, ADMIN = 8n;
const fail = (code, message, status = 400) => { throw new AutomationError(code, message, status); };
const bits = value => BigInt(value || '0');

// Discord's role-union / everyone / role-overwrite-union / member-overwrite
// ordering. A denial on one role must not override another role's allow.
function permissions(guild, roles, member, channel, now = Date.now()) {
    if (!member?.user?.id || !Array.isArray(member.roles)) return 0n;
    if (guild.owner_id === member.user.id) return ~0n;
    let value = 0n;
    for (const role of roles) if (role.id === guild.id || member.roles.includes(role.id)) value |= bits(role.permissions);
    if ((value & ADMIN) !== 0n) return ~0n;
    const overwrites = channel.permission_overwrites || [];
    const everyone = overwrites.find(o => o.type === 0 && o.id === guild.id);
    if (everyone) value = (value & ~bits(everyone.deny)) | bits(everyone.allow);
    let allow = 0n, deny = 0n;
    for (const overwrite of overwrites) if (overwrite.type === 0 && member.roles.includes(overwrite.id)) {
        allow |= bits(overwrite.allow); deny |= bits(overwrite.deny);
    }
    value = (value & ~deny) | allow;
    const own = overwrites.find(o => o.type === 1 && o.id === member.user.id);
    if (own) value = (value & ~bits(own.deny)) | bits(own.allow);
    if (Date.parse(member.communication_disabled_until) > now) value &= VIEW | (1n << 16n);
    return value;
}
const has = (permissionsValue, flags) => (permissionsValue & flags) === flags;

function webhookParts(raw) {
    const match = /^https:\/\/discord\.com\/api\/(?:v10\/)?webhooks\/(\d{16,22})\/([A-Za-z0-9_-]{20,200})$/.exec(String(raw || '').trim());
    if (!match) fail('INVALID_WEBHOOK', 'discord.com のWebhook URLを入力してください。');
    return { id: match[1], token: match[2], url: `https://discord.com/api/webhooks/${match[1]}/${match[2]}` };
}

function createDestinations(db, service, options = {}) {
    const rest = options.rest || require('../adminSupport/discord').rest;
    async function call(route, init) {
        try { return (await rest(route, init)).data; }
        catch (error) {
            // Neither Discord response objects nor URLs containing webhook
            // tokens reach HTTP errors/audit/telemetry.
            const status = Number(error.status);
            if (status === 429) fail('DISCORD_RATE_LIMITED', 'Discordが混雑しています。時間をおいて再試行してください。', 503);
            if ([401, 403, 404].includes(status)) fail('DISCORD_ACCESS_DENIED', 'Botまたは利用者が通知先へアクセスできません。', 403);
            fail('DISCORD_UNAVAILABLE', 'Discordに接続できません。Botの設定と接続状態を確認してください。', 503);
        }
    }
    async function context(actor, guildId) {
        requireActor(actor);
        if (!ID.test(guildId || '')) fail('GUILD_REQUIRED', '通知先のサーバーを選んでください。');
        const [guild, roles, member, bot] = await Promise.all([
            call(`/guilds/${guildId}`), call(`/guilds/${guildId}/roles`),
            call(`/guilds/${guildId}/members/${actor.userId}`), call('/users/@me'),
        ]);
        if (guild.id !== guildId || member.user?.id !== actor.userId || !ID.test(bot.id || '')) fail('DISCORD_ACCESS_DENIED', '所属情報を確認できません。', 403);
        return { guild, roles, member, bot };
    }
    async function verifyChannel(actor, guildId, channelId, create = false) {
        if (!ID.test(channelId || '')) fail('CHANNEL_REQUIRED', 'チャンネルを選んでください。');
        const [ctx, channel] = await Promise.all([context(actor, guildId), call(`/channels/${channelId}`)]);
        if (channel.guild_id !== guildId || ![0, 5].includes(channel.type)) fail('CHANNEL_MISMATCH', 'このサーバーのテキスト・アナウンスチャンネルを選んでください。');
        const required = VIEW | SEND | (create ? MANAGE_WEBHOOKS : 0n);
        if (!has(permissions(ctx.guild, ctx.roles, ctx.member, channel), required)) fail('CHANNEL_PERMISSION', create ? 'チャンネルの閲覧・送信・Webhook管理権限が必要です。' : '通知先チャンネルの閲覧・送信権限が必要です。', 403);
        if (create) {
            const botMember = await call(`/guilds/${guildId}/members/${ctx.bot.id}`);
            if (!has(permissions(ctx.guild, ctx.roles, botMember, channel), required)) fail('BOT_CHANNEL_PERMISSION', 'Botにもチャンネルの閲覧・送信・Webhook管理権限が必要です。', 403);
        }
        return { ...ctx, channel };
    }
    async function channels(actor) {
        const ctx = await context(actor, actor.guildId);
        const [items, botMember] = await Promise.all([call(`/guilds/${actor.guildId}/channels`), call(`/guilds/${actor.guildId}/members/${ctx.bot.id}`)]);
        return { items: items.filter(c => [0, 5].includes(c.type) && has(permissions(ctx.guild, ctx.roles, ctx.member, c), VIEW | SEND)).map(c => ({
            id: c.id, name: c.name, nsfw: c.nsfw === true,
            canCreateWebhook: has(permissions(ctx.guild, ctx.roles, ctx.member, c), MANAGE_WEBHOOKS) && has(permissions(ctx.guild, ctx.roles, botMember, c), VIEW | SEND | MANAGE_WEBHOOKS),
        })) };
    }
    async function save(actor, input, id) {
        requireActor(actor);
        // Authorization and optimistic revision validation precede any remote
        // mutation, including when a malicious caller supplies someone else's ID.
        let previous;
        if (id) {
            previous = await service.getRow('destination', actor, id, true);
            if (Number(previous.revision) !== input.expectedRevision) fail('REVISION_CONFLICT', '通知先が更新されています。', 409);
        }
        if (input.scope === 'guild' && (!actor.guildId || !actor.canEdit)) fail('FORBIDDEN', 'サーバー編集権限が必要です。', 403);
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) fail('NAME_REQUIRED', '名前は1〜120文字です。');
        if (input.kind === 'dm') return service.saveDestination(actor, input, {}, id);
        if (!['channel', 'webhook'].includes(input.kind)) fail('INVALID_DESTINATION', '通知先の種類が不正です。');
        if (!ID.test(actor.guildId || '')) fail('GUILD_REQUIRED', 'Webhook通知先はサーバーの自動化画面で追加してください。');
        if (previous && (previous.guild_id !== actor.guildId || previous.scope !== (input.scope || 'private'))) fail('SCOPE_IMMUTABLE', 'サーバー・公開範囲は変更できません。');
        let webhook, createdByBot = false;
        if (input.kind === 'channel') {
            const ctx = await verifyChannel(actor, actor.guildId, input.channelId, true);
            // Reuse only this Bot's purpose-named webhook; never adopt arbitrary
            // hooks owned by another application or delete a caller's hook.
            const existing = await call(`/channels/${input.channelId}/webhooks`);
            webhook = existing.find(w => w.type === 1 && w.user?.id === ctx.bot.id && w.name === 'ComebackTwitterEmbed Auto' && w.token);
            if (!webhook) webhook = await call(`/channels/${input.channelId}/webhooks`, { method: 'POST', body: { name: 'ComebackTwitterEmbed Auto' } });
            createdByBot = true;
        } else if (!input.webhookUrl && previous?.webhook_endpoint_id) {
            const endpoints = await db.queryDatabase('SELECT webhook_url FROM webhook_endpoints WHERE id=?', [previous.webhook_endpoint_id]);
            if (!endpoints.length) fail('INVALID_WEBHOOK', 'Webhookを再登録してください。');
            const parts = webhookParts(endpoints[0].webhook_url);
            webhook = await call(`/webhooks/${parts.id}/${parts.token}`);
            webhook.token = parts.token;
            createdByBot = !!previous.created_by_bot;
        } else {
            const parts = webhookParts(input.webhookUrl);
            webhook = await call(`/webhooks/${parts.id}/${parts.token}`);
            if (webhook.id !== parts.id) fail('INVALID_WEBHOOK', 'Webhookの情報が一致しません。');
            webhook.token = parts.token;
        }
        if (webhook.type !== 1 || webhook.guild_id !== actor.guildId || !ID.test(webhook.channel_id || '')) fail('WEBHOOK_GUILD_MISMATCH', 'このサーバーの受信Webhookを使ってください。');
        const ctx = await verifyChannel(actor, actor.guildId, webhook.channel_id);
        const parts = webhookParts(`https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`);
        return db.withDatabaseTransaction(async query => {
            await query('INSERT INTO webhook_endpoints (webhook_url_hash,webhook_url) VALUES (?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)', [hash(parts.url), parts.url]);
            const rows = await query('SELECT id FROM webhook_endpoints WHERE webhook_url_hash=?', [hash(parts.url)]);
            return service.saveDestination(actor, input, { webhookEndpointId: String(rows[0].id), guildId: actor.guildId, channelId: ctx.channel.id, createdByBot }, id);
        });
    }
    return { channels, save, verifyChannel };
}
module.exports = { createDestinations, permissions, webhookParts, has, VIEW, SEND, MANAGE_WEBHOOKS };
