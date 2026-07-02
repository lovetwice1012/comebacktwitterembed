'use strict';

const { ifUserHasRole } = require('../utils');

const SENSITIVE_DISPLAY_MODES = new Set(['normal', 'metadata_only', 'spoiler_attachment', 'suppress']);
const DISPLAY_MODE_RANK = {
    normal: 0,
    spoiler_attachment: 1,
    metadata_only: 2,
    suppress: 3,
};

function resolveSensitiveDisplayMode(settings, key, fallback = 'normal') {
    const mode = String(settings?.[key] || '').trim();
    return SENSITIVE_DISPLAY_MODES.has(mode) ? mode : fallback;
}

function normalizeTargetSetting(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        user: Array.isArray(source.user) ? source.user.map(String).filter(Boolean) : [],
        channel: Array.isArray(source.channel) ? source.channel.map(String).filter(Boolean) : [],
        role: Array.isArray(source.role) ? source.role.map(String).filter(Boolean) : [],
    };
}

function messageHasRole(message, roleIds) {
    if (!Array.isArray(roleIds) || roleIds.length === 0 || message?.webhookId) return false;
    if (!message?.member?.roles?.cache) return false;
    try {
        return ifUserHasRole(message.member, roleIds);
    } catch {
        return false;
    }
}

function sensitiveContentTargetMatches(message, settings) {
    const targets = normalizeTargetSetting(settings?.sensitive_content_excluded_targets);
    return messageMatchesTargets(message, targets);
}

function sensitiveContentAllowedTargetMatches(message, settings) {
    const targets = normalizeTargetSetting(settings?.sensitive_content_allowed_targets);
    return messageMatchesTargets(message, targets);
}

function messageMatchesTargets(message, targets) {
    const userId = message?.author?.id || message?.user?.id || '';
    const channelId = message?.channel?.id || message?.channelId || '';
    return (
        (userId && targets.user.includes(userId))
        || (channelId && targets.channel.includes(channelId))
        || messageHasRole(message, targets.role)
    );
}

function isNsfwChannel(message) {
    const channel = message?.channel;
    if (channel?.nsfw === true) return true;
    if (channel?.parent?.nsfw === true) return true;
    if (channel?.parentChannel?.nsfw === true) return true;
    return false;
}

function shouldSuppressSensitiveContent(message, settings) {
    return resolveEffectiveSensitiveDisplayMode(message, settings, 'normal') === 'suppress';
}

function resolveEffectiveSensitiveDisplayMode(message, settings, baseMode = 'normal') {
    if (sensitiveContentTargetMatches(message, settings)) return 'suppress';
    const normalizedBaseMode = SENSITIVE_DISPLAY_MODES.has(baseMode) ? baseMode : 'normal';
    if (!isNsfwChannel(message) && !sensitiveContentAllowedTargetMatches(message, settings)) {
        const nonNsfwMode = resolveSensitiveDisplayMode(settings, 'non_nsfw_channel_sensitive_display_mode', 'normal');
        if (nonNsfwMode !== 'normal') return moreRestrictiveMode(normalizedBaseMode, nonNsfwMode);
    }
    return normalizedBaseMode;
}

function moreRestrictiveMode(first, second) {
    return (DISPLAY_MODE_RANK[second] || 0) > (DISPLAY_MODE_RANK[first] || 0) ? second : first;
}

function buildSensitiveSuppressedStep(message, url, settings, options = {}) {
    const step = {
        suppressSourceEmbeds: true,
        allowedMentions: { repliedUser: false },
    };
    if (settings?.deletemessageifonlypostedtweetlink === true && String(message?.content || '').trim() === url) {
        step.deleteSource = true;
    }
    if (options.sendMode) step.send = options.sendMode;
    return step;
}

function imageExtensionFromUrl(url, fallback = 'jpg') {
    try {
        const pathname = new URL(url).pathname;
        const match = pathname.match(/\.([a-z0-9]+)$/i);
        const ext = match?.[1]?.toLowerCase();
        if (ext && /^[a-z0-9]{1,8}$/.test(ext)) return ext;
    } catch {}
    return fallback;
}

function spoilerFiles(urls, namePrefix, options = {}) {
    const offset = Number(options.offset) || 0;
    const fallbackExtension = options.fallbackExtension || 'jpg';
    return (Array.isArray(urls) ? urls : [])
        .filter(url => typeof url === 'string' && url)
        .map((url, index) => ({
            attachment: url,
            name: `SPOILER_${namePrefix}-${offset + index + 1}.${imageExtensionFromUrl(url, fallbackExtension)}`,
            fallbackUrl: url,
        }));
}

module.exports = {
    SENSITIVE_DISPLAY_MODES,
    buildSensitiveSuppressedStep,
    isNsfwChannel,
    normalizeTargetSetting,
    resolveEffectiveSensitiveDisplayMode,
    resolveSensitiveDisplayMode,
    sensitiveContentAllowedTargetMatches,
    sensitiveContentTargetMatches,
    shouldSuppressSensitiveContent,
    spoilerFiles,
};
