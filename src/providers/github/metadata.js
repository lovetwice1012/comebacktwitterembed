'use strict';

const LANGUAGE_COLORS = {
    Assembly: '#6e4c13',
    C: '#555555',
    'C#': '#178600',
    'C++': '#f34b7d',
    CSS: '#563d7c',
    Dart: '#00b4ab',
    Go: '#00add8',
    HTML: '#e34c26',
    Java: '#b07219',
    JavaScript: '#f1e05a',
    Kotlin: '#a97bff',
    Lua: '#000080',
    PHP: '#4f5d95',
    Python: '#3572A5',
    Ruby: '#701516',
    Rust: '#dea584',
    Shell: '#89e051',
    Swift: '#F05138',
    TypeScript: '#3178c6',
    Vue: '#41b883',
};

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return n.toLocaleString('en-US');
}

function repoName(data, parsed) {
    return data.full_name || `${parsed.owner}/${parsed.repo}`;
}

function hashColor(value) {
    let hash = 0;
    for (const ch of String(value || '')) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    const hue = Math.abs(hash) % 360;
    const c = 0.58;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = 0.28;
    const [r, g, b] =
        hue < 60 ? [c, x, 0] :
        hue < 120 ? [x, c, 0] :
        hue < 180 ? [0, c, x] :
        hue < 240 ? [0, x, c] :
        hue < 300 ? [x, 0, c] :
        [c, 0, x];
    return '#' + [r, g, b].map(channel => {
        const value8 = Math.round((channel + m) * 255);
        return value8.toString(16).padStart(2, '0');
    }).join('');
}

function normalizeLanguages(languages) {
    const entries = Object.entries(languages || {})
        .map(([name, bytes]) => ({ name, bytes: Number(bytes) || 0 }))
        .filter(item => item.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes);
    const total = entries.reduce((sum, item) => sum + item.bytes, 0);
    if (total <= 0) return [];
    return entries.map(item => ({
        ...item,
        ratio: item.bytes / total,
        color: LANGUAGE_COLORS[item.name] || hashColor(item.name),
    }));
}

module.exports = { formatNumber, repoName, normalizeLanguages };
