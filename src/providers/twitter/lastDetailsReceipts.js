'use strict';

const { isExpected } = require('../../discordMessageIdentity');

// Build virtual following parts only from confirmed Bot receipts. The DB row
// is bound to the final physical message, but every earlier image message is
// still recorded and verified by the ordinary multipart gallery machinery.
function build(root, receipts, scope) {
    const id = root?.twitterGridLastRoot?.groupId;
    if (!/^[a-f0-9]{32}$/.test(id || '') || !Array.isArray(receipts) || !receipts.length || receipts.length > 19
        || !root.twitterGrid || !Array.isArray(root.twitterGrid.imageUrls) || !Array.isArray(root.files)) return null;
    const total = receipts.length + 1;
    const messageIds = new Set();
    const following = [];
    let photoCount = root.twitterGrid.imageUrls.length;
    for (let index = 0; index < receipts.length; index++) {
        const { step, sent } = receipts[index] || {};
        const lead = step?.twitterGridLead;
        const attachments = sent?.attachments;
        const files = Array.isArray(attachments) ? attachments : typeof attachments?.values === 'function' ? [...attachments.values()] : null;
        if (lead?.groupId !== id || !Array.isArray(lead.imageUrls) || !Array.isArray(step.files)
            || !step.files.length || step.files.length > 10 || !isExpected(sent, scope, null)
            || !files || files.length !== step.files.length
            || files.some(file => !/^\d{1,25}$/.test(String(file?.id || '')))
            || new Set(files.map(file => String(file.id))).size !== files.length
            || messageIds.has(sent.id) || sent.content || sent.embeds?.length || sent.components?.length) return null;
        messageIds.add(sent.id);
        photoCount += lead.imageUrls.length;
        following.push({ ...step, twitterGrid: { imageUrls: [...lead.imageUrls], sequence: index + 1, totalParts: total } });
    }
    if (photoCount > 20) return null;
    const imagePartOrder = [...receipts.map((_, index) => index + 1), 0];
    return { root: { ...root, twitterGrid: { ...root.twitterGrid, sequence: 0, totalParts: total },
        twitterGridLastRoot: { groupId: id, imagePartOrder } }, following, imagePartOrder };
}

module.exports = { build };
