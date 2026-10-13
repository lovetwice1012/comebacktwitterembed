'use strict';
// Read-only validation of the summary query against the live settings database.
// No credentials, raw settings or guild IDs are printed or saved.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const dashboard = process.env.UI_SUMMARY_STAGE + '/dashboard';
const localRequire = Module.createRequire(path.join(dashboard, 'package.json'));
const ts = localRequire('typescript');
const modules = new Map();
function load(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const mod = new Module(filename, module); modules.set(filename, mod); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire = Module.createRequire(filename);
  mod.require = id => {
    if (id === 'server-only') return {};
    if (id.startsWith('@/') || id.startsWith('.')) {
      const base = id.startsWith('@/') ? path.join(dashboard, id.slice(2)) : path.resolve(path.dirname(filename), id);
      for (const ext of ['', '.ts', '.tsx']) if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return load(base + ext);
    }
    return nativeRequire(id);
  };
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }, fileName: filename });
  mod._compile(compiled.outputText, filename); return mod.exports;
}
(async () => {
  const { prisma } = load(path.join(dashboard, 'lib/prisma.ts'));
  try {
    const { getVisibleGuildProviderSummaries } = load(path.join(dashboard, 'lib/guild-provider-summary.ts'));
    const { getProviderSummary } = load(path.join(dashboard, 'lib/settings-db.ts'));
    const samples = await prisma.$queryRawUnsafe('SELECT guild_id FROM guild_provider_settings GROUP BY guild_id ORDER BY guild_id LIMIT 3');
    const ids = samples.map(row => String(row.guild_id));
    if (!ids.length) throw new Error('No settings samples available for the read-only comparison');
    const started = performance.now();
    const summaries = await getVisibleGuildProviderSummaries(ids);
    const batchMilliseconds = performance.now() - started;
    const checks = [];
    for (const id of ids) {
      const existing = await getProviderSummary(id), actual = summaries.get(id);
      if (JSON.stringify(existing) !== JSON.stringify(actual)) throw new Error('Live summary differs from the existing settings contract');
      if (actual.total <= 0) throw new Error('Live provider registry unexpectedly empty');
      checks.push({ guildFingerprint: crypto.createHash('sha256').update(id).digest('hex').slice(0, 12), ...actual, matchesExistingSummary: true });
    }
    const report = { date: '2026-10-13', productionDBReadOnly: true, writes: 0, batchQueries: 1, batchMilliseconds, samples: checks };
    fs.writeFileSync(process.env.UI_SUMMARY_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await prisma.$disconnect(); }
})().catch(error => { console.error('Read-only summary comparison failed', error.code || error.name); process.exitCode = 1; });
