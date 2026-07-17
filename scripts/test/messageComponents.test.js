'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Events, InteractionType, PermissionsBitField } = require('discord.js');

const handlerPath = require.resolve('../../src/handlers/messageComponents');
const deleteComponentPath = require.resolve('../../src/components/delete');
const errorTrackingPath = require.resolve('../../src/errorTracking');
const permissionCheckPath = require.resolve('../../src/components/_permissionCheck');
const buttonsPath = require.resolve('../../src/components/_buttons');
const guisettingPath = require.resolve('../../src/commands/handlers/guisetting');
const delegatedAccessPath = require.resolve('../../src/delegatedAccess');

test('message component treats a deleted target message as a benign race', async () => {
    const originals = new Map([
        [handlerPath, require.cache[handlerPath]],
        [deleteComponentPath, require.cache[deleteComponentPath]],
        [errorTrackingPath, require.cache[errorTrackingPath]],
        [permissionCheckPath, require.cache[permissionCheckPath]],
        [buttonsPath, require.cache[buttonsPath]],
    ]);
    const recordedErrors = [];
    const metrics = [];

    require.cache[deleteComponentPath] = {
        id: deleteComponentPath,
        filename: deleteComponentPath,
        loaded: true,
        exports: { handle: async () => { throw { code: 10008, message: 'Unknown Message' }; } },
    };
    require.cache[errorTrackingPath] = {
        id: errorTrackingPath,
        filename: errorTrackingPath,
        loaded: true,
        exports: {
            recordAnalyticsEvent: () => {},
            recordError: (_error, context) => recordedErrors.push(context),
            recordMetric: metric => metrics.push(metric),
            runWithErrorContext: (_context, callback) => callback(),
        },
    };
    require.cache[permissionCheckPath] = {
        id: permissionCheckPath,
        filename: permissionCheckPath,
        loaded: true,
        exports: { isAllowed: async () => true },
    };
    require.cache[buttonsPath] = {
        id: buttonsPath,
        filename: buttonsPath,
        loaded: true,
        exports: { buildButtons: () => ({}) },
    };
    delete require.cache[handlerPath];

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        const listeners = [];
        const { register } = require(handlerPath);
        register({
            on(event, listener) {
                if (event === Events.InteractionCreate) listeners.push(listener);
            },
        });

        let errorReplyAttempts = 0;
        const interaction = {
            id: 'interaction-1',
            type: InteractionType.MessageComponent,
            customId: 'delete:test',
            deferred: true,
            replied: false,
            deferReply: async () => {},
            editReply: async () => { errorReplyAttempts += 1; },
            followUp: async () => { errorReplyAttempts += 1; },
            reply: async () => { errorReplyAttempts += 1; },
        };

        assert.equal(listeners.length, 1);
        await listeners[0](interaction);

        assert.equal(errorReplyAttempts, 0);
        assert.equal(recordedErrors.at(-1).errorType, 'discord_unknown_message');
        assert.equal(recordedErrors.at(-1).severity, 'warn');
        assert.ok(metrics.includes('component_error'));
    } finally {
        console.warn = originalWarn;
        delete require.cache[handlerPath];
        for (const [modulePath, original] of originals) {
            if (original) require.cache[modulePath] = original;
            else delete require.cache[modulePath];
        }
    }
});

test('guisetting components and modals receive delegated edit permissions without changing the cached member', async () => {
    const originals = new Map([
        [handlerPath, require.cache[handlerPath]],
        [guisettingPath, require.cache[guisettingPath]],
        [delegatedAccessPath, require.cache[delegatedAccessPath]],
        [errorTrackingPath, require.cache[errorTrackingPath]],
    ]);
    let delegatedLookups = 0;
    let observedPermissions = null;
    let observedModalPermissions = null;

    require.cache[guisettingPath] = {
        id: guisettingPath,
        filename: guisettingPath,
        loaded: true,
        exports: {
            handleComponent: async interaction => {
                observedPermissions = {
                    manageChannels: interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels),
                    manageGuild: interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild),
                };
            },
            handleModalSubmit: async interaction => {
                observedModalPermissions = {
                    manageChannels: interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels),
                    manageGuild: interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild),
                };
            },
        },
    };
    require.cache[delegatedAccessPath] = {
        id: delegatedAccessPath,
        filename: delegatedAccessPath,
        loaded: true,
        exports: {
            applyDelegatedEditPermissions: async interaction => {
                delegatedLookups += 1;
                const originalMemberPermissions = interaction.memberPermissions;
                const originalMember = interaction.member;
                const delegatedPermissions = {
                    has: permission => (
                        permission === PermissionsBitField.Flags.ManageChannels
                        || permission === PermissionsBitField.Flags.ManageGuild
                    ),
                };
                interaction.memberPermissions = delegatedPermissions;
                interaction.member = { ...originalMember, permissions: delegatedPermissions };
                return () => {
                    interaction.memberPermissions = originalMemberPermissions;
                    interaction.member = originalMember;
                };
            },
        },
    };
    require.cache[errorTrackingPath] = {
        id: errorTrackingPath,
        filename: errorTrackingPath,
        loaded: true,
        exports: {
            recordAnalyticsEvent: () => {},
            recordError: () => {},
            recordMetric: () => {},
            runWithErrorContext: (_context, callback) => callback(),
        },
    };
    delete require.cache[handlerPath];

    try {
        const listeners = [];
        const { register } = require(handlerPath);
        register({ on: (_event, listener) => listeners.push(listener) });

        const nativePermissions = { has: () => false };
        const nativeMember = { permissions: nativePermissions };
        const interaction = {
            type: InteractionType.MessageComponent,
            customId: 'guisetting:bool:twitter:enabled:1',
            guildId: 'guild-1',
            memberPermissions: nativePermissions,
            member: nativeMember,
        };

        await listeners[0](interaction);

        assert.equal(delegatedLookups, 1);
        assert.deepEqual(observedPermissions, { manageChannels: true, manageGuild: true });
        assert.equal(interaction.memberPermissions, nativePermissions);
        assert.equal(interaction.member, nativeMember);

        const modalNativePermissions = { has: () => false };
        const modalNativeMember = { permissions: modalNativePermissions };
        const modalInteraction = {
            type: InteractionType.ModalSubmit,
            customId: 'guisetting:modal:defaultLanguage:twitter:default_language',
            guildId: 'guild-1',
            memberPermissions: modalNativePermissions,
            member: modalNativeMember,
        };

        await listeners[0](modalInteraction);

        assert.equal(delegatedLookups, 2);
        assert.deepEqual(observedModalPermissions, { manageChannels: true, manageGuild: true });
        assert.equal(modalInteraction.memberPermissions, modalNativePermissions);
        assert.equal(modalInteraction.member, modalNativeMember);
    } finally {
        delete require.cache[handlerPath];
        for (const [modulePath, original] of originals) {
            if (original) require.cache[modulePath] = original;
            else delete require.cache[modulePath];
        }
    }
});
