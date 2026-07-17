'use strict';

const { PermissionsBitField } = require('discord.js');
const { queryDatabase } = require('./db');

let config = {};
try { config = require('../config.json'); } catch {}

function enabled() {
    const value = process.env.DASHBOARD_DELEGATED_ACCESS_ENABLED;
    if (value !== undefined && value !== '') return /^(1|true|yes|on)$/i.test(value);
    return config.dashboard?.delegatedAccessEnabled === true;
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
    if (!enabled() || !interaction.guildId || !interaction.user?.id) return null;
    const roles = getInteractionRoleIds(interaction);
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
    getDelegatedAccess,
    applyDelegatedEditPermissions,
    _internal: {
        getInteractionRoleIds,
        hasDelegatedEditPermission,
        withDelegatedEditPermissions,
        installDelegatedEditPermissions,
    },
};
