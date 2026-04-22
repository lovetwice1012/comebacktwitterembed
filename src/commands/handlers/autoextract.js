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
                name_localizations: conv_en_to_en_US(commandNameLocales.autoextract_list),
                description: 'list',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsAutoExtractList),
                type: ApplicationCommandOptionType.Subcommand,
            },
            {
                name: 'add',
                name_localizations: conv_en_to_en_US(commandNameLocales.autoextract_add),
                description: 'add',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsAutoExtractAdd),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'username',
                        name_localizations: conv_en_to_en_US(commandNameLocales.autoextract_username),
                        description: 'username',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    },
                    {
                        name: 'webhook',
                        name_localizations: conv_en_to_en_US(commandNameLocales.autoextract_webhook),
                        description: 'webhook',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }
                ]
            },
            {
                name: 'delete',
                name_localizations: conv_en_to_en_US(commandNameLocales.autoextract_delete),
                description: 'delete',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsAutoExtractDelete),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'id',
                        name_localizations: conv_en_to_en_US(commandNameLocales.autoextract_id),
                        description: 'id',
                        type: ApplicationCommandOptionType.Integer,
                        required: true
                    }
                ]
            },
            {
                name: 'additionalautoextractslot',
                name_localizations: conv_en_to_en_US(commandNameLocales.additionalautoextractslot),
                description: 'ADMIN ONLY',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsAdditionalAutoExtractSlot),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'user',
                        name_localizations: conv_en_to_en_US(commandNameLocales.user),
                        description: 'user',
                        type: ApplicationCommandOptionType.User,
                        required: true
                    },
                    {
                        name: 'slot',
                        name_localizations: conv_en_to_en_US(commandNameLocales.slot),
                        description: 'slot',
                        type: ApplicationCommandOptionType.Integer,
                        required: true
                    }
                ]
            },
            {
                name: 'checkfreeslot',
                name_localizations: conv_en_to_en_US(commandNameLocales.checkfreeslot),
                description: 'check free slot',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsAdditionalAutoExtractCheckFreeSlot),
                type: ApplicationCommandOptionType.Subcommand
            }
        ]
    };
