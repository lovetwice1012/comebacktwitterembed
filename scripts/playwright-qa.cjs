'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadPlaywrightForQA() {
  const repo = path.resolve(__dirname, '..');
  const dependencies = path.join(repo, 'node_modules');
  let sharedRepo = repo;
  if (fs.existsSync(dependencies)) sharedRepo = path.dirname(fs.realpathSync(dependencies));
  // Preserve explicit browser settings; worktrees may reuse the existing QA
  // cache through their dependency junction without hardcoded host paths.
  if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) {
    const localCache = path.join(dependencies, '.cache', 'ux-browser');
    if (fs.existsSync(localCache)) process.env.PLAYWRIGHT_BROWSERS_PATH = localCache;
  }
  const override = process.env.PLAYWRIGHT_MODULE_PATH;
  const candidates = override
    ? [path.isAbsolute(override) || override.startsWith('.') ? path.resolve(override) : override]
    : ['playwright', 'playwright-core', path.join(repo, 'design-previews', 'qa', 'node_modules', 'playwright'), path.join(sharedRepo, 'design-previews', 'qa', 'node_modules', 'playwright')];
  for (const candidate of candidates) {
    let resolved;
    try { resolved = require.resolve(candidate); }
    catch (error) { if (error.code === 'MODULE_NOT_FOUND') continue; throw error; }
    const library = require(resolved);
    if (typeof library.chromium?.launch !== 'function') throw new Error('PLAYWRIGHT_MODULE_PATH must resolve to a Playwright module with Chromium support.');
    return library;
  }
  throw new Error('Manual browser QA needs an installed Playwright module. Set PLAYWRIGHT_MODULE_PATH to its package path and, if needed, PLAYWRIGHT_BROWSERS_PATH to its browser cache. No dependencies or browsers are downloaded by this helper.');
}

module.exports = { loadPlaywrightForQA };
