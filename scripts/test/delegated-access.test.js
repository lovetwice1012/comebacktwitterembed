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
