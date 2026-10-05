'use strict';

const { shouldShowOutputItem } = require('../_output_controls');
const { formatNumber, repoName, normalizeLanguages } = require('./metadata');
const { encodePathPart } = require('./urls');
const { dateMs, contributionDayOfWeek, calendarWeeks, monthMarkers, commitActivityToCalendar, startOfUtcWeek } = require('./calendar');
const { colorToRgba, createPixelBuffer, fillRect, fillRoundedRect, drawText, encodePng, decodeRasterImage, drawImageCoverCircle } = require('./raster');

const CONTRIBUTION_IMAGE_BACKGROUND = '#ffffff';

const CONTRIBUTION_IMAGE_BORDER = '#d0d7de';

const CONTRIBUTION_TEXT_COLOR = '#24292f';

const CONTRIBUTION_MUTED_TEXT_COLOR = '#57606a';

const CONTRIBUTION_LEVEL_COLORS = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];

const REPO_CARD_WIDTH = 1200;

const REPO_CARD_HEIGHT = 630;

const REPO_CARD_LANGUAGE_BAR_HEIGHT = 36;

const REPO_CARD_HEATMAP_WIDTH_RATIO = 0.75;

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

module.exports = { buildVisualAttachment, githubRepoCardStyle };
