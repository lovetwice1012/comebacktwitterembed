'use strict';

const { ApplicationCommandOptionType } = require('discord.js');
const { commandNameLocales, descriptionLocales } = require('../../locales');
const { conv_en_to_en_US } = require('../../utils');

const HANDLERS = {
    "list": require('./autoextract/list'),
    "add": require('./autoextract/add'),
    "delete": require('./autoextract/delete'),
    "watch": require('./autoextract/watch'),
    "unwatch": require('./autoextract/unwatch'),
    "additionalautoextractslot": require('./autoextract/additionalautoextractslot'),
    "checkfreeslot": require('./autoextract/checkfreeslot'),
};

module.exports.execute = async function (interaction, client) {
    const handler = HANDLERS[interaction.options.getSubcommand()];
    if (handler) return await handler(interaction, client);
};


module.exports.definition = {
        name: 'autoextract',
        name_localizations: conv_en_to_en_US(commandNameLocales.autoextract),
        description: 'auto extract',
        description_localizations: conv_en_to_en_US(descriptionLocales.settingsAutoExtract),
        options: [
            {
                name: 'list',
                description: 'list',
                type: ApplicationCommandOptionType.Subcommand,
            },
            {
                name: 'add',
                description: 'Twitter/X registrations are paused',
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'username',
                        description: 'username',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    },
                    {
                        name: 'webhook',
                        description: 'webhook',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }
                ]
            },
            {
                name: 'watch',
                description: 'watch a public non-Twitter account for new items',
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'provider',
                        description: 'provider',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: 'YouTube', value: 'youtube' },
                            { name: 'GitHub account events', value: 'github' },
                            { name: 'Twitch live', value: 'twitch' },
                            { name: 'Spotify releases', value: 'spotify' },
                            { name: 'Pixiv artworks', value: 'pixiv' },
                            { name: 'BOOTH items', value: 'booth' },
                        ],
                    },
                    {
                        name: 'source',
                        description: 'public account URL, handle, or provider ID',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                    },
                    {
                        name: 'destination',
                        description: 'notification destination',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: 'Direct message', value: 'dm' },
                            { name: 'Existing webhook URL', value: 'webhook' },
                            { name: 'Create webhook in channel', value: 'channel' },
                        ],
                    },
                    {
                        name: 'responsibility',
                        description: 'I checked content, rights and destination; mechanical checks do not guarantee safety',
                        description_localizations: { ja: '内容・権利・通知先を自己責任で確認しました（機械チェックは安全性を保証しません）' },
                        type: ApplicationCommandOptionType.Boolean,
                        required: true,
                    },
                    {
                        name: 'webhook',
                        description: 'required only for Existing webhook URL',
                        type: ApplicationCommandOptionType.String,
                        required: false,
                    },
                    {
                        name: 'channel',
                        description: 'required only for Create webhook in channel',
                        type: ApplicationCommandOptionType.Channel,
                        required: false,
                    },
                ],
            },
            {
                name: 'unwatch',
                description: 'delete a non-Twitter watch registration',
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'id',
                        description: 'watch registration ID',
                        type: ApplicationCommandOptionType.Integer,
                        required: true,
                    },
                ],
            },
            {
                name: 'delete',
                description: 'delete',
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'id',
                        description: 'id',
                        type: ApplicationCommandOptionType.Integer,
                        required: true
                    }
                ]
            },
            {
                name: 'additionalautoextractslot',
                description: 'ADMIN ONLY',
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'user',
                        description: 'user',
                        type: ApplicationCommandOptionType.User,
                        required: true
                    },
                    {
                        name: 'slot',
                        description: 'slot',
                        type: ApplicationCommandOptionType.Integer,
                        required: true
                    }
                ]
            },
            {
                name: 'checkfreeslot',
                description: 'check free slot',
                type: ApplicationCommandOptionType.Subcommand
            }
        ]
    };
