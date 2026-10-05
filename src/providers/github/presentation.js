'use strict';

const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { shouldShowOutputItem } = require('../_output_controls');
const { formatNumber, repoName, normalizeLanguages } = require('./metadata');

const GITHUB_COLOR = 0x24292f;

const GITHUB_OPEN_COLOR = 0x1a7f37;

const GITHUB_CLOSED_COLOR = 0xcf222e;

const GITHUB_MERGED_COLOR = 0x8250df;

const DESCRIPTION_MAX_LENGTH = 900;

const FIELD_MAX_LENGTH = 1024;

const GITHUB_ICON = 'https://github.githubassets.com/favicons/favicon.png';

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

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

function truncate(value, maxLength = DESCRIPTION_MAX_LENGTH) {
    const text = String(value ?? '').trim();
    if (!text || text.length <= maxLength) return text;
    if (maxLength <= 3) return text.slice(0, maxLength);
    return text.slice(0, maxLength - 3).trimEnd() + '...';
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

function buildBaseEmbed(message, settings, lang, color = GITHUB_COLOR) {
    return {
        color,
        footer: {
            text: requesterFooter(message, lang, settings?.anonymous_expand === true),
            icon_url: GITHUB_ICON,
        },
    };
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

module.exports = { buildEmbed, buildComponents, stateText };
