'use strict';

function normalizeHiddenOutputItems(value) {
    if (Array.isArray(value)) {
        return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))];
    }

    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return [];
        if (text.startsWith('[')) {
            try {
                return normalizeHiddenOutputItems(JSON.parse(text));
            } catch {
                return [];
            }
        }
        return normalizeHiddenOutputItems(text.split(','));
    }

    return [];
}

function isOutputHidden(settings, key) {
    return normalizeHiddenOutputItems(settings?.hidden_output_items).includes(key);
}

module.exports = {
    isOutputHidden,
    normalizeHiddenOutputItems,
};
