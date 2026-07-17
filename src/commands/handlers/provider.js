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
 *   /provider show    <id>
 */

const { ApplicationCommandOptionType, PermissionsBitField } = require('discord.js');
const { loadProviders } = require('../../providers/_loader');
const {
    PROVIDER_DEFAULTS,
    getSetting,
    isProviderEnabled,
    setProviderEnabled,
} = require('../../providers/_provider_settings');

const SETTABLE_KEYS = Object.keys(PROVIDER_DEFAULTS).filter(k => k !== 'enabled');
const MAX_REPLY_LENGTH = 1900;
const MAX_SETTING_VALUE_LENGTH = 240;
const ALL_PROVIDERS_ID = 'all';

function findProvider(id) {
    return loadProviders().find(p => p.id === id);
}

async function ensureGuildAdmin(interaction) {
    if (!interaction.guild) {
        await interaction.editReply({ content: 'This command must be used in a guild.' });
        return false;
    }
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.editReply({ content: 'Manage Server permission is required.' });
        return false;
    }
    return true;
}

function formatSettingValue(value) {
    if (value === undefined) return '(unset)';
    const serialized = JSON.stringify(value);
    const display = serialized === undefined ? String(value) : serialized;
    if (display.length <= MAX_SETTING_VALUE_LENGTH) return display;
    return display.slice(0, MAX_SETTING_VALUE_LENGTH - 3) + '...';
}

async function replyLines(interaction, lines) {
    const chunks = [];
    let current = '';

    for (const line of lines) {
        if (current && current.length + line.length + 1 > MAX_REPLY_LENGTH) {
            chunks.push(current);
            current = line;
        } else {
            current = current ? current + '\n' + line : line;
        }
    }
    if (current) chunks.push(current);

    if (chunks.length === 0) {
        return await interaction.editReply({ content: 'No providers loaded.' });
    }

    await interaction.editReply({ content: chunks[0] });
    for (const chunk of chunks.slice(1)) {
        await interaction.followUp({ content: chunk, ephemeral: true });
    }
}

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (!await ensureGuildAdmin(interaction)) return;

    if (sub === 'list') {
        const lines = [];
        for (const p of loadProviders()) {
            const enabled = await isProviderEnabled(p, interaction.guildId);
            const def = p.enabledByDefault ? ' (default on)' : ' (default off)';
            lines.push(`\u2022 **${p.id}** \u2014 ${enabled ? 'enabled' : 'disabled'}${def}`);
        }
        return await replyLines(interaction, lines);
    }

    const id = interaction.options.getString('id', true);
    if (sub === 'enable' || sub === 'disable') {
        const enabled = sub === 'enable';
        if (id === ALL_PROVIDERS_ID) {
            const providers = loadProviders();
            for (const provider of providers) {
                await setProviderEnabled(provider, interaction.guildId, enabled);
            }
            return await interaction.editReply({ content: `All providers are now **${enabled ? 'enabled' : 'disabled'}** in this guild.` });
        }

        const provider = findProvider(id);
        if (!provider) {
            return await interaction.editReply({ content: `Unknown provider: ${id}` });
        }
        await setProviderEnabled(provider, interaction.guildId, sub === 'enable');
        return await interaction.editReply({ content: `Provider \`${id}\` is now **${sub === 'enable' ? 'enabled' : 'disabled'}** in this guild.` });
    }

    if (sub === 'show') {
        const provider = findProvider(id);
        if (!provider) {
            return await interaction.editReply({ content: `Unknown provider: ${id}` });
        }
        const lines = [`**${id}** in this guild:`, `\u2022 enabled: ${await isProviderEnabled(provider, interaction.guildId)}`];
        for (const k of SETTABLE_KEYS) {
            const v = await getSetting(provider, k, interaction.guildId);
            lines.push(`\u2022 ${k}: \`${formatSettingValue(v)}\``);
        }
        return await replyLines(interaction, lines);
    }

}

const idOption = {
    name: 'id',
    description: 'Provider id',
    type: ApplicationCommandOptionType.String,
    required: true,
    choices: loadProviders().map(p => ({ name: p.id, value: p.id })),
};

const idOrAllOption = {
    ...idOption,
    description: 'Provider id or all',
    choices: [
        { name: ALL_PROVIDERS_ID, value: ALL_PROVIDERS_ID },
        ...idOption.choices,
    ],
};

module.exports.execute = execute;
module.exports.definition = {
    name: 'provider',
    description: 'Manage embed providers (enable/disable per guild)',
    // Runtime authorization supports DB-backed delegated editors, which Discord's
    // static command permission field cannot represent.
    default_member_permissions: null,
    options: [
        { name: 'list',    description: 'List all loaded providers and their status', type: ApplicationCommandOptionType.Subcommand },
        { name: 'enable',  description: 'Enable a provider in this guild',  type: ApplicationCommandOptionType.Subcommand, options: [idOrAllOption] },
        { name: 'disable', description: 'Disable a provider in this guild', type: ApplicationCommandOptionType.Subcommand, options: [idOrAllOption] },
        { name: 'show',    description: 'Show this guild\u0027s settings for a provider', type: ApplicationCommandOptionType.Subcommand, options: [idOption] },
    ],
};
