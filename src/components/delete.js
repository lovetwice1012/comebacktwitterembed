'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../locales');

const OTHER_DOMAINS = { pixiv: ['pixiv.net', 'phixiv.net', 'ppxiv.net'], booth: ['booth.pm'], instagram: ['instagram.com'],
    youtube: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], niconico: ['nicovideo.jp', 'nico.ms'], twitch: ['twitch.tv'],
    spotify: ['spotify.com'], github: ['github.com'], tiktok: ['tiktok.com'], steam: ['steampowered.com', 'steamcommunity.com', 's.team'] };
const OTHER_BUTTONS = new Set([...Object.keys(OTHER_DOMAINS), 'amazon']);
const FOOTER_SUFFIXES = {
    pixiv: /\(id:(\d{16,22})\)\s*·\s*pixiv$/i, booth: /\(id:(\d{16,22})\)\s*·\s*booth\.pm$/i,
    instagram: /\(id:(\d{16,22})\)\s*-\s*Instagram$/i, youtube: /\(id:(\d{16,22})\)\s*·\s*YouTube$/i,
    niconico: /\(id:(\d{16,22})\)\s*\|\s*Niconico$/i, twitch: /\(id:(\d{16,22})\)\s*\|\s*Twitch$/i,
    spotify: /\(id:(\d{16,22})\)\s*-\s*Spotify$/i, github: /\(id:(\d{16,22})\)\s*\|\s*GitHub$/i,
    tiktok: /\(id:(\d{16,22})\)\s*-\s*TikTok$/i, steam: /\(id:(\d{16,22})\)\s*-\s*Steam (?:Community|Store)$/i,
    amazon: /\(id:(\d{16,22})\)\s*-\s*(?:Amazon(?: Music)?|Prime Video)$/i,
};
function sourceKind(interaction) {
    const value = interaction.message?.embeds?.[0]?.url;
    if (!value) {
        const [action, provider, extra] = String(interaction.customId || '').split(':');
        if (action === 'delete' && !extra && OTHER_BUTTONS.has(provider)) return provider;
        return !interaction.guildId ? 'dm' : null;
    }
    try {
        const url = new URL(value);
        if (url.username || url.password) return null;
        if (url.protocol === 'http:' && url.hostname === 'localhost' && url.port === '3088' && /^\/data\/\d{16,22}\/\d{1,22}\/data\.json$/.test(url.pathname)) return 'twitter';
        if (url.protocol !== 'https:' || url.port && url.port !== '443') return null;
        if (url.hostname === 'twidata.sprink.cloud' || ['x.com', 'twitter.com', 'vxtwitter.com', 'fxtwitter.com'].some(host =>
            url.hostname === host || url.hostname.endsWith(`.${host}`))) return 'twitter';
        for (const [provider, domains] of Object.entries(OTHER_DOMAINS))
            if (domains.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return provider;
        if (require('../providers/amazon/urls').parseAmazonUrl(url.href)) return 'amazon';
        return null;
    } catch { return null; }
}
function trustedRequester(text, prefix, trailing) {
    if (typeof text !== 'string' || !prefix.test(text)) return null;
    const match = text.match(trailing);
    return match?.[1] || null;
}
function getRequesterIdFromMessage(interaction) {
    const embed = interaction.message?.embeds?.[0];
    // X's footer is the untrusted X display name, which can contain an
    // arbitrary Discord ID. Only its Bot-created requester author is valid.
    const source = sourceKind(interaction);
    if (source === 'twitter') return trustedRequester(embed?.author?.name, /^(?:展開者:\s*|request by\s+)/i, /\(id:(\d{16,22})\)$/);
    // Other providers place the Bot-created requester in a marked footer.
    // Unmarked/ambiguous text, including remote authors, grants no rights.
    if (source === 'dm' || Object.hasOwn(FOOTER_SUFFIXES, source || '')) {
        // Match only the fixed suffixes emitted by supported providers. A
        // webhook name can itself contain fake IDs and separators, and must
        // never make an earlier ID or a forged suffix look authoritative.
        const directMessageSuffix = /\(id:(\d{16,22})\)$/;
        return trustedRequester(embed?.footer?.text, /^(?:展開者:\s*|requested by\s+)/i, source === 'dm' ? directMessageSuffix : FOOTER_SUFFIXES[source]);
    }
    return null;
}

async function handle(interaction, context = {}) {
    const finishAndCleanup = async () => {
        await interaction.editReply({ content: t('finishActionLocales', interaction.locale), ephemeral: true });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 3000);
    };

    const permissions = interaction.memberPermissions
        || interaction.channel?.permissionsFor?.(interaction.member);
    if (permissions?.has?.(PermissionsBitField.Flags.ManageMessages)) {
        await interaction.message.delete();
        await finishAndCleanup();
        return;
    }

    // Non-managers can only delete embeds they originally requested.
    const requesterId = Object.hasOwn(context, 'verifiedRequesterId')
        ? (/^\d{16,22}$/.test(String(context.verifiedRequesterId || '')) ? String(context.verifiedRequesterId) : null)
        : getRequesterIdFromMessage(interaction);
    if (!requesterId || requesterId !== interaction.user.id) {
        await interaction.editReply({ content: t('youcantdeleteotherusersmessagesLocales', interaction.locale), ephemeral: true });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 3000);
        return;
    }
    await interaction.message.delete();
    await finishAndCleanup();
}

module.exports = { handle };
