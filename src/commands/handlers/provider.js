'use strict';

/**
 * `/provider` スラッシュコマンド。
 *
 * Provider 単位の有効/無効と汎用設定キーの編集を担う。
 * Twitter は既存の `/settings ...` でも編集できる (互換維持)。
 * 新サイトを追加した場合は本コマンドで有効化 + 設定する。
 *
 *   /provider list
 *   /provider enable  <id>
 *   /provider disable <id>
 *   /provider set     <id> <key> <value:bool|int|string>
 *   /provider show    <id>
 */

const { ApplicationCommandOptionType, PermissionsBitField } = require('discord.js');
const { loadProviders } = require('../../providers/_loader');
const {
    PROVIDER_DEFAULTS,
    getSetting,
    setSetting,
    isProviderEnabled,
    setProviderEnabled,
} = require('../../providers/_provider_settings');
const { saveSettings, settings } = require('../../settings');

const SETTABLE_KEYS = Object.keys(PROVIDER_DEFAULTS).filter(k => k !== 'enabled');

function findProvider(id) {
    return loadProviders().find(p => p.id === id);
}

async function ensureGuildAdmin(interaction) {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command must be used in a guild.', ephemeral: true });
        return false;
    }
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({ content: 'Manage Server permission is required.', ephemeral: true });
        return false;
    }
    return true;
}

function parseValue(raw) {
    if (raw === 'true')  return true;
    if (raw === 'false') return false;
    if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
    return raw;
}

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
        const lines = loadProviders().map(p => {
            const enabled = isProviderEnabled(p, interaction.guildId);
            const def = p.enabledByDefault ? ' (default on)' : ' (default off)';
            return `\u2022 **${p.id}** \u2014 ${enabled ? 'enabled' : 'disabled'}${def}`;
        });
        return await interaction.reply({ content: lines.join('\n') || 'No providers loaded.', ephemeral: true });
    }

    if (!await ensureGuildAdmin(interaction)) return;

    const id = interaction.options.getString('id', true);
    const provider = findProvider(id);
    if (!provider) {
        return await interaction.reply({ content: `Unknown provider: ${id}`, ephemeral: true });
    }

    if (sub === 'enable' || sub === 'disable') {
        setProviderEnabled(provider, interaction.guildId, sub === 'enable');
        await saveSettings(settings);
        return await interaction.reply({ content: `Provider \`${id}\` is now **${sub === 'enable' ? 'enabled' : 'disabled'}** in this guild.`, ephemeral: true });
    }

    if (sub === 'show') {
        const lines = [`**${id}** in this guild:`, `\u2022 enabled: ${isProviderEnabled(provider, interaction.guildId)}`];
        for (const k of SETTABLE_KEYS) {
            const v = getSetting(provider, k, interaction.guildId);
            lines.push(`\u2022 ${k}: \`${v === undefined ? '(unset)' : JSON.stringify(v)}\``);
        }
        return await interaction.reply({ content: lines.join('\n'), ephemeral: true });
    }

    if (sub === 'set') {
        const key = interaction.options.getString('key', true);
        if (!SETTABLE_KEYS.includes(key)) {
            return await interaction.reply({ content: `Unknown key: ${key}\nAvailable: ${SETTABLE_KEYS.join(', ')}`, ephemeral: true });
        }
        const raw = interaction.options.getString('value', true);
        const value = parseValue(raw);
        setSetting(provider, key, interaction.guildId, value);
        await saveSettings(settings);
        return await interaction.reply({ content: `\`${id}.${key}\` = \`${JSON.stringify(value)}\` (this guild)`, ephemeral: true });
    }
}

const idOption = {
    name: 'id',
    description: 'Provider id',
    type: ApplicationCommandOptionType.String,
    required: true,
    choices: loadProviders().map(p => ({ name: p.id, value: p.id })),
};

const keyOption = {
    name: 'key',
    description: 'Setting key',
    type: ApplicationCommandOptionType.String,
    required: true,
    choices: SETTABLE_KEYS.map(k => ({ name: k, value: k })),
};

module.exports.execute = execute;
module.exports.definition = {
    name: 'provider',
    description: 'Manage embed providers (enable/disable/configure per guild)',
    default_member_permissions: String(PermissionsBitField.Flags.ManageGuild),
    options: [
        { name: 'list',    description: 'List all loaded providers and their status', type: ApplicationCommandOptionType.Subcommand },
        { name: 'enable',  description: 'Enable a provider in this guild',  type: ApplicationCommandOptionType.Subcommand, options: [idOption] },
        { name: 'disable', description: 'Disable a provider in this guild', type: ApplicationCommandOptionType.Subcommand, options: [idOption] },
        { name: 'show',    description: 'Show this guild\u0027s settings for a provider', type: ApplicationCommandOptionType.Subcommand, options: [idOption] },
        {
            name: 'set',
            description: 'Set one of this provider\u0027s settings for this guild',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                idOption,
                keyOption,
                { name: 'value', description: 'true / false / integer / string (auto-parsed)',     type: ApplicationCommandOptionType.String, required: true },
            ],
        },
    ],
};
