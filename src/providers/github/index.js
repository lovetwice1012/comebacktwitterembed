'use strict';

const zlib = require('zlib');
const fetch = require('node-fetch');
const jpeg = require('jpeg-js');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');
const { createProviderAnalytics, facet, tagFacets } = require('../../analytics/providerMetrics');
const {
    applyMediaDisplayToStep,
    buildFailureResponse,
    shouldShowOutputItem,
} = require('../_output_controls');
const { toApiLocaleFamily } = require('../../discordLocales');

const GITHUB_COLOR = 0x24292f;
const GITHUB_OPEN_COLOR = 0x1a7f37;
const GITHUB_CLOSED_COLOR = 0xcf222e;
const GITHUB_MERGED_COLOR = 0x8250df;
const CONTRIBUTION_IMAGE_BACKGROUND = '#ffffff';
const CONTRIBUTION_IMAGE_BORDER = '#d0d7de';
const CONTRIBUTION_TEXT_COLOR = '#24292f';
const CONTRIBUTION_MUTED_TEXT_COLOR = '#57606a';
const CONTRIBUTION_LEVEL_COLORS = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];
const DESCRIPTION_MAX_LENGTH = 900;
const FIELD_MAX_LENGTH = 1024;
const GITHUB_ICON = 'https://github.githubassets.com/favicons/favicon.png';
const GITHUB_URL_PATTERN =
    /https?:\/\/(?:(?:www\.)?github\.com|gist\.github\.com)\/[^\s<>|]+/gi;
const REPO_CARD_WIDTH = 1200;
const REPO_CARD_HEIGHT = 630;
const REPO_CARD_LANGUAGE_BAR_HEIGHT = 36;
const REPO_CARD_HEATMAP_WIDTH_RATIO = 0.75;

/** @type {number[] | undefined} */
let crc32Table;

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

const RESERVED_TOP_LEVEL_PATHS = new Set([
    'about',
    'account',
    'apps',
    'blog',
    'business',
    'codespaces',
    'collections',
    'contact',
    'customer-stories',
    'dashboard',
    'enterprise',
    'events',
    'explore',
    'features',
    'gist',
    'join',
    'login',
    'logout',
    'marketplace',
    'new',
    'notifications',
    'orgs',
    'organizations',
    'pricing',
    'pulls',
    'readme',
    'search',
    'security',
    'settings',
    'sponsors',
    'team',
    'topics',
    'trending',
]);

const STR = {
    openButton: { ja: 'Open on GitHub', en: 'Open on GitHub' },
    translateButton: { ja: 'Translate', en: 'Translate' },
    deleteButton: { ja: 'Delete', en: 'Delete' },
    requesterPrefix: { ja: 'Requested by ', en: 'Requested by ' },
    anonymousRequester: { ja: 'Anonymous requester', en: 'Anonymous requester' },
    stars: { ja: 'Stars', en: 'Stars' },
    forks: { ja: 'Forks', en: 'Forks' },
    issues: { ja: 'Issues', en: 'Issues' },
    language: { ja: 'Language', en: 'Language' },
    languageBreakdown: { ja: 'Languages', en: 'Languages' },
    topics: { ja: 'Topics', en: 'Topics' },
    defaultBranch: { ja: 'Default branch', en: 'Default branch' },
    lastPush: { ja: 'Last push', en: 'Last push' },
    license: { ja: 'License', en: 'License' },
    state: { ja: 'State', en: 'State' },
    comments: { ja: 'Comments', en: 'Comments' },
    mergeable: { ja: 'Mergeable', en: 'Mergeable' },
    reviewState: { ja: 'Review', en: 'Review' },
    checks: { ja: 'Checks', en: 'Checks' },
    labels: { ja: 'Labels', en: 'Labels' },
    assignees: { ja: 'Assignees', en: 'Assignees' },
    changes: { ja: 'Changes', en: 'Changes' },
    commits: { ja: 'Commits', en: 'Commits' },
    files: { ja: 'Files', en: 'Files' },
    sha: { ja: 'SHA', en: 'SHA' },
    author: { ja: 'Author', en: 'Author' },
    assets: { ja: 'Assets', en: 'Assets' },
    tag: { ja: 'Tag', en: 'Tag' },
    type: { ja: 'Type', en: 'Type' },
    size: { ja: 'Size', en: 'Size' },
    snippet: { ja: 'Snippet', en: 'Snippet' },
    followers: { ja: 'Followers', en: 'Followers' },
    repositories: { ja: 'Repositories', en: 'Repositories' },
    location: { ja: 'Location', en: 'Location' },
    contributions: { ja: 'Contributions', en: 'Contributions' },
    gistFiles: { ja: 'Files', en: 'Files' },
};

const FONT_5X7 = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
    H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
    X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
    6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
    7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
    '&': ['01000', '10100', '10100', '01000', '10101', '10010', '01101'],
    '#': ['01010', '11111', '01010', '01010', '11111', '01010', '01010'],
    '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
    ',': ['00000', '00000', '00000', '00000', '00000', '00100', '01000'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
    '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
    ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
    '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
    ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
    '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

function normalizeLang(settings) {
    return toApiLocaleFamily(settings?.defaultLanguage);
}

function truncate(value, maxLength = DESCRIPTION_MAX_LENGTH) {
    const text = String(value ?? '').trim();
    if (!text || text.length <= maxLength) return text;
    if (maxLength <= 3) return text.slice(0, maxLength);
    return text.slice(0, maxLength - 3).trimEnd() + '...';
}

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return n.toLocaleString('en-US');
}

function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let current = bytes / 1024;
    for (let i = 0; i < units.length; i++) {
        if (current < 1024 || i === units.length - 1) {
            const digits = current >= 10 ? 0 : 1;
            return `${current.toFixed(digits)} ${units[i]}`;
        }
        current /= 1024;
    }
    return `${bytes} B`;
}

function firstLine(value) {
    return String(value ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
}

function bodySummary(value) {
    return truncate(String(value ?? '').replace(/\r\n/g, '\n'), DESCRIPTION_MAX_LENGTH);
}

function requesterName(message, lang, anonymous) {
    if (anonymous) return tr(STR.anonymousRequester, lang);
    return `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;
}

function requesterFooter(message, lang, anonymous) {
    return `${tr(STR.requesterPrefix, lang)}${requesterName(message, lang, anonymous)} | GitHub`;
}

function addField(fields, name, value, inline = true) {
    const text = truncate(value, FIELD_MAX_LENGTH);
    if (!text) return;
    fields.push({ name, value: text, inline });
}

function addVisibleField(fields, settings, key, name, value, inline = true) {
    if (!shouldShowOutputItem(settings, key)) return;
    addField(fields, name, value, inline);
}

function containsBannedWord(text, bannedWords) {
    if (!Array.isArray(bannedWords) || bannedWords.length === 0) return false;
    return bannedWords.some(word => word && String(text || '').includes(word));
}

function stateText(data, isPullRequest = false) {
    if (isPullRequest && data.merged_at) return 'merged';
    return data.state || '';
}

function stateColor(data, isPullRequest = false) {
    const state = stateText(data, isPullRequest);
    if (state === 'open') return GITHUB_OPEN_COLOR;
    if (state === 'merged') return GITHUB_MERGED_COLOR;
    if (state === 'closed') return GITHUB_CLOSED_COLOR;
    return GITHUB_COLOR;
}

function discordDate(value, style = 'R') {
    const ms = Date.parse(value || '');
    if (!Number.isFinite(ms)) return '';
    return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function topicSummary(data) {
    const topics = Array.isArray(data.topics) ? data.topics : [];
    return topics.slice(0, 8).join(', ');
}

function languageBreakdown(languages) {
    const normalized = normalizeLanguages(languages);
    if (normalized.length === 0) return '';
    return normalized
        .slice(0, 5)
        .map(item => `${item.name} ${Math.round(item.ratio * 100)}%`)
        .join(', ');
}

function mergeableText(data) {
    if (data.mergeable === true) return 'yes';
    if (data.mergeable === false) return 'no';
    return data.mergeable_state || '';
}

function reviewStateText(data) {
    if (data.draft === true) return 'draft';
    if (data.review_decision) return String(data.review_decision).toLowerCase().replace(/_/g, ' ');
    return '';
}

function checksText(data) {
    const status = data?.status;
    if (!status?.state) return '';
    const count = Number(status.total_count ?? (Array.isArray(status.statuses) ? status.statuses.length : NaN));
    return Number.isFinite(count) && count > 0 ? `${status.state} (${count})` : status.state;
}

function cleanRawUrl(rawUrl) {
    return String(rawUrl || '').trim().replace(/[.,;:!?]+$/g, '');
}

function pathSegments(url) {
    return url.pathname.split('/').filter(Boolean).map(segment => {
        try {
            return decodeURIComponent(segment);
        } catch {
            return segment;
        }
    });
}

function isValidOwner(owner) {
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner || '');
}

function isValidRepo(repo) {
    return /^[A-Za-z0-9._-]{1,100}$/.test(repo || '');
}

function isNumericId(value) {
    return /^[1-9][0-9]*$/.test(value || '');
}

function isShaLike(value) {
    return /^[A-Fa-f0-9]{6,40}$/.test(value || '');
}

function parseGistUrl(url) {
    const parts = pathSegments(url);
    const id = parts.length >= 2 ? parts[1] : parts[0];
    if (!id || !/^[A-Fa-f0-9]+$/.test(id)) return null;
    const owner = parts.length >= 2 ? parts[0] : '';
    return {
        type: 'gist',
        id,
        owner,
        canonicalUrl: owner
            ? `https://gist.github.com/${owner}/${id}`
            : `https://gist.github.com/${id}`,
    };
}

function parseGitHubUrl(rawUrl) {
    let url;
    try {
        url = new URL(cleanRawUrl(rawUrl));
    } catch {
        return null;
    }

    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'gist.github.com') return parseGistUrl(url);
    if (host !== 'github.com') return null;

    const parts = pathSegments(url);
    if (parts.length === 0) return null;

    const owner = parts[0];
    if (!isValidOwner(owner)) return null;
    if (parts.length === 1) {
        if (RESERVED_TOP_LEVEL_PATHS.has(owner.toLowerCase())) return null;
        return {
            type: 'user',
            login: owner,
            canonicalUrl: `https://github.com/${owner}`,
        };
    }

    const repo = parts[1];
    if (!isValidRepo(repo)) return null;
    const base = {
        owner,
        repo,
        canonicalUrl: `https://github.com/${owner}/${repo}`,
    };

    const section = (parts[2] || '').toLowerCase();
    if (!section) return { type: 'repo', ...base };

    if (section === 'issues' && isNumericId(parts[3])) {
        return { type: 'issue', ...base, number: Number(parts[3]), canonicalUrl: `${base.canonicalUrl}/issues/${parts[3]}` };
    }
    if (section === 'pull' && isNumericId(parts[3])) {
        return { type: 'pull', ...base, number: Number(parts[3]), canonicalUrl: `${base.canonicalUrl}/pull/${parts[3]}` };
    }
    if ((section === 'commit' || section === 'commits') && isShaLike(parts[3])) {
        return { type: 'commit', ...base, sha: parts[3], canonicalUrl: `${base.canonicalUrl}/commit/${parts[3]}` };
    }
    if (section === 'releases' && parts[3]?.toLowerCase() === 'latest') {
        return { type: 'release', ...base, latest: true, canonicalUrl: `${base.canonicalUrl}/releases/latest` };
    }
    if (section === 'releases' && parts[3]?.toLowerCase() === 'tag' && parts[4]) {
        const tag = parts.slice(4).join('/');
        return { type: 'release', ...base, tag, canonicalUrl: `${base.canonicalUrl}/releases/tag/${parts.slice(4).map(encodeURIComponent).join('/')}` };
    }
    if ((section === 'blob' || section === 'tree') && parts[3]) {
        return {
            type: section,
            ...base,
            ref: parts[3],
            path: parts.slice(4).join('/'),
            canonicalUrl: `${base.canonicalUrl}/${section}/${parts.slice(3).map(encodeURIComponent).join('/')}`,
        };
    }

    return { type: 'repo', ...base };
}

function encodePathPart(value) {
    return encodeURIComponent(String(value));
}

function apiUrl(path) {
    return `https://api.github.com${path}`;
}

function githubHeaders() {
    const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ComebackTwitterEmbed/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

async function fetchJson(url) {
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) {
        const err = Object.assign(new Error(`github api ${res.status} for ${url}`), { status: res.status });
        throw err;
    }
    return await res.json();
}

async function fetchOptionalJson(url) {
    try {
        return await fetchJson(url);
    } catch {
        return null;
    }
}

async function fetchOptionalBuffer(url) {
    try {
        const res = await fetch(url, {
            headers: {
                Accept: 'image/png,image/*;q=0.9,*/*;q=0.8',
                'User-Agent': 'ComebackTwitterEmbed/1.0',
            },
        });
        if (!res.ok || typeof res.buffer !== 'function') return null;
        return await res.buffer();
    } catch {
        return null;
    }
}

async function fetchOptionalImageBuffer(urls) {
    for (const url of urls.filter(Boolean)) {
        const buffer = await fetchOptionalBuffer(url);
        if (buffer && decodeRasterImage(buffer)) return buffer;
    }
    return null;
}

async function fetchText(url) {
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) {
        const err = Object.assign(new Error(`github page ${res.status} for ${url}`), { status: res.status });
        throw err;
    }
    return await res.text();
}

function htmlDecode(value) {
    return String(value ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function extractAttr(tag, attrName) {
    const re = new RegExp(`\\b${attrName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = String(tag || '').match(re);
    return match ? htmlDecode(match[2] || match[3] || match[4] || '') : '';
}

function dateMs(dateText) {
    const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return NaN;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function contributionDayOfWeek(dateText) {
    const ms = dateMs(dateText);
    if (!Number.isFinite(ms)) return 0;
    return new Date(ms).getUTCDay();
}

function parseContributionCalendar(html) {
    const cells = [];
    const dayRe = /<td\b[^>]*\bContributionCalendar-day\b[^>]*>/gi;
    let match;
    while ((match = dayRe.exec(html)) !== null) {
        const tag = match[0];
        const date = extractAttr(tag, 'data-date');
        if (!date) continue;
        const level = Math.max(0, Math.min(4, Number(extractAttr(tag, 'data-level')) || 0));
        cells.push({ date, level });
    }
    if (cells.length === 0) return null;

    const times = cells.map(cell => dateMs(cell.date)).filter(Number.isFinite);
    if (times.length === 0) return null;
    const fromMs = Math.min(...times);
    const toMs = Math.max(...times);
    const totalMatch = String(html).match(/<h2\b[^>]*id=["']js-contribution-activity-description["'][^>]*>([\s\S]*?)<\/h2>/i);
    const totalText = totalMatch ? totalMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const total = Number((totalText.match(/\d[\d,]*/) || [''])[0].replace(/,/g, ''));

    return {
        cells,
        fromDate: new Date(fromMs).toISOString().slice(0, 10),
        toDate: new Date(toMs).toISOString().slice(0, 10),
        total: Number.isFinite(total) ? total : null,
    };
}

async function fetchContributionCalendar(login) {
    const url = `https://github.com/users/${encodeURIComponent(login)}/contributions`;
    const html = await fetchText(url);
    return parseContributionCalendar(html);
}

async function fetchGitHubData(parsed, settings = {}) {
    const owner = parsed.owner ? encodePathPart(parsed.owner) : '';
    const repo = parsed.repo ? encodePathPart(parsed.repo) : '';
    const repoPath = `/repos/${owner}/${repo}`;

    if (parsed.type === 'repo') {
        const repoData = await fetchJson(apiUrl(repoPath));
        const [commitActivity, recentCommits, languages] = await Promise.all([
            fetchOptionalJson(apiUrl(`${repoPath}/stats/commit_activity`)),
            fetchOptionalJson(apiUrl(`${repoPath}/commits?per_page=100`)),
            fetchOptionalJson(apiUrl(`${repoPath}/languages`)),
        ]);
        const ownerLogin = repoData.owner?.login;
        const ownerAvatar = await fetchOptionalImageBuffer([
            repoData.owner?.avatar_url
                ? `${repoData.owner.avatar_url}${repoData.owner.avatar_url.includes('?') ? '&' : '?'}s=180`
                : null,
            ownerLogin ? `https://github.com/${encodeURIComponent(ownerLogin)}.png?size=180` : null,
        ]);
        const statsCalendar = commitActivityToCalendar(commitActivity);
        const commitsCalendar = recentCommitsToCalendar(recentCommits);
        const commitActivityCalendar = (statsCalendar?.total > 0 ? statsCalendar : commitsCalendar) || statsCalendar;
        return {
            ...repoData,
            commitActivity: Array.isArray(commitActivity) ? commitActivity : null,
            recentCommits: Array.isArray(recentCommits) ? recentCommits : null,
            commitActivityCalendar,
            ownerAvatar,
            languages: languages && !Array.isArray(languages) && typeof languages === 'object' ? languages : null,
        };
    }
    if (parsed.type === 'user') {
        const profile = await fetchJson(apiUrl(`/users/${encodePathPart(parsed.login)}`));
        const contributions = await fetchContributionCalendar(parsed.login).catch(() => null);
        return { ...profile, contributions };
    }
    if (parsed.type === 'issue') return await fetchJson(apiUrl(`${repoPath}/issues/${parsed.number}`));
    if (parsed.type === 'pull') {
        const pull = await fetchJson(apiUrl(`${repoPath}/pulls/${parsed.number}`));
        const headSha = pull?.head?.sha;
        if (headSha && shouldShowOutputItem(settings, 'checks')) {
            const status = await fetchOptionalJson(apiUrl(`${repoPath}/commits/${encodePathPart(headSha)}/status`));
            if (status) pull.status = status;
        }
        return pull;
    }
    if (parsed.type === 'commit') return await fetchJson(apiUrl(`${repoPath}/commits/${encodePathPart(parsed.sha)}`));
    if (parsed.type === 'release') {
        if (parsed.latest) return await fetchJson(apiUrl(`${repoPath}/releases/latest`));
        return await fetchJson(apiUrl(`${repoPath}/releases/tags/${encodePathPart(parsed.tag)}`));
    }
    if (parsed.type === 'blob' || parsed.type === 'tree') {
        const contentPath = parsed.path
            ? parsed.path.split('/').map(encodePathPart).join('/')
            : '';
        const suffix = contentPath ? `/${contentPath}` : '';
        const ref = parsed.ref ? `?ref=${encodeURIComponent(parsed.ref)}` : '';
        return await fetchJson(apiUrl(`${repoPath}/contents${suffix}${ref}`));
    }
    if (parsed.type === 'gist') return await fetchJson(apiUrl(`/gists/${encodePathPart(parsed.id)}`));
    return null;
}

function buildBaseEmbed(message, settings, lang, color = GITHUB_COLOR) {
    return {
        color,
        footer: {
            text: requesterFooter(message, lang, settings?.anonymous_expand === true),
            icon_url: GITHUB_ICON,
        },
    };
}

function repoName(data, parsed) {
    return data.full_name || `${parsed.owner}/${parsed.repo}`;
}

function buildRepoEmbed(data, parsed, message, settings, lang) {
    const fields = [];
    if (shouldShowOutputItem(settings, 'repo_stats')) {
        addField(fields, tr(STR.stars, lang), formatNumber(data.stargazers_count));
        addField(fields, tr(STR.forks, lang), formatNumber(data.forks_count));
        addField(fields, tr(STR.issues, lang), formatNumber(data.open_issues_count));
    }
    addVisibleField(fields, settings, 'language', tr(STR.language, lang), data.language);
    addVisibleField(fields, settings, 'language_breakdown', tr(STR.languageBreakdown, lang), languageBreakdown(data.languages), false);
    addVisibleField(fields, settings, 'topics', tr(STR.topics, lang), topicSummary(data), false);
    addVisibleField(fields, settings, 'default_branch', tr(STR.defaultBranch, lang), data.default_branch);
    addVisibleField(fields, settings, 'last_push', tr(STR.lastPush, lang), discordDate(data.pushed_at));
    addVisibleField(fields, settings, 'license', tr(STR.license, lang), data.license?.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? data.license.spdx_id : data.license?.name);

    /** @type {any} */
    const embed = {
        ...buildBaseEmbed(message, settings, lang),
        author: {
            name: data.owner?.login || parsed.owner,
            url: data.owner?.html_url || `https://github.com/${parsed.owner}`,
            icon_url: data.owner?.avatar_url || undefined,
        },
        title: repoName(data, parsed),
        url: data.html_url || parsed.canonicalUrl,
        description: bodySummary(data.description),
        fields,
        timestamp: data.pushed_at ? new Date(data.pushed_at) : undefined,
    };
    if (data.owner?.avatar_url) embed.thumbnail = { url: data.owner.avatar_url };
    return embed;
}

function buildIssueEmbed(data, parsed, message, settings, lang) {
    const fields = [];
    addVisibleField(fields, settings, 'state', tr(STR.state, lang), stateText(data), true);
    addVisibleField(fields, settings, 'comments', tr(STR.comments, lang), formatNumber(data.comments), true);
    const labels = Array.isArray(data.labels) ? data.labels.map(label => label.name).filter(Boolean).join(', ') : '';
    addVisibleField(fields, settings, 'labels', tr(STR.labels, lang), labels, false);
    const assignees = Array.isArray(data.assignees) ? data.assignees.map(user => user.login).filter(Boolean).join(', ') : '';
    addVisibleField(fields, settings, 'assignees', tr(STR.assignees, lang), assignees, false);

    return {
        ...buildBaseEmbed(message, settings, lang, stateColor(data)),
        author: {
            name: data.user?.login || parsed.owner,
            url: data.user?.html_url || undefined,
            icon_url: data.user?.avatar_url || undefined,
        },
        title: `#${parsed.number} ${data.title || 'GitHub issue'}`,
        url: data.html_url || parsed.canonicalUrl,
        description: bodySummary(data.body),
        fields,
        timestamp: data.updated_at ? new Date(data.updated_at) : undefined,
    };
}

function buildPullEmbed(data, parsed, message, settings, lang) {
    const fields = [];
    addVisibleField(fields, settings, 'state', tr(STR.state, lang), stateText(data, true), true);
    addVisibleField(fields, settings, 'changes', tr(STR.changes, lang), `+${formatNumber(data.additions)} / -${formatNumber(data.deletions)}`, true);
    addVisibleField(fields, settings, 'commits', tr(STR.commits, lang), formatNumber(data.commits), true);
    addVisibleField(fields, settings, 'files', tr(STR.files, lang), formatNumber(data.changed_files), true);
    addVisibleField(fields, settings, 'comments', tr(STR.comments, lang), formatNumber((data.comments || 0) + (data.review_comments || 0)), true);
    addVisibleField(fields, settings, 'mergeable', tr(STR.mergeable, lang), mergeableText(data), true);
    addVisibleField(fields, settings, 'review_state', tr(STR.reviewState, lang), reviewStateText(data), true);
    addVisibleField(fields, settings, 'checks', tr(STR.checks, lang), checksText(data), true);

    return {
        ...buildBaseEmbed(message, settings, lang, stateColor(data, true)),
        author: {
            name: data.user?.login || parsed.owner,
            url: data.user?.html_url || undefined,
            icon_url: data.user?.avatar_url || undefined,
        },
        title: `#${parsed.number} ${data.title || 'GitHub pull request'}`,
        url: data.html_url || parsed.canonicalUrl,
        description: bodySummary(data.body),
        fields,
        timestamp: data.updated_at ? new Date(data.updated_at) : undefined,
    };
}

function buildCommitEmbed(data, parsed, message, settings, lang) {
    const messageText = data.commit?.message || '';
    const fields = [];
    addVisibleField(fields, settings, 'sha', tr(STR.sha, lang), data.sha || parsed.sha);
    addVisibleField(fields, settings, 'author', tr(STR.author, lang), data.author?.login || data.commit?.author?.name);
    addVisibleField(fields, settings, 'files', tr(STR.files, lang), formatNumber(Array.isArray(data.files) ? data.files.length : undefined));
    if (data.stats) {
        addVisibleField(fields, settings, 'changes', tr(STR.changes, lang), `+${formatNumber(data.stats.additions)} / -${formatNumber(data.stats.deletions)}`);
    }

    return {
        ...buildBaseEmbed(message, settings, lang),
        author: {
            name: data.author?.login || data.commit?.author?.name || parsed.owner,
            url: data.author?.html_url || undefined,
            icon_url: data.author?.avatar_url || undefined,
        },
        title: firstLine(messageText) || `Commit ${String(data.sha || parsed.sha).slice(0, 7)}`,
        url: data.html_url || parsed.canonicalUrl,
        description: bodySummary(messageText.split(/\r?\n/).slice(1).join('\n')),
        fields,
        timestamp: data.commit?.author?.date ? new Date(data.commit.author.date) : undefined,
    };
}

function buildReleaseEmbed(data, parsed, message, settings, lang) {
    const fields = [];
    addVisibleField(fields, settings, 'tag', tr(STR.tag, lang), data.tag_name || parsed.tag);
    addVisibleField(fields, settings, 'state', tr(STR.state, lang), data.draft ? 'draft' : data.prerelease ? 'prerelease' : 'published');
    addVisibleField(fields, settings, 'assets', tr(STR.assets, lang), formatNumber(Array.isArray(data.assets) ? data.assets.length : undefined));

    return {
        ...buildBaseEmbed(message, settings, lang),
        author: {
            name: data.author?.login || parsed.owner,
            url: data.author?.html_url || undefined,
            icon_url: data.author?.avatar_url || undefined,
        },
        title: data.name || data.tag_name || 'GitHub release',
        url: data.html_url || parsed.canonicalUrl,
        description: bodySummary(data.body),
        fields,
        timestamp: data.published_at ? new Date(data.published_at) : undefined,
    };
}

function directoryListing(items) {
    if (!Array.isArray(items)) return '';
    return items
        .slice(0, 12)
        .map(item => `${item.type === 'dir' ? '[dir]' : '[file]'} ${item.name}`)
        .join('\n');
}

function codeFenceLanguage(path) {
    const ext = String(path || '').split('.').pop()?.toLowerCase();
    const map = {
        js: 'js',
        jsx: 'jsx',
        ts: 'ts',
        tsx: 'tsx',
        py: 'py',
        rb: 'rb',
        go: 'go',
        rs: 'rust',
        java: 'java',
        css: 'css',
        html: 'html',
        md: 'md',
        json: 'json',
        yml: 'yaml',
        yaml: 'yaml',
        toml: 'toml',
        sh: 'sh',
    };
    return map[ext] || '';
}

function hasUnsupportedControlChars(value) {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
    }
    return false;
}

function fileSnippet(item, parsed, settings) {
    if (!shouldShowOutputItem(settings, 'snippet')) return '';
    if (!item || item.type !== 'file' || item.encoding !== 'base64' || !item.content) return '';
    let text = '';
    try {
        text = Buffer.from(String(item.content).replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
        return '';
    }
    if (!text || hasUnsupportedControlChars(text)) return '';
    const lines = text.replace(/\r\n/g, '\n').split('\n').slice(0, 8).join('\n').trimEnd();
    if (!lines) return '';
    const lang = codeFenceLanguage(item.name || parsed.path);
    return truncate('```' + lang + '\n' + lines + '\n```', DESCRIPTION_MAX_LENGTH);
}

function buildContentEmbed(data, parsed, message, settings, lang) {
    const isDirectory = Array.isArray(data);
    const item = isDirectory ? null : data;
    const fields = [];
    addVisibleField(fields, settings, 'type', tr(STR.type, lang), isDirectory ? 'directory' : item?.type);
    addVisibleField(fields, settings, 'files', tr(STR.files, lang), isDirectory ? formatNumber(data.length) : undefined);
    addVisibleField(fields, settings, 'size', tr(STR.size, lang), item?.type === 'file' ? formatBytes(item.size) : undefined);

    const titlePath = parsed.path || parsed.ref || repoName({}, parsed);
    /** @type {any} */
    const embed = {
        ...buildBaseEmbed(message, settings, lang),
        title: titlePath,
        url: item?.html_url || parsed.canonicalUrl,
        description: isDirectory ? directoryListing(data) : fileSnippet(item, parsed, settings) || undefined,
        fields,
    };
    return embed;
}

function buildUserEmbed(data, parsed, message, settings, lang) {
    const fields = [];
    addVisibleField(fields, settings, 'type', tr(STR.type, lang), data.type);
    addVisibleField(fields, settings, 'repositories', tr(STR.repositories, lang), formatNumber(data.public_repos));
    addVisibleField(fields, settings, 'followers', tr(STR.followers, lang), formatNumber(data.followers));
    addVisibleField(fields, settings, 'location', tr(STR.location, lang), data.location);
    addVisibleField(fields, settings, 'contributions', tr(STR.contributions, lang), formatNumber(data.contributions?.total));

    /** @type {any} */
    const embed = {
        ...buildBaseEmbed(message, settings, lang),
        author: {
            name: data.login || parsed.login,
            url: data.html_url || parsed.canonicalUrl,
            icon_url: data.avatar_url || undefined,
        },
        title: data.name || data.login || parsed.login,
        url: data.html_url || parsed.canonicalUrl,
        description: bodySummary(data.bio),
        fields,
        timestamp: data.updated_at ? new Date(data.updated_at) : undefined,
    };
    if (data.avatar_url) embed.thumbnail = { url: data.avatar_url };
    return embed;
}

function buildGistEmbed(data, parsed, message, settings, lang) {
    const files = Object.values(data.files || {});
    const fields = [];
    addVisibleField(fields, settings, 'gist_files', tr(STR.gistFiles, lang), files.map(file => file.filename).filter(Boolean).join('\n'), false);
    addVisibleField(fields, settings, 'comments', tr(STR.comments, lang), formatNumber(data.comments));
    addVisibleField(fields, settings, 'state', tr(STR.state, lang), data.public === false ? 'secret' : 'public');

    return {
        ...buildBaseEmbed(message, settings, lang),
        author: {
            name: data.owner?.login || parsed.owner || 'GitHub Gist',
            url: data.owner?.html_url || undefined,
            icon_url: data.owner?.avatar_url || undefined,
        },
        title: data.description || `Gist ${parsed.id.slice(0, 8)}`,
        url: data.html_url || parsed.canonicalUrl,
        description: bodySummary(firstLine(files[0]?.content)),
        fields,
        timestamp: data.updated_at ? new Date(data.updated_at) : undefined,
    };
}

function colorToRgba(hex) {
    const value = String(hex || '').replace(/^#/, '');
    const n = parseInt(value.length === 3
        ? value.split('').map(ch => ch + ch).join('')
        : value, 16);
    return [
        (n >> 16) & 0xff,
        (n >> 8) & 0xff,
        n & 0xff,
        0xff,
    ];
}

function createPixelBuffer(width, height, color) {
    const pixels = Buffer.alloc(width * height * 4);
    const rgba = colorToRgba(color);
    for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = rgba[0];
        pixels[i + 1] = rgba[1];
        pixels[i + 2] = rgba[2];
        pixels[i + 3] = rgba[3];
    }
    return pixels;
}

function setPixel(pixels, width, height, x, y, color) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    const rgba = Array.isArray(color) ? color : colorToRgba(color);
    pixels[offset] = rgba[0];
    pixels[offset + 1] = rgba[1];
    pixels[offset + 2] = rgba[2];
    pixels[offset + 3] = rgba[3];
}

function fillRect(pixels, width, height, x, y, rectWidth, rectHeight, color) {
    const rgba = colorToRgba(color);
    for (let py = y; py < y + rectHeight; py++) {
        for (let px = x; px < x + rectWidth; px++) {
            setPixel(pixels, width, height, px, py, rgba);
        }
    }
}

function fillRoundedRect(pixels, width, height, x, y, rectWidth, rectHeight, radius, color) {
    const rgba = colorToRgba(color);
    for (let py = 0; py < rectHeight; py++) {
        for (let px = 0; px < rectWidth; px++) {
            const inTop = py < radius;
            const inBottom = py >= rectHeight - radius;
            const inLeft = px < radius;
            const inRight = px >= rectWidth - radius;
            if ((inTop && inLeft && (radius - px) ** 2 + (radius - py) ** 2 > radius ** 2)
                || (inTop && inRight && (px - (rectWidth - radius - 1)) ** 2 + (radius - py) ** 2 > radius ** 2)
                || (inBottom && inLeft && (radius - px) ** 2 + (py - (rectHeight - radius - 1)) ** 2 > radius ** 2)
                || (inBottom && inRight && (px - (rectWidth - radius - 1)) ** 2 + (py - (rectHeight - radius - 1)) ** 2 > radius ** 2)) {
                continue;
            }
            setPixel(pixels, width, height, x + px, y + py, rgba);
        }
    }
}

function drawText(pixels, width, height, text, x, y, color, scale = 2) {
    let cursorX = x;
    const rgba = colorToRgba(color);
    for (const rawChar of String(text || '')) {
        const glyph = FONT_5X7[rawChar.toUpperCase()] || FONT_5X7[' '];
        for (let gy = 0; gy < glyph.length; gy++) {
            for (let gx = 0; gx < glyph[gy].length; gx++) {
                if (glyph[gy][gx] !== '1') continue;
                fillRect(pixels, width, height, cursorX + gx * scale, y + gy * scale, scale, scale, color);
            }
        }
        cursorX += (5 + 1) * scale;
        void rgba;
    }
}

function crc32(buffer) {
    if (!crc32Table) {
        crc32Table = Array.from({ length: 256 }, (_value, index) => {
            let c = index;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            return c >>> 0;
        });
    }
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodePng(width, height, pixels) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;  // bit depth
    header[9] = 6;  // RGBA
    header[10] = 0; // compression
    header[11] = 0; // filter
    header[12] = 0; // interlace

    const stride = width * 4;
    const scanlines = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        scanlines[y * (stride + 1)] = 0;
        pixels.copy(scanlines, y * (stride + 1) + 1, y * stride, y * stride + stride);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(scanlines)),
        pngChunk('IEND'),
    ]);
}

function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

function decodePng(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 33) return null;
    if (buffer.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat = [];
    let pos = 8;

    while (pos + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(pos);
        const type = buffer.slice(pos + 4, pos + 8).toString('ascii');
        const data = buffer.slice(pos + 8, pos + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        pos += length + 12;
    }

    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
    if (!width || !height || bitDepth !== 8 || interlace !== 0 || channels === 0 || idat.length === 0) return null;

    const inflated = zlib.inflateSync(Buffer.concat(idat));
    const rowBytes = width * channels;
    const rgba = Buffer.alloc(width * height * 4);
    const previous = Buffer.alloc(rowBytes);
    const current = Buffer.alloc(rowBytes);
    let offset = 0;

    for (let y = 0; y < height; y++) {
        const filter = inflated[offset++];
        inflated.copy(current, 0, offset, offset + rowBytes);
        offset += rowBytes;

        for (let x = 0; x < rowBytes; x++) {
            const left = x >= channels ? current[x - channels] : 0;
            const up = previous[x] || 0;
            const upLeft = x >= channels ? previous[x - channels] || 0 : 0;
            if (filter === 1) current[x] = (current[x] + left) & 0xff;
            else if (filter === 2) current[x] = (current[x] + up) & 0xff;
            else if (filter === 3) current[x] = (current[x] + Math.floor((left + up) / 2)) & 0xff;
            else if (filter === 4) current[x] = (current[x] + paethPredictor(left, up, upLeft)) & 0xff;
        }

        for (let x = 0; x < width; x++) {
            const src = x * channels;
            const dst = (y * width + x) * 4;
            if (channels === 1) {
                rgba[dst] = current[src];
                rgba[dst + 1] = current[src];
                rgba[dst + 2] = current[src];
                rgba[dst + 3] = 255;
            } else {
                rgba[dst] = current[src];
                rgba[dst + 1] = current[src + 1];
                rgba[dst + 2] = current[src + 2];
                rgba[dst + 3] = channels === 4 ? current[src + 3] : 255;
            }
        }
        current.copy(previous);
    }

    return { width, height, pixels: rgba };
}

function decodeJpeg(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    try {
        const image = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 128 });
        if (!image?.width || !image?.height || !image.data) return null;
        return { width: image.width, height: image.height, pixels: Buffer.from(image.data) };
    } catch {
        return null;
    }
}

function decodeRasterImage(buffer) {
    return decodePng(buffer) || decodeJpeg(buffer);
}

function blendPixel(pixels, width, height, x, y, rgba) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const alpha = rgba[3] / 255;
    const offset = (y * width + x) * 4;
    pixels[offset] = Math.round(rgba[0] * alpha + pixels[offset] * (1 - alpha));
    pixels[offset + 1] = Math.round(rgba[1] * alpha + pixels[offset + 1] * (1 - alpha));
    pixels[offset + 2] = Math.round(rgba[2] * alpha + pixels[offset + 2] * (1 - alpha));
    pixels[offset + 3] = 255;
}

function drawImageCoverCircle(pixels, width, height, image, x, y, size) {
    if (!image) return false;
    const scale = Math.max(size / image.width, size / image.height);
    const srcWidth = size / scale;
    const srcHeight = size / scale;
    const srcLeft = (image.width - srcWidth) / 2;
    const srcTop = (image.height - srcHeight) / 2;
    const radius = size / 2;
    const center = radius - 0.5;

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            const dx = px - center;
            const dy = py - center;
            if (dx * dx + dy * dy > radius * radius) continue;
            const sx = Math.max(0, Math.min(image.width - 1, Math.floor(srcLeft + px / scale)));
            const sy = Math.max(0, Math.min(image.height - 1, Math.floor(srcTop + py / scale)));
            const src = (sy * image.width + sx) * 4;
            blendPixel(pixels, width, height, x + px, y + py, [
                image.pixels[src],
                image.pixels[src + 1],
                image.pixels[src + 2],
                image.pixels[src + 3],
            ]);
        }
    }
    return true;
}

function calendarWeeks(calendar) {
    const fromMs = dateMs(calendar.fromDate);
    const toMs = dateMs(calendar.toDate);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 53;
    return Math.floor((toMs - fromMs) / (7 * 24 * 60 * 60 * 1000)) + 1;
}

function monthMarkers(calendar) {
    const fromMs = dateMs(calendar.fromDate);
    const toMs = dateMs(calendar.toDate);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [];
    const start = new Date(fromMs);
    const current = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    if (current.getTime() < fromMs) current.setUTCMonth(current.getUTCMonth() + 1);

    const out = [];
    while (current.getTime() <= toMs) {
        const week = Math.floor((current.getTime() - fromMs) / (7 * 24 * 60 * 60 * 1000));
        out.push({ label: MONTH_LABELS[current.getUTCMonth()], week: Math.max(0, week) });
        current.setUTCMonth(current.getUTCMonth() + 1);
    }
    return out;
}

function renderContributionCalendarPng(calendar) {
    if (!calendar || !Array.isArray(calendar.cells) || calendar.cells.length === 0) return null;

    const cell = 11;
    const gap = 4;
    const left = 56;
    const top = 34;
    const right = 94;
    const bottom = 40;
    const weeks = calendarWeeks(calendar);
    const gridWidth = weeks * (cell + gap) - gap;
    const gridHeight = 7 * (cell + gap) - gap;
    const width = left + gridWidth + right;
    const height = top + gridHeight + bottom;
    const pixels = createPixelBuffer(width, height, CONTRIBUTION_IMAGE_BACKGROUND);

    fillRoundedRect(pixels, width, height, 0, 0, width, height, 6, CONTRIBUTION_IMAGE_BORDER);
    fillRoundedRect(pixels, width, height, 1, 1, width - 2, height - 2, 5, CONTRIBUTION_IMAGE_BACKGROUND);

    for (const marker of monthMarkers(calendar)) {
        drawText(pixels, width, height, marker.label, left + marker.week * (cell + gap), 12, CONTRIBUTION_TEXT_COLOR, 2);
    }
    drawText(pixels, width, height, 'Mon', 12, top + 1 * (cell + gap) - 1, CONTRIBUTION_TEXT_COLOR, 2);
    drawText(pixels, width, height, 'Wed', 12, top + 3 * (cell + gap) - 1, CONTRIBUTION_TEXT_COLOR, 2);
    drawText(pixels, width, height, 'Fri', 12, top + 5 * (cell + gap) - 1, CONTRIBUTION_TEXT_COLOR, 2);

    const fromMs = dateMs(calendar.fromDate);
    for (const contribution of calendar.cells) {
        const ms = dateMs(contribution.date);
        if (!Number.isFinite(ms) || !Number.isFinite(fromMs)) continue;
        const week = Math.floor((ms - fromMs) / (7 * 24 * 60 * 60 * 1000));
        const day = contributionDayOfWeek(contribution.date);
        const x = left + week * (cell + gap);
        const y = top + day * (cell + gap);
        fillRoundedRect(pixels, width, height, x, y, cell, cell, 2, CONTRIBUTION_LEVEL_COLORS[contribution.level] || CONTRIBUTION_LEVEL_COLORS[0]);
    }

    const legendY = top + gridHeight + 16;
    const legendX = width - right - 70;
    drawText(pixels, width, height, 'Less', legendX, legendY, CONTRIBUTION_MUTED_TEXT_COLOR, 1);
    for (let level = 0; level < CONTRIBUTION_LEVEL_COLORS.length; level++) {
        fillRoundedRect(
            pixels,
            width,
            height,
            legendX + 30 + level * (cell + 5),
            legendY - 2,
            cell,
            cell,
            2,
            CONTRIBUTION_LEVEL_COLORS[level]
        );
    }
    drawText(pixels, width, height, 'More', legendX + 30 + CONTRIBUTION_LEVEL_COLORS.length * (cell + 5) + 4, legendY, CONTRIBUTION_MUTED_TEXT_COLOR, 1);

    return encodePng(width, height, pixels);
}

function contributionAttachmentName(login) {
    const safeLogin = String(login || 'profile').replace(/[^A-Za-z0-9_.-]/g, '_');
    return `github-contributions-${safeLogin}.png`;
}

function buildContributionAttachment(login, calendar) {
    const png = renderContributionCalendarPng(calendar);
    if (!png) return null;
    return {
        attachment: png,
        name: contributionAttachmentName(login),
    };
}

function commitActivityToCalendar(activity) {
    if (!Array.isArray(activity) || activity.length === 0) return null;
    const cells = [];
    let maxDayCount = 0;
    for (const week of activity) {
        if (!Number.isFinite(Number(week?.week)) || !Array.isArray(week.days)) continue;
        for (let day = 0; day < Math.min(7, week.days.length); day++) {
            const count = Math.max(0, Number(week.days[day]) || 0);
            maxDayCount = Math.max(maxDayCount, count);
            cells.push({
                date: new Date((Number(week.week) + day * 24 * 60 * 60) * 1000).toISOString().slice(0, 10),
                count,
                level: 0,
            });
        }
    }
    if (cells.length === 0) return null;
    for (const cell of cells) {
        cell.level = cell.count <= 0 || maxDayCount <= 0
            ? 0
            : Math.max(1, Math.min(4, Math.ceil((cell.count / maxDayCount) * 4)));
    }
    return {
        cells,
        fromDate: cells[0].date,
        toDate: cells[cells.length - 1].date,
        total: cells.reduce((sum, cell) => sum + cell.count, 0),
    };
}

function startOfUtcDay(ms) {
    const date = new Date(ms);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcWeek(ms) {
    const dayMs = 24 * 60 * 60 * 1000;
    const start = startOfUtcDay(ms);
    return start - new Date(start).getUTCDay() * dayMs;
}

function recentCommitsToCalendar(commits) {
    if (!Array.isArray(commits) || commits.length === 0) return null;
    const dayMs = 24 * 60 * 60 * 1000;
    const counts = new Map();
    let latestMs = 0;
    for (const item of commits) {
        const rawDate = item?.commit?.committer?.date || item?.commit?.author?.date;
        const ms = Date.parse(rawDate);
        if (!Number.isFinite(ms)) continue;
        const day = startOfUtcDay(ms);
        counts.set(day, (counts.get(day) || 0) + 1);
        latestMs = Math.max(latestMs, day);
    }
    if (!latestMs) return null;

    const startMs = startOfUtcWeek(latestMs - 52 * 7 * dayMs);
    const cells = [];
    let maxDayCount = 0;
    for (let offset = 0; offset < 53 * 7; offset++) {
        const ms = startMs + offset * dayMs;
        const count = counts.get(ms) || 0;
        maxDayCount = Math.max(maxDayCount, count);
        cells.push({
            date: new Date(ms).toISOString().slice(0, 10),
            count,
            level: 0,
        });
    }
    for (const cell of cells) {
        cell.level = cell.count <= 0 || maxDayCount <= 0
            ? 0
            : Math.max(1, Math.min(4, Math.ceil((cell.count / maxDayCount) * 4)));
    }
    return {
        cells,
        fromDate: cells[0].date,
        toDate: cells[cells.length - 1].date,
        total: cells.reduce((sum, cell) => sum + cell.count, 0),
    };
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

function textWidth(text, scale = 2) {
    if (!text) return 0;
    return String(text).length * 6 * scale;
}

function ellipsizeText(text, maxWidth, scale = 2) {
    const raw = String(text || '');
    if (textWidth(raw, scale) <= maxWidth) return raw;
    let out = raw;
    while (out.length > 0 && textWidth(out + '...', scale) > maxWidth) out = out.slice(0, -1);
    return out.trimEnd() + '...';
}

function fitTextScale(text, maxWidth, preferredScale, minScale = 2) {
    for (let scale = preferredScale; scale >= minScale; scale--) {
        if (textWidth(text, scale) <= maxWidth) return scale;
    }
    return minScale;
}

function wrapText(text, maxWidth, scale = 2, maxLines = 3) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (textWidth(candidate, scale) <= maxWidth) {
            current = candidate;
            continue;
        }
        if (current) lines.push(current);
        current = word;
        if (lines.length >= maxLines) break;
    }
    if (current && lines.length < maxLines) lines.push(current);
    if (lines.length > maxLines) lines.length = maxLines;
    if (lines.length === maxLines) {
        lines[maxLines - 1] = ellipsizeText(lines[maxLines - 1], maxWidth, scale);
    }
    return lines;
}

function mixHexColors(baseHex, overlayHex, overlayAmount) {
    const base = colorToRgba(baseHex);
    const overlay = colorToRgba(overlayHex);
    const amount = Math.max(0, Math.min(1, overlayAmount));
    const mixed = [0, 1, 2].map(index => Math.round(base[index] * (1 - amount) + overlay[index] * amount));
    return '#' + mixed.map(value => value.toString(16).padStart(2, '0')).join('');
}

function fadedHeatmapColor(level, weekIndex, totalWeeks) {
    const denominator = Math.max(1, totalWeeks - 1);
    const progress = Math.max(0, Math.min(1, weekIndex / denominator));
    const opacity = 0.48 * (1 - progress);
    return mixHexColors('#ffffff', CONTRIBUTION_LEVEL_COLORS[level] || CONTRIBUTION_LEVEL_COLORS[0], opacity);
}

function drawCommitHeatmapBackground(pixels, width, height, calendar, bandTop, bandHeight) {
    if (!calendar) return;
    const gap = Math.max(6, Math.round(bandHeight * 0.03));
    const cell = Math.max(11, Math.floor((bandHeight - gap * 6) / 7));
    const left = 0;
    const top = bandTop;
    const dayMs = 24 * 60 * 60 * 1000;
    const weekMs = 7 * dayMs;
    const toMs = dateMs(calendar.toDate);
    if (!Number.isFinite(toMs)) return;
    const targetWidth = Math.floor(width * REPO_CARD_HEATMAP_WIDTH_RATIO);
    const totalWeeks = Math.max(1, Math.round((targetWidth + gap) / (cell + gap)));
    const startMs = startOfUtcWeek(toMs - (totalWeeks - 1) * weekMs);
    for (const contribution of calendar.cells) {
        const ms = dateMs(contribution.date);
        if (!Number.isFinite(ms) || ms < startMs || ms > toMs) continue;
        const week = Math.floor((ms - startMs) / weekMs);
        const day = contributionDayOfWeek(contribution.date);
        const x = left + week * (cell + gap);
        const y = top + day * (cell + gap);
        if (x + cell > targetWidth || y + cell > top + bandHeight) continue;
        fillRoundedRect(pixels, width, height, x, y, cell, cell, 4, fadedHeatmapColor(contribution.level, week, totalWeeks));
    }
}

function drawLanguageBar(pixels, width, height, languages) {
    const barY = height - REPO_CARD_LANGUAGE_BAR_HEIGHT;
    if (!Array.isArray(languages) || languages.length === 0) {
        fillRect(pixels, width, height, 0, barY, width, REPO_CARD_LANGUAGE_BAR_HEIGHT, '#3572A5');
        return;
    }
    let x = 0;
    for (let i = 0; i < languages.length; i++) {
        const segmentWidth = i === languages.length - 1
            ? width - x
            : Math.max(1, Math.round(width * languages[i].ratio));
        fillRect(pixels, width, height, x, barY, segmentWidth, REPO_CARD_LANGUAGE_BAR_HEIGHT, languages[i].color);
        x += segmentWidth;
        if (x >= width) break;
    }
}

function drawRepoStats(pixels, width, height, data) {
    const stats = [
        { value: formatNumber(data.stargazers_count) || '0', label: 'Stars' },
        { value: formatNumber(data.forks_count) || '0', label: 'Forks' },
        { value: formatNumber(data.open_issues_count) || '0', label: 'Issues' },
        { value: formatNumber(data.commitActivityCalendar?.total) || '0', label: 'Commits' },
    ];
    const startX = 80;
    const y = 460;
    const gap = 180;
    for (let i = 0; i < stats.length; i++) {
        drawText(pixels, width, height, stats[i].value, startX + i * gap, y, CONTRIBUTION_TEXT_COLOR, 3);
        drawText(pixels, width, height, stats[i].label, startX + i * gap, y + 36, CONTRIBUTION_MUTED_TEXT_COLOR, 2);
    }
}

function drawOwnerAvatar(pixels, width, height, data) {
    const size = 170;
    const x = width - 80 - size;
    const y = 78;
    const avatar = decodeRasterImage(data.ownerAvatar);
    if (drawImageCoverCircle(pixels, width, height, avatar, x, y, size)) return;

    fillRoundedRect(pixels, width, height, x, y, size, size, 18, '#f6f8fa');
    fillRoundedRect(pixels, width, height, x + 4, y + 4, size - 8, size - 8, 14, '#ffffff');
    const initials = String(data.owner?.login || 'GH').slice(0, 2).toUpperCase();
    drawText(pixels, width, height, initials, x + 35, y + 57, '#8c9ab2', 8);
}

function renderRepoCardPng(data, parsed, settings) {
    const showLanguages = shouldShowOutputItem(settings, 'language');
    const languages = showLanguages ? normalizeLanguages(data.languages) : [];
    const calendar = data.commitActivityCalendar || commitActivityToCalendar(data.commitActivity);
    const width = REPO_CARD_WIDTH;
    const height = REPO_CARD_HEIGHT;
    const pixels = createPixelBuffer(width, height, '#ffffff');
    const repoFullName = repoName(data, parsed);
    const [owner, repo] = repoFullName.split('/');
    const repoTitle = repo || repoFullName;
    const description = data.description || `${repoTitle} on GitHub.`;
    const lines = wrapText(description, 690, 4, 3);
    const titleMaxWidth = Math.floor(width * REPO_CARD_HEATMAP_WIDTH_RATIO) - 80;
    const ownerLabel = `${owner || parsed.owner}/`;
    const ownerScale = fitTextScale(ownerLabel, titleMaxWidth, 8, 5);
    const repoScale = fitTextScale(repoTitle, titleMaxWidth, 9, 5);

    const titleBlockTop = 82;
    const descriptionTop = 316;
    const descriptionBottom = descriptionTop + (Math.max(1, lines.length) - 1) * 48 + 28;
    drawCommitHeatmapBackground(pixels, width, height, calendar, titleBlockTop, descriptionBottom - titleBlockTop);
    drawText(pixels, width, height, ellipsizeText(ownerLabel, titleMaxWidth, ownerScale), 80, 96, '#2f3742', ownerScale);
    drawText(pixels, width, height, ellipsizeText(repoTitle, titleMaxWidth, repoScale), 80, 190, '#24292f', repoScale);
    drawOwnerAvatar(pixels, width, height, data);

    for (let i = 0; i < lines.length; i++) {
        drawText(pixels, width, height, lines[i], 80, descriptionTop + i * 48, '#6e7781', 4);
    }

    drawRepoStats(pixels, width, height, { ...data, commitActivityCalendar: calendar });
    if (showLanguages && languages[0]) {
        drawText(pixels, width, height, languages[0].name, 880, 500, languages[0].color, 3);
    }
    drawText(pixels, width, height, 'GitHub', 980, 548, '#8c9ab2', 4);
    if (showLanguages) drawLanguageBar(pixels, width, height, languages);
    return encodePng(width, height, pixels);
}

function repoCardAttachmentName(data, parsed) {
    const safeName = repoName(data || {}, parsed).replace(/[^A-Za-z0-9_.-]/g, '_');
    return `github-repo-card-${safeName}.png`;
}

function buildRepoCardAttachment(data, parsed, settings) {
    if (!data || !parsed || parsed.type !== 'repo') return null;
    const png = renderRepoCardPng(data, parsed, settings);
    if (!png) return null;
    return {
        attachment: png,
        name: repoCardAttachmentName(data, parsed),
    };
}

function githubRepoCardStyle(settings) {
    if (!shouldShowOutputItem(settings, 'repo_card', { hideInCompact: false })) return 'none';
    return settings?.github_card_style === 'github' ? 'github' : 'generated';
}

function officialGitHubRepoCardUrl(parsed) {
    return `https://opengraph.githubassets.com/comebacktwitterembed/${encodePathPart(parsed.owner)}/${encodePathPart(parsed.repo)}`;
}

function buildRepoCardVisual(data, parsed, settings) {
    const style = githubRepoCardStyle(settings);
    if (style === 'none') return null;
    if (style === 'github') return { imageUrl: officialGitHubRepoCardUrl(parsed) };
    const attachment = buildRepoCardAttachment(data, parsed, settings);
    return attachment ? { attachment } : null;
}

function buildVisualAttachment(data, parsed, settings) {
    if (parsed.type === 'user' && data?.contributions) {
        const attachment = buildContributionAttachment(data.login || parsed.login, data.contributions);
        return attachment ? { attachment } : null;
    }
    if (parsed.type === 'repo') {
        return buildRepoCardVisual(data, parsed, settings);
    }
    return null;
}

function buildEmbed(data, parsed, message, settings, lang) {
    if (parsed.type === 'repo') return buildRepoEmbed(data, parsed, message, settings, lang);
    if (parsed.type === 'issue') return buildIssueEmbed(data, parsed, message, settings, lang);
    if (parsed.type === 'pull') return buildPullEmbed(data, parsed, message, settings, lang);
    if (parsed.type === 'commit') return buildCommitEmbed(data, parsed, message, settings, lang);
    if (parsed.type === 'release') return buildReleaseEmbed(data, parsed, message, settings, lang);
    if (parsed.type === 'blob' || parsed.type === 'tree') return buildContentEmbed(data, parsed, message, settings, lang);
    if (parsed.type === 'user') return buildUserEmbed(data, parsed, message, settings, lang);
    if (parsed.type === 'gist') return buildGistEmbed(data, parsed, message, settings, lang);
    return null;
}

function buildComponents(lang, openUrl) {
    return [
        {
            type: ComponentType.ActionRow,
            components: [
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setLabel(tr(STR.openButton, lang))
                    .setURL(openUrl),
            ],
        },
        {
            type: ComponentType.ActionRow,
            components: [
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Primary)
                    .setLabel(tr(STR.translateButton, lang))
                    .setCustomId('translate'),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Danger)
                    .setLabel(tr(STR.deleteButton, lang))
                    .setCustomId('delete:github'),
            ],
        },
    ];
}

function externalMediaUrlsFromStep(step) {
    const urls = [];
    for (const embed of step?.embeds || []) {
        if (/^https?:\/\//i.test(embed?.image?.url || '')) urls.push(embed.image.url);
        if (/^https?:\/\//i.test(embed?.thumbnail?.url || '')) urls.push(embed.thumbnail.url);
    }
    return urls;
}

function buildGitHubAnalytics(data, parsed) {
    const repo = data?.repository || data?.repo || data;
    const owner = parsed?.owner || repo?.owner?.login || repo?.owner;
    const name = parsed?.repo || repo?.name;
    const repoKey = [owner, name].filter(Boolean).join('/');
    const topics = Array.isArray(repo?.topics) ? repo.topics : [];
    return createProviderAnalytics({
        content: {
            accountKey: owner || repoKey,
            contentId: repoKey || parsed?.canonicalUrl,
            contentType: parsed?.kind || parsed?.type || 'repository',
            contentUrl: parsed?.canonicalUrl,
            title: repo?.full_name || repoKey || repo?.title,
            descriptionPreview: repo?.description || data?.body || data?.title,
            authorName: owner,
            publishedAtMs: Date.parse(repo?.created_at || data?.created_at || ''),
        },
        metrics: {
            stars: repo?.stargazers_count ?? repo?.stars,
            forks: repo?.forks_count ?? repo?.forks,
            watchers: repo?.watchers_count ?? repo?.subscribers_count,
            issues: repo?.open_issues_count ?? data?.comments,
            pull_requests: data?.commits ?? data?.changed_files,
        },
        facets: [
            facet('owner', owner),
            facet('language', repo?.language),
            facet('license', repo?.license?.spdx_id || repo?.license?.name),
            facet('state', data?.state),
            facet('type', parsed?.kind || parsed?.type || 'repository'),
            ...tagFacets('topics', topics),
        ],
    });
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, settings) {
    settings = settings || {};
    const parsed = parseGitHubUrl(url);
    if (!parsed) return null;

    let data;
    try {
        data = await fetchGitHubData(parsed, settings);
    } catch (err) {
        recordProviderError('github', err, message, url, { endpointKey: 'github/rest' });
        console.log(err);
        return buildFailureResponse('github', url, settings, err);
    }

    const lang = normalizeLang(settings);
    /** @type {any} */
    const embed = buildEmbed(data, parsed, message, settings, lang);
    if (!embed) return null;

    const bannedTarget = [
        embed.title,
        embed.description,
        ...(embed.fields || []).map(field => field.value),
    ].filter(Boolean).join('\n');
    if (containsBannedWord(bannedTarget, settings.bannedWords)) return null;

    const visualAttachment = buildVisualAttachment(data, parsed, settings);
    if (visualAttachment?.imageUrl) {
        embed.image = { url: visualAttachment.imageUrl };
    } else if (visualAttachment?.attachment) {
        embed.image = { url: `attachment://${visualAttachment.attachment.name}` };
    }

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [embed],
        files: visualAttachment?.attachment ? [visualAttachment.attachment] : [],
        components: buildComponents(lang, embed.url || parsed.canonicalUrl),
        allowedMentions: { repliedUser: false },
        send: settings.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
        analytics: buildGitHubAnalytics(data, parsed),
    };

    if (settings.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    }

    applyMediaDisplayToStep(step, settings, externalMediaUrlsFromStep(step), 'Image');
    return [step];
}

/** @type {import('../_types').Provider} */
const githubProvider = {
    id: 'github',
    enabledByDefault: false,
    urlPattern: GITHUB_URL_PATTERN,
    settings: [
        'bannedWords',
        'anonymous_expand',
        'alwaysreplyifpostedtweetlink',
        'deletemessageifonlypostedtweetlink',
        'display_density',
        'media_display_mode',
        'github_card_style',
        {
            key: 'hidden_output_items',
            outputItems: [
                { value: 'license', label: { en: 'License field', ja: 'License field' } },
                { value: 'state', label: { en: 'State field', ja: 'State field' } },
                { value: 'comments', label: { en: 'Comments field', ja: 'Comments field' } },
                { value: 'mergeable', label: { en: 'Mergeable field', ja: 'Mergeable field' } },
                { value: 'review_state', label: { en: 'Review state field', ja: 'Review state field' } },
                { value: 'checks', label: { en: 'Checks field', ja: 'Checks field' } },
                { value: 'labels', label: { en: 'Labels field', ja: 'Labels field' } },
                { value: 'assignees', label: { en: 'Assignees field', ja: 'Assignees field' } },
                { value: 'changes', label: { en: 'Changes field', ja: 'Changes field' } },
                { value: 'commits', label: { en: 'Commits field', ja: 'Commits field' } },
                { value: 'files', label: { en: 'Files field', ja: 'Files field' } },
                { value: 'sha', label: { en: 'SHA field', ja: 'SHA field' } },
                { value: 'author', label: { en: 'Author field', ja: 'Author field' } },
                { value: 'tag', label: { en: 'Tag field', ja: 'Tag field' } },
                { value: 'assets', label: { en: 'Assets field', ja: 'Assets field' } },
                { value: 'type', label: { en: 'Type field', ja: 'Type field' } },
                { value: 'size', label: { en: 'Size field', ja: 'Size field' } },
                { value: 'snippet', label: { en: 'File snippet', ja: 'File snippet' } },
                { value: 'repositories', label: { en: 'Repositories field', ja: 'Repositories field' } },
                { value: 'followers', label: { en: 'Followers field', ja: 'Followers field' } },
                { value: 'location', label: { en: 'Location field', ja: 'Location field' } },
                { value: 'contributions', label: { en: 'Contributions field', ja: 'Contributions field' } },
                { value: 'gist_files', label: { en: 'Gist files field', ja: 'Gist files field' } },
                { value: 'language_breakdown', label: { en: 'Language breakdown field', ja: 'Language breakdown field' } },
                { value: 'topics', label: { en: 'Topics field', ja: 'Topics field' } },
                { value: 'default_branch', label: { en: 'Default branch field', ja: 'Default branch field' } },
                { value: 'last_push', label: { en: 'Last push field', ja: 'Last push field' } },
                { value: 'repo_card', label: { en: 'Repository card image', ja: 'リポジトリカード画像' } },
                { value: 'language', label: { en: 'Language field/visual', ja: '言語欄/言語表示' } },
                { value: 'repo_stats', label: { en: 'Stars/forks/issues fields', ja: 'スター/フォーク/Issue欄' } },
            ],
        },
    ],
    extract,
};

module.exports = githubProvider;
module.exports._internal = {
    buildEmbed,
    cleanRawUrl,
    parseGitHubUrl,
    stateText,
};
