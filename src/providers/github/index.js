'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');

const GITHUB_COLOR = 0x24292f;
const GITHUB_OPEN_COLOR = 0x1a7f37;
const GITHUB_CLOSED_COLOR = 0xcf222e;
const GITHUB_MERGED_COLOR = 0x8250df;
const DESCRIPTION_MAX_LENGTH = 900;
const FIELD_MAX_LENGTH = 1024;
const GITHUB_ICON = 'https://github.githubassets.com/favicons/favicon.png';
const GITHUB_URL_PATTERN =
    /https?:\/\/(?:(?:www\.)?github\.com|gist\.github\.com)\/[^\s<>|]+/gi;

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
    license: { ja: 'License', en: 'License' },
    state: { ja: 'State', en: 'State' },
    comments: { ja: 'Comments', en: 'Comments' },
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
    followers: { ja: 'Followers', en: 'Followers' },
    repositories: { ja: 'Repositories', en: 'Repositories' },
    location: { ja: 'Location', en: 'Location' },
    gistFiles: { ja: 'Files', en: 'Files' },
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

function normalizeLang(settings) {
    return settings?.defaultLanguage === 'ja' ? 'ja' : 'en';
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
        const err = new Error(`github api ${res.status} for ${url}`);
        err.status = res.status;
        throw err;
    }
    return await res.json();
}

async function fetchGitHubData(parsed) {
    const owner = parsed.owner ? encodePathPart(parsed.owner) : '';
    const repo = parsed.repo ? encodePathPart(parsed.repo) : '';
    const repoPath = `/repos/${owner}/${repo}`;

    if (parsed.type === 'repo') return await fetchJson(apiUrl(repoPath));
    if (parsed.type === 'user') return await fetchJson(apiUrl(`/users/${encodePathPart(parsed.login)}`));
    if (parsed.type === 'issue') return await fetchJson(apiUrl(`${repoPath}/issues/${parsed.number}`));
    if (parsed.type === 'pull') return await fetchJson(apiUrl(`${repoPath}/pulls/${parsed.number}`));
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
    addField(fields, tr(STR.stars, lang), formatNumber(data.stargazers_count));
    addField(fields, tr(STR.forks, lang), formatNumber(data.forks_count));
    addField(fields, tr(STR.issues, lang), formatNumber(data.open_issues_count));
    addField(fields, tr(STR.language, lang), data.language);
    addField(fields, tr(STR.license, lang), data.license?.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? data.license.spdx_id : data.license?.name);

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
    addField(fields, tr(STR.state, lang), stateText(data), true);
    addField(fields, tr(STR.comments, lang), formatNumber(data.comments), true);
    const labels = Array.isArray(data.labels) ? data.labels.map(label => label.name).filter(Boolean).join(', ') : '';
    addField(fields, tr(STR.labels, lang), labels, false);
    const assignees = Array.isArray(data.assignees) ? data.assignees.map(user => user.login).filter(Boolean).join(', ') : '';
    addField(fields, tr(STR.assignees, lang), assignees, false);

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
    addField(fields, tr(STR.state, lang), stateText(data, true), true);
    addField(fields, tr(STR.changes, lang), `+${formatNumber(data.additions)} / -${formatNumber(data.deletions)}`, true);
    addField(fields, tr(STR.commits, lang), formatNumber(data.commits), true);
    addField(fields, tr(STR.files, lang), formatNumber(data.changed_files), true);
    addField(fields, tr(STR.comments, lang), formatNumber((data.comments || 0) + (data.review_comments || 0)), true);

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
    addField(fields, tr(STR.sha, lang), data.sha || parsed.sha);
    addField(fields, tr(STR.author, lang), data.author?.login || data.commit?.author?.name);
    addField(fields, tr(STR.files, lang), formatNumber(Array.isArray(data.files) ? data.files.length : undefined));
    if (data.stats) {
        addField(fields, tr(STR.changes, lang), `+${formatNumber(data.stats.additions)} / -${formatNumber(data.stats.deletions)}`);
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
    addField(fields, tr(STR.tag, lang), data.tag_name || parsed.tag);
    addField(fields, tr(STR.state, lang), data.draft ? 'draft' : data.prerelease ? 'prerelease' : 'published');
    addField(fields, tr(STR.assets, lang), formatNumber(Array.isArray(data.assets) ? data.assets.length : undefined));

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

function buildContentEmbed(data, parsed, message, settings, lang) {
    const isDirectory = Array.isArray(data);
    const item = isDirectory ? null : data;
    const fields = [];
    addField(fields, tr(STR.type, lang), isDirectory ? 'directory' : item?.type);
    addField(fields, tr(STR.files, lang), isDirectory ? formatNumber(data.length) : undefined);
    addField(fields, tr(STR.size, lang), item?.type === 'file' ? formatBytes(item.size) : undefined);

    const titlePath = parsed.path || parsed.ref || repoName({}, parsed);
    const embed = {
        ...buildBaseEmbed(message, settings, lang),
        title: titlePath,
        url: item?.html_url || parsed.canonicalUrl,
        description: isDirectory ? directoryListing(data) : undefined,
        fields,
    };
    return embed;
}

function buildUserEmbed(data, parsed, message, settings, lang) {
    const fields = [];
    addField(fields, tr(STR.type, lang), data.type);
    addField(fields, tr(STR.repositories, lang), formatNumber(data.public_repos));
    addField(fields, tr(STR.followers, lang), formatNumber(data.followers));
    addField(fields, tr(STR.location, lang), data.location);

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
    addField(fields, tr(STR.gistFiles, lang), files.map(file => file.filename).filter(Boolean).join('\n'), false);
    addField(fields, tr(STR.comments, lang), formatNumber(data.comments));
    addField(fields, tr(STR.state, lang), data.public === false ? 'secret' : 'public');

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

/** @type {import('../_types').Extractor} */
async function extract(message, url, settings) {
    settings = settings || {};
    const parsed = parseGitHubUrl(url);
    if (!parsed) return null;

    let data;
    try {
        data = await fetchGitHubData(parsed);
    } catch (err) {
        recordProviderError('github', err, message, url, { endpointKey: 'github/rest' });
        console.log(err);
        return null;
    }

    const lang = normalizeLang(settings);
    const embed = buildEmbed(data, parsed, message, settings, lang);
    if (!embed) return null;

    const bannedTarget = [
        embed.title,
        embed.description,
        ...(embed.fields || []).map(field => field.value),
    ].filter(Boolean).join('\n');
    if (containsBannedWord(bannedTarget, settings.bannedWords)) return null;

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [embed],
        components: buildComponents(lang, embed.url || parsed.canonicalUrl),
        allowedMentions: { repliedUser: false },
        send: settings.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
    };

    if (settings.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    }

    return [step];
}

/** @type {import('../_types').Provider} */
const githubProvider = {
    id: 'github',
    enabledByDefault: false,
    urlPattern: GITHUB_URL_PATTERN,
    extract,
};

module.exports = githubProvider;
module.exports._internal = {
    buildEmbed,
    cleanRawUrl,
    parseGitHubUrl,
    stateText,
};
