'use strict';

const { shouldShowOutputItem } = require('../_output_controls');
const { encodePathPart } = require('./urls');
const { commitActivityToCalendar, recentCommitsToCalendar } = require('./calendar');
const { decodeRasterImage } = require('./raster');
const { parseContributionCalendar } = require('./githubSourceParser');
const { githubRepoCardStyle } = require('./visuals');

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

// Bind the transport per provider load so consumers can supply an isolated client.
function createGitHubClient(fetch) {
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
            // Use the renderer's predicate so hidden/hosted cards need no local
            // activity or avatar data. The text breakdown is independent of the
            // generated card's language bar, including in compact mode.
            const generatedCard = githubRepoCardStyle(settings) === 'generated';
            const needsLanguages = shouldShowOutputItem(settings, 'language_breakdown')
                || (generatedCard && shouldShowOutputItem(settings, 'language'));
            const [commitActivity, recentCommits, languages] = await Promise.all([
                generatedCard ? fetchOptionalJson(apiUrl(`${repoPath}/stats/commit_activity`)) : null,
                generatedCard ? fetchOptionalJson(apiUrl(`${repoPath}/commits?per_page=100`)) : null,
                needsLanguages ? fetchOptionalJson(apiUrl(`${repoPath}/languages`)) : null,
            ]);
            const ownerLogin = repoData.owner?.login;
            const ownerAvatar = generatedCard ? await fetchOptionalImageBuffer([
                repoData.owner?.avatar_url
                    ? `${repoData.owner.avatar_url}${repoData.owner.avatar_url.includes('?') ? '&' : '?'}s=180`
                    : null,
                ownerLogin ? `https://github.com/${encodeURIComponent(ownerLogin)}.png?size=180` : null,
            ]) : null;
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

    return { fetchGitHubData };
}

module.exports = { createGitHubClient };
