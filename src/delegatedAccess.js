'use strict';

const { PermissionsBitField } = require('discord.js');
const { createHash } = require('crypto');
const { queryDatabase } = require('./db');

let config = {};
try { config = require('../config.json'); } catch {}

const INITIAL_ROLLOUT_GUILD_ID = '1132814274734067772';
const INITIAL_ROLLOUT_FRACTION = 1 / 14;

function enabled() {
    const value = process.env.DASHBOARD_DELEGATED_ACCESS_ENABLED;
    if (value !== undefined && value !== '') return /^(1|true|yes|on)$/i.test(value);
    return config.dashboard?.delegatedAccessEnabled === true;
}

function rolloutStartAt() {
    const value = process.env.DASHBOARD_DELEGATED_ACCESS_ROLLOUT_START_AT
        || config.dashboard?.delegatedAccessRolloutStartAt;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function rolloutDurationHours() {
    const envValue = Number(process.env.DASHBOARD_DELEGATED_ACCESS_ROLLOUT_DURATION_HOURS);
    if (Number.isFinite(envValue) && envValue > 0) return envValue;
    const configValue = Number(config.dashboard?.delegatedAccessRolloutDurationHours);
    return Number.isFinite(configValue) && configValue > 0 ? configValue : 24 * 14;
}

function rolloutBucket(guildId) {
    const digest = createHash('sha256').update(String(guildId)).digest('hex').slice(0, 12);
    return Number.parseInt(digest, 16) / 0x1000000000000;
}

function enabledForGuild(guildId, nowMs = Date.now()) {
    if (!enabled()) return false;
    const startAt = rolloutStartAt();
    if (!startAt) return true;
    const startMs = Date.parse(startAt);
    const durationHours = rolloutDurationHours();
    if (!Number.isFinite(startMs) || !durationHours) return false;
    if (nowMs < startMs) return false;
    if (String(guildId) === INITIAL_ROLLOUT_GUILD_ID) return true;
    const elapsed = Math.max(0, Math.min(1, (nowMs - startMs) / (durationHours * 60 * 60 * 1000)));
    const progress = INITIAL_ROLLOUT_FRACTION + elapsed * (1 - INITIAL_ROLLOUT_FRACTION);
    return rolloutBucket(guildId) <= progress;
}

function getInteractionRoleIds(interaction) {
    const roles = interaction.member?.roles;
    const roleIds = roles?.cache?.keys
        ? [...roles.cache.keys()]
        : Array.isArray(roles)
            ? roles
            : [];
    return [...new Set(roleIds.map(String).filter(Boolean))];
}

async function fetchInteractionMember(interaction) {
    const userId = interaction.user?.id;
    const members = interaction.guild?.members;
    if (!interaction.guildId || !userId || typeof members?.fetch !== 'function') return null;
    try {
        // Guild Members intent is not required for an explicitly identified
        // member REST lookup. This also works when the interaction member was
        // not retained in the discord.js cache.
        return await members.fetch(userId);
    } catch {
        return null;
    }
}

async function getFetchedInteractionRoleIds(interaction) {
    const member = await fetchInteractionMember(interaction);
    return member ? getInteractionRoleIds({ member }) : getInteractionRoleIds(interaction);
}

const DELEGATED_EDIT_PERMISSION_MASK =
    PermissionsBitField.Flags.ManageChannels | PermissionsBitField.Flags.ManageGuild;

function hasDelegatedEditPermission(permission) {
    try {
        const requested = new PermissionsBitField(permission).bitfield;
        return requested !== 0n && (requested & ~DELEGATED_EDIT_PERMISSION_MASK) === 0n;
    } catch {
        return false;
    }
}

function withDelegatedEditPermissions(permissions) {
    const target = permissions && (typeof permissions === 'object' || typeof permissions === 'function')
        ? permissions
        : {};
    const nativeHas = typeof target.has === 'function' ? target.has.bind(target) : null;

    return new Proxy(target, {
        get(current, property) {
            if (property === 'has') {
                return (permission, checkAdmin) => (
                    Boolean(nativeHas?.(permission, checkAdmin))
                    || hasDelegatedEditPermission(permission)
                );
            }

            const value = Reflect.get(current, property, current);
            return typeof value === 'function' ? value.bind(current) : value;
        },
    });
}

function withDelegatedEditMember(member) {
    if (!member) return member;

    return new Proxy(member, {
        get(target, property) {
            if (property === 'permissions') {
                return withDelegatedEditPermissions(Reflect.get(target, property, target));
            }

            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

function installDelegatedEditPermissions(interaction) {
    const originalMemberPermissions = interaction.memberPermissions;
    const originalMember = interaction.member;

    interaction.memberPermissions = withDelegatedEditPermissions(originalMemberPermissions);
    if (originalMember) interaction.member = withDelegatedEditMember(originalMember);

    return () => {
        interaction.memberPermissions = originalMemberPermissions;
        if (originalMember) interaction.member = originalMember;
    };
}

async function getDelegatedAccess(interaction) {
    if (!enabledForGuild(interaction.guildId) || !interaction.guildId || !interaction.user?.id) return null;
    const roles = await getFetchedInteractionRoleIds(interaction);
    const targetClauses = ["(target_type = 'user' AND target_id = ?)"];
    const values = [interaction.guildId, interaction.user.id];
    if (roles.length > 0) {
        targetClauses.push(`(target_type = 'role' AND target_id IN (${roles.map(() => '?').join(',')}))`);
        values.push(...roles);
    }
    const rows = await queryDatabase(
        `SELECT access_level FROM dashboard_delegated_access_grants WHERE guild_id = ? AND (${targetClauses.join(' OR ')})`,
        values,
    );
    return rows.some((row) => row.access_level === 'edit') ? 'edit' : rows.length ? 'view' : null;
}

async function applyDelegatedEditPermissions(interaction, resolveAccess = getDelegatedAccess) {
    if (!interaction.guildId || (await resolveAccess(interaction)) !== 'edit') return () => {};
    return installDelegatedEditPermissions(interaction);
}

module.exports = {
    enabled,
    enabledForGuild,
    getDelegatedAccess,
    applyDelegatedEditPermissions,
    _internal: {
        getInteractionRoleIds,
        rolloutBucket,
        fetchInteractionMember,
        getFetchedInteractionRoleIds,
        hasDelegatedEditPermission,
        withDelegatedEditPermissions,
        installDelegatedEditPermissions,
    },
};
