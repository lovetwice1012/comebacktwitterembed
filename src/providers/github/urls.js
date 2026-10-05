'use strict';

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

module.exports = { GITHUB_URL_PATTERN, cleanRawUrl, parseGitHubUrl, encodePathPart };
