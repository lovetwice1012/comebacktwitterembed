'use strict';

const { createProviderAnalytics, facet, tagFacets } = require('../../analytics/providerMetrics');

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

module.exports = { buildGitHubAnalytics };
