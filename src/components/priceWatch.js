'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const { normalizeSource } = require('../providers/priceWatch');
const { deleteTarget, registerTarget } = require('../providers/priceWatch/store');
const { validateWebhook } = require('../providers/autoWatch/store');
const { createWebhookForChannel } = require('./_webhookDestination');
const permissions = require('./_permissionCheck');

const PROVIDERS = Object.freeze({ a: 'amazon', s: 'steam' });

function ja(locale) {
    return String(locale || '').toLowerCase().startsWith('ja');
}

function parseSourceParts(parts, offset = 0) {
    const providerId = PROVIDERS[parts[offset]];
    const kind = parts[offset + 1];
    const id = parts[offset + 2];
    const locale = parts[offset + 3];
    const messageId = parts[offset + 4];
    if (!providerId || !/^[A-Za-z0-9._-]{1,64}$/.test(kind || '') || !/^[A-Za-z0-9._-]{1,128}$/.test(id || '') || !/^[A-Za-z-]{2,16}$/.test(locale || '') || !/^\d{16,22}$/.test(messageId || '')) return null;
    return { providerId, code: parts[offset], kind, id, locale, messageId };
}

function parseInitial(customId) {
    const parts = String(customId || '').split(':');
    if (parts.length !== 5 || parts[0] !== 'priceWatch') return null;
    const providerId = PROVIDERS[parts[1]];
    if (!providerId || !/^[A-Za-z0-9._-]{1,64}$/.test(parts[2] || '') || !/^[A-Za-z0-9._-]{1,128}$/.test(parts[3] || '') || !/^[A-Za-z-]{2,16}$/.test(parts[4] || '')) return null;
    return { providerId, code: parts[1], kind: parts[2], id: parts[3], locale: parts[4] };
}

function parseDestination(customId) {
    const parts = String(customId || '').split(':');
    if (parts[0] !== 'priceWatchDestination' || parts.length !== 6) return null;
    return parseSourceParts(parts, 1);
}

function parseChannel(customId) {
    const parts = String(customId || '').split(':');
    if (parts[0] !== 'priceWatchChannel' || parts.length !== 7 || !['change', 'threshold'].includes(parts[6])) return null;
    const source = parseSourceParts(parts, 1);
    return source ? { ...source, mode: parts[6] } : null;
}

function parseModal(customId) {
    const parts = String(customId || '').split(':');
    if (parts[0] !== 'priceWatchModal' || !['change', 'threshold'].includes(parts[1]) || !['dm', 'webhook', 'channel'].includes(parts[2])) return null;
    const source = parseSourceParts(parts, 3);
    if (!source) return null;
    const channelId = parts[8] || null;
    if (parts.length > 8 && !/^\d{16,22}$/.test(channelId || '')) return null;
    return { ...source, mode: parts[1], destination: parts[2], channelId };
}

function destinationChoices(locale) {
    const japanese = ja(locale);
    return [
        { label: japanese ? '価格変動をDMで通知' : 'DM on every price change', value: 'change:dm' },
        { label: japanese ? '価格変動を既存Webhookで通知' : 'Webhook on every price change', value: 'change:webhook' },
        { label: japanese ? '価格変動をチャンネルWebhookで通知' : 'Create channel webhook for price changes', value: 'change:channel' },
        { label: japanese ? '条件達成をDMで通知' : 'DM when a price condition is met', value: 'threshold:dm' },
        { label: japanese ? '条件達成を既存Webhookで通知' : 'Webhook when a price condition is met', value: 'threshold:webhook' },
        { label: japanese ? '条件達成をチャンネルWebhookで通知' : 'Create channel webhook for price condition', value: 'threshold:channel' },
    ];
}

async function originalMessage(interaction, messageId) {
    if (interaction.message?.id === messageId && interaction.message.embeds?.length) return interaction.message;
    const channel = interaction.channel;
    if (!channel?.messages?.fetch) throw Object.assign(new Error('The original expansion message is unavailable.'), { code: 'PRICE_WATCH_SOURCE_MESSAGE_UNAVAILABLE' });
    return await channel.messages.fetch(messageId);
}

async function sourceFromMessage(interaction, source) {
    const message = await originalMessage(interaction, source.messageId);
    const url = message.embeds?.[0]?.url;
    if (!url) throw Object.assign(new Error('The original expansion no longer has a product URL.'), { code: 'PRICE_WATCH_SOURCE_URL_UNAVAILABLE' });
    const normalized = normalizeSource(source.providerId, { url, locale: source.locale });
    if (normalized.productKind !== source.kind || String(normalized.productId) !== source.id) {
        throw Object.assign(new Error('The price alert button no longer matches its source product.'), { code: 'PRICE_WATCH_SOURCE_MISMATCH' });
    }
    return { normalized, productName: message.embeds?.[0]?.title || null };
}

function modalRow(input) {
    return /** @type {any} */ (new ActionRowBuilder().addComponents(input));
}

function modalFor(source, mode, destination, channelId, locale) {
    const customId = ['priceWatchModal', mode, destination, source.code, source.kind, source.id, source.locale, source.messageId, channelId].filter(Boolean).join(':');
    const japanese = ja(locale);
    const modal = new ModalBuilder()
        .setCustomId(customId)
        .setTitle(mode === 'threshold' ? (japanese ? '価格条件通知' : 'Price condition alert') : (japanese ? '既存Webhookを指定' : 'Specify existing webhook'));
    if (destination === 'webhook') {
        modal.addComponents(modalRow(
            new TextInputBuilder().setCustomId('webhook').setLabel(japanese ? 'Discord Webhook URL' : 'Discord webhook URL').setStyle(TextInputStyle.Short).setRequired(true)
        ));
    }
    if (mode === 'threshold') {
        modal.addComponents(
            modalRow(
                new TextInputBuilder().setCustomId('maxPrice').setLabel(japanese ? '通知する上限価格（任意・商品の通貨）' : 'Maximum price (optional; source currency)').setStyle(TextInputStyle.Short).setRequired(false)
            ),
            modalRow(
                new TextInputBuilder().setCustomId('minDiscount').setLabel(japanese ? '通知する最低割引率 %（任意）' : 'Minimum discount percent (optional)').setStyle(TextInputStyle.Short).setRequired(false)
            )
        );
    }
    return modal;
}

function modalValue(interaction, id) {
    try { return interaction.fields.getTextInputValue(id)?.trim() || ''; } catch { return ''; }
}

function confirmation(locale, result) {
    const japanese = ja(locale);
    return {
        content: japanese
            ? `価格通知を登録しました。\n対象: ${result.productUrl}\n通知先: ${result.destinationType === 'dm' ? 'DM' : 'Webhook'}\n方式: ${result.mode === 'change' ? '価格変動' : '条件達成'}`
            : `Price alert registered.\nItem: ${result.productUrl}\nDestination: ${result.destinationType === 'dm' ? 'DM' : 'Webhook'}\nMode: ${result.mode === 'change' ? 'price changes' : 'price condition'}`,
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Danger)
                .setLabel(japanese ? '価格通知を解除' : 'Remove price alert')
                .setCustomId(`priceWatchCancel:${result.id}`)
        )],
    };
}

async function register(interaction, source, mode, destination, options = {}) {
    const { normalized, productName } = await sourceFromMessage(interaction, source);
    let webhookUrl = options.webhookUrl || null;
    let createdWebhook = null;
    if (destination === 'webhook') {
        const checked = await validateWebhook(webhookUrl);
        if (checked.guildId !== interaction.guildId) throw Object.assign(new Error('The webhook belongs to another server.'), { code: 'PRICE_WATCH_WEBHOOK_GUILD_MISMATCH' });
    }
    if (destination === 'channel') {
        const created = await createWebhookForChannel(interaction, options.channelId, 'ComebackTwitterEmbed price alerts');
        webhookUrl = created.webhookUrl;
        createdWebhook = created.webhook;
    }
    try {
        return await registerTarget({
            userId: interaction.user.id,
            providerId: source.providerId,
            productUrl: normalized.productUrl,
            productName,
            locale: source.locale,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            destinationType: destination === 'dm' ? 'dm' : 'webhook',
            webhookUrl,
            mode,
            maxPriceAmount: options.maxPriceAmount,
            minDiscountPercent: options.minDiscountPercent,
        });
    } catch (error) {
        try { await createdWebhook?.delete?.(); } catch { /* keep the original registration failure */ }
        throw error;
    }
}

async function handle(interaction) {
    const cancel = String(interaction.customId || '').match(/^priceWatchCancel:(\d{1,20})$/);
    if (cancel) {
        await deleteTarget(interaction.user.id, cancel[1]);
        await interaction.update({ content: ja(interaction.locale) ? '価格通知を解除しました。' : 'Price alert removed.', components: [] });
        return;
    }
    const actionSource = parseInitial(interaction.customId) || parseDestination(interaction.customId) || parseChannel(interaction.customId);
    if (!actionSource) throw Object.assign(new Error('Invalid price alert action.'), { code: 'PRICE_WATCH_INVALID_COMPONENT' });
    if (!(await permissions.isAllowed(interaction, { providerId: actionSource.providerId }))) return false;
    const initial = parseInitial(interaction.customId);
    if (initial) {
        const messageId = interaction.message?.id;
        if (!messageId) throw Object.assign(new Error('The expansion message is unavailable.'), { code: 'PRICE_WATCH_SOURCE_MESSAGE_UNAVAILABLE' });
        const source = { ...initial, messageId };
        const menu = new StringSelectMenuBuilder()
            .setCustomId(['priceWatchDestination', source.code, source.kind, source.id, source.locale, source.messageId].join(':'))
            .setPlaceholder(ja(interaction.locale) ? '通知方法を選択' : 'Choose notification method')
            .addOptions(destinationChoices(interaction.locale));
        await interaction.reply({
            content: ja(interaction.locale) ? '内容・権利・通知先を自分の責任で確認して選択してください。機械チェックは適法性や安全性を保証しません。' : 'Choose after checking content, rights and destination under your responsibility. Mechanical checks do not certify legality or safety.',
            components: [new ActionRowBuilder().addComponents(menu)],
            ephemeral: true,
        });
        return;
    }

    const destination = parseDestination(interaction.customId);
    if (destination) {
        const choice = String(interaction.values?.[0] || '').split(':');
        const mode = choice[0];
        const target = choice[1];
        if (!['change', 'threshold'].includes(mode) || !['dm', 'webhook', 'channel'].includes(target)) throw Object.assign(new Error('Invalid price alert selection.'), { code: 'PRICE_WATCH_INVALID_SELECTION' });
        if (target === 'dm' && mode === 'change') {
            const result = await register(interaction, destination, mode, target);
            await interaction.update(confirmation(interaction.locale, result));
            return;
        }
        if (target === 'channel') {
            const menu = new ChannelSelectMenuBuilder()
                .setCustomId(['priceWatchChannel', destination.code, destination.kind, destination.id, destination.locale, destination.messageId, mode].join(':'))
                .setPlaceholder(ja(interaction.locale) ? 'Webhookを作成するチャンネルを選択' : 'Choose a channel for the webhook')
                .setMinValues(1)
                .setMaxValues(1);
            await interaction.update({ content: ja(interaction.locale) ? '通知チャンネルを選択してください。' : 'Choose the notification channel.', components: [new ActionRowBuilder().addComponents(menu)] });
            return;
        }
        await interaction.showModal(modalFor(destination, mode, target, null, interaction.locale));
        return;
    }

    const channel = parseChannel(interaction.customId);
    if (channel) {
        const channelId = interaction.values?.[0];
        if (!/^\d{16,22}$/.test(String(channelId || ''))) throw Object.assign(new Error('Select one channel.'), { code: 'PRICE_WATCH_CHANNEL_REQUIRED' });
        if (channel.mode === 'change') {
            const result = await register(interaction, channel, 'change', 'channel', { channelId });
            await interaction.update(confirmation(interaction.locale, result));
            return;
        }
        await interaction.showModal(modalFor(channel, 'threshold', 'channel', channelId, interaction.locale));
        return;
    }
    throw Object.assign(new Error('Invalid price alert action.'), { code: 'PRICE_WATCH_INVALID_COMPONENT' });
}

async function handleModal(interaction) {
    const parsed = parseModal(interaction.customId);
    if (!parsed) throw Object.assign(new Error('Invalid price alert form.'), { code: 'PRICE_WATCH_INVALID_MODAL' });
    if (!(await permissions.isAllowed(interaction, { providerId: parsed.providerId }))) return false;
    const options = {};
    if (parsed.destination === 'webhook') options.webhookUrl = modalValue(interaction, 'webhook');
    if (parsed.destination === 'channel') options.channelId = parsed.channelId;
    if (parsed.mode === 'threshold') {
        options.maxPriceAmount = modalValue(interaction, 'maxPrice').replace(/[,\s]/g, '');
        options.minDiscountPercent = modalValue(interaction, 'minDiscount').replace(/[%\s]/g, '');
    }
    const result = await register(interaction, parsed, parsed.mode, parsed.destination, options);
    await interaction.reply({ ...confirmation(interaction.locale, result), ephemeral: true });
}

function handles(customId) {
    return /^priceWatch(?:Destination|Channel|Modal|Cancel)?(?::|$)/.test(String(customId || ''));
}

module.exports = {
    handle,
    handleModal,
    handles,
    _internal: {
        parseChannel,
        parseDestination,
        parseInitial,
        parseModal,
        sourceFromMessage,
    },
};
