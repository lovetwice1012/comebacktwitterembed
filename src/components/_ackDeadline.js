'use strict';

const TIMEOUT = Symbol('pre-ack-timeout');

// Only read-only work is allowed here. A modal must be the initial Discord
// acknowledgement, so a defer cannot be used while that work is pending.
async function beforeAck(interaction, read, options = {}) {
    const now = (options.now || Date.now)(), created = Number(interaction.createdTimestamp);
    const remaining = Number.isFinite(created) && created > 0 ? Math.max(0, created + 2400 - now) : 1200;
    if (remaining <= 0) return TIMEOUT;
    const timeoutMs = Math.max(1, Math.min(1200, remaining)); let timer;
    try {
        return await Promise.race([Promise.resolve().then(read), new Promise(resolve => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs); })]);
    } finally { clearTimeout(timer); }
}

async function replyTimeout(interaction) {
    const content = String(interaction.locale || '').startsWith('ja') ? '確認に時間がかかりました。もう一度お試しください。' : 'The check took too long. Please try again.';
    await interaction.reply({ content, ephemeral: true });
}

module.exports = { TIMEOUT, beforeAck, replyTimeout };
