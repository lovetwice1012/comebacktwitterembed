'use strict';

const { ApplicationCommandOptionType } = require('discord.js');
const { commandNameLocales, descriptionLocales } = require('../../locales');
const { conv_en_to_en_US } = require('../../utils');

const HANDLERS = {
    "list": require('./autoextract/list'),
    "add": require('./autoextract/add'),
    "delete": require('./autoextract/delete'),
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
                description: 'add',
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
