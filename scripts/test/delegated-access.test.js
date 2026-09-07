'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField } = require('discord.js');

const delegatedAccess = require('../../src/delegatedAccess');

const { ManageChannels, ManageGuild, ManageMessages, Administrator } = PermissionsBitField.Flags;

function permissionsWith(...flags) {
    const bitfield = new PermissionsBitField(flags);
    return {
        has(permission) {
            return bitfield.has(permission);
        },
    };
}

test('delegated edit permission overlay grants only Manage Channels and Manage Server', () => {
    const nativePermissions = permissionsWith(ManageMessages);
    const overlaidPermissions = delegatedAccess._internal.withDelegatedEditPermissions(nativePermissions);

    assert.equal(overlaidPermissions.has(ManageChannels), true);
    assert.equal(overlaidPermissions.has(ManageGuild), true);
    assert.equal(overlaidPermissions.has([ManageChannels, ManageGuild]), true);
    assert.equal(overlaidPermissions.has(ManageMessages), true, 'native permissions remain available');
    assert.equal(overlaidPermissions.has(Administrator), false);
    assert.equal(overlaidPermissions.has([ManageChannels, ManageMessages]), false);
});

test('only an edit grant overlays a guild interaction and the overlay is restored afterwards', async () => {
    const nativePermissions = permissionsWith();
    const nativeMember = { permissions: nativePermissions };
    const interaction = {
        guildId: 'guild-1',
        user: { id: 'user-1' },
        memberPermissions: nativePermissions,
        member: nativeMember,
    };

    const noOpRestore = await delegatedAccess.applyDelegatedEditPermissions(interaction, async () => 'view');
    assert.equal(interaction.memberPermissions, nativePermissions);
    assert.equal(interaction.member, nativeMember);
    noOpRestore();

    const restore = await delegatedAccess.applyDelegatedEditPermissions(interaction, async () => 'edit');
    assert.equal(interaction.memberPermissions.has(ManageChannels), true);
    assert.equal(interaction.member.permissions.has(ManageGuild), true);
    assert.equal(nativeMember.permissions.has(ManageGuild), false, 'the cached member is not modified');

    restore();
    assert.equal(interaction.memberPermissions, nativePermissions);
    assert.equal(interaction.member, nativeMember);
});

test('delegated role IDs are taken from the interaction payload without fetching members', () => {
    assert.deepEqual(
        delegatedAccess._internal.getInteractionRoleIds({
            member: { roles: { cache: new Map([['role-1', {}], ['role-2', {}]]) } },
        }),
        ['role-1', 'role-2'],
    );
    assert.deepEqual(
        delegatedAccess._internal.getInteractionRoleIds({ member: { roles: ['role-2', 'role-2', 'role-3'] } }),
        ['role-2', 'role-3'],
    );
});

test('delegated access fetches a member by the interaction user ID when resolving roles', async () => {
    let fetchedUserId = null;
    const roleIds = await delegatedAccess._internal.getFetchedInteractionRoleIds({
        guildId: 'guild-1',
        user: { id: 'user-1' },
        member: null,
        guild: {
            members: {
                fetch: async userId => {
                    fetchedUserId = userId;
                    return { roles: { cache: new Map([['role-fetched', {}]]) } };
                },
            },
        },
    });

    assert.equal(fetchedUserId, 'user-1');
    assert.deepEqual(roleIds, ['role-fetched']);
});

test('delegated access can be rolled out by guild ID bucket over time', () => {
    const beforeEnabled = process.env.DASHBOARD_DELEGATED_ACCESS_ENABLED;
    const beforeStart = process.env.DASHBOARD_DELEGATED_ACCESS_ROLLOUT_START_AT;
    const beforeDuration = process.env.DASHBOARD_DELEGATED_ACCESS_ROLLOUT_DURATION_HOURS;
    process.env.DASHBOARD_DELEGATED_ACCESS_ENABLED = 'true';
    process.env.DASHBOARD_DELEGATED_ACCESS_ROLLOUT_START_AT = '2026-09-01T00:00:00Z';
    process.env.DASHBOARD_DELEGATED_ACCESS_ROLLOUT_DURATION_HOURS = '24';
    try {
        assert.equal(delegatedAccess.enabledForGuild('123456789012345678', Date.parse('2026-08-31T23:59:59Z')), false);
        assert.equal(delegatedAccess.enabledForGuild('123456789012345678', Date.parse('2026-09-02T00:00:00Z')), true);
        assert.equal(delegatedAccess.enabledForGuild('1132814274734067772', Date.parse('2026-09-01T00:00:00Z')), true);
    } finally {
        if (beforeEnabled === undefined) delete process.env.DASHBOARD_DELEGATED_ACCESS_ENABLED;
        else process.env.DASHBOARD_DELEGATED_ACCESS_ENABLED = beforeEnabled;
        if (beforeStart === undefined) delete process.env.DASHBOARD_DELEGATED_ACCESS_ROLLOUT_START_AT;
        else process.env.DASHBOARD_DELEGATED_ACCESS_ROLLOUT_START_AT = beforeStart;
        if (beforeDuration === undefined) delete process.env.DASHBOARD_DELEGATED_ACCESS_ROLLOUT_DURATION_HOURS;
        else process.env.DASHBOARD_DELEGATED_ACCESS_ROLLOUT_DURATION_HOURS = beforeDuration;
    }
});
