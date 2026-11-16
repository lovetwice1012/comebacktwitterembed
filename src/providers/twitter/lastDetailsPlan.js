'use strict';

// Build the physical send order separately from the gallery's operation
// anchor: the metadata-bearing anchor is the final message while earlier
// image messages remain in their original display order.
function planLastDetails(parts, groupId) {
    if (!Array.isArray(parts) || parts.length < 2 || parts.length > 20 || !/^[a-f0-9]{32}$/.test(groupId || '')) return null;
    const total = parts.length;
    if (parts.some((part, index) => !part || !Array.isArray(part.files) || !part.files.length || part.files.length > 10
        || !part.twitterGrid || part.twitterGrid.sequence !== index || part.twitterGrid.totalParts !== total
        || !Array.isArray(part.twitterGrid.imageUrls)
        || index > 0 && (!part.requiresPreviousSuccess || part.embeds?.length || part.components?.length || part.content))) return null;
    const result = parts.map(part => ({ ...part }));
    const first = result[0], last = result.at(-1);
    const firstGrid = first.twitterGrid;
    const original = { embeds: first.embeds, components: first.components, content: first.content,
        twitterGridInline: first.twitterGridInline, twitterGridSharedInline: first.twitterGridSharedInline };
    for (const key of Object.keys(original)) delete first[key];
    for (const [key, value] of Object.entries(original)) if (value !== undefined) last[key] = value;
    for (let index = 0; index < result.length - 1; index++) {
        const part = result[index];
        part.twitterGridLead = { groupId, imageUrls: [...part.twitterGrid.imageUrls] };
        delete part.twitterGrid;
    }
    // Sequence numbers of earlier parts are assigned from confirmed sends at
    // runtime, as a definite 413 can split a physical message further.
    last.twitterGridLastRoot = { groupId };
    last.twitterGrid = { ...last.twitterGrid, sequence: 0, totalParts: total,
        embedStart: firstGrid.embedStart, embedEnd: firstGrid.embedEnd };
    return result;
}

module.exports = { planLastDetails };
