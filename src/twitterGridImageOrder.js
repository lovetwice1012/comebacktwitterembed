'use strict';

// The gallery's first physical message is its operation anchor. When the
// detail card is sent last, that anchor can have a later display position.
// Keep references grouped by their actual Discord message and reorder only
// after validating a complete permutation and every group's exact size.
function orderedGroups(values, sizes, order) {
    if (!Array.isArray(values) || !Array.isArray(sizes) || !sizes.length || sizes.length > 20
        || sizes.some(size => !Number.isSafeInteger(size) || size < 0 || size > 20)
        || sizes.reduce((sum, size) => sum + size, 0) !== values.length || values.length > 20) {
        throw new Error('GRID_MANIFEST_INVALID');
    }
    const permutation = order === undefined ? sizes.map((_, index) => index) : order;
    if (!Array.isArray(permutation) || permutation.length !== sizes.length
        || permutation.some(index => !Number.isSafeInteger(index) || index < 0 || index >= sizes.length)
        || new Set(permutation).size !== sizes.length) throw new Error('GRID_MANIFEST_INVALID');
    let offset = 0;
    const groups = sizes.map(size => {
        const result = values.slice(offset, offset + size);
        offset += size;
        return result;
    });
    return permutation.flatMap(index => groups[index]);
}

function orderedImageUrls(payload) {
    if (!Array.isArray(payload?.imageUrls)) throw new Error('GRID_MANIFEST_INVALID');
    if (!Object.hasOwn(payload, 'imagePartOrder')) return [...payload.imageUrls];
    return orderedGroups(payload.imageUrls, payload.partSizes, payload.imagePartOrder);
}

module.exports = { orderedGroups, orderedImageUrls };
