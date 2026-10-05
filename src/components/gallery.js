'use strict';

const gallery = require('../mediaGallery');
const { isAllowed } = require('./_permissionCheck');
const { getProviderSettings } = require('../providers/_provider_settings');
const { isNsfwChannel } = require('../providers/_sensitive_controls');

async function handle(interaction, storage = gallery.store()) {
    const ja = String(interaction.locale || '').startsWith('ja');
    const unavailable = ja ? 'このギャラリーは期限切れ、または表示設定が変更されています。' : 'This gallery has expired or its display settings have changed.';
    const match = /^gallery:([a-f0-9]{32}):(\d{1,3}):(0|\d{16,22})$/.exec(interaction.customId || '');
    if (!match || !interaction.guildId || interaction.message?.author?.id !== interaction.client?.user?.id) return;
    const [, id, pageText, owner] = match;
    if (owner !== '0' && owner !== interaction.user.id) {
        await interaction.reply({ content: ja ? 'この閲覧画面は開いた本人だけが操作できます。' : 'Only the person who opened this viewer can use it.', ephemeral: true });
        return;
    }
    // Every public-card click opens an independent ephemeral viewer. Only that
    // viewer's subsequent buttons update the private message in place.
    if (owner === '0') await interaction.deferReply({ ephemeral: true });
    else await interaction.deferUpdate();
    const fail = () => interaction.editReply({ content: unavailable, embeds: [], files: [], attachments: [], components: [] });
    if (!interaction.memberPermissions?.has?.(['ViewChannel', 'ReadMessageHistory'])) return fail();
    const row = await storage.get(id, interaction.guildId, interaction.channelId);
    if (!row || !row.message_id || owner === '0' && row.message_id !== interaction.message.id) return fail();
    // Older thread snapshots did not record the parent's NSFW state. A false
    // flag in those rows cannot establish that the saved media came from SFW.
    if (interaction.channel?.isThread?.() && row.payload.nsfwContextVersion !== 1 && row.payload.nsfw !== true) return fail();
    if (owner !== '0' && !interaction.message.flags?.has?.(64)) return fail();
    if (owner !== '0') {
        // A private viewer must stop serving snapshots after the public card
        // is removed or the user loses access to its channel history.
        try {
            const source = await interaction.channel.messages.fetch({ message: row.message_id, force: true });
            if (source?.author?.id !== interaction.client.user.id) return fail();
        } catch { return fail(); }
    }
    const settings = await getProviderSettings({ id: row.provider_id }, interaction.guildId);
    if (settings.enabled !== true || settings.gallery_display_mode !== 'gallery'
        || gallery.settingsHash(settings) !== row.payload.settingsHash
        || (row.payload.nsfw && !isNsfwChannel(interaction))) return fail();
    if (!await isAllowed(interaction, { providerId: row.provider_id })) return;
    const page = Number(pageText);
    if (!row.payload.pages[page]) return fail();
    await interaction.editReply(gallery.render(row.payload, page, interaction.user.id, interaction.locale));
}

module.exports = { handle };
