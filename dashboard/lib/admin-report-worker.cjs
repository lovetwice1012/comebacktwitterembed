'use strict';
/* global require, module, __dirname */
/* eslint @typescript-eslint/no-require-imports: off */

// Trusted repository modules only. This runtime does not start or import the Next server.
// Keep dashboard/node_modules (including TypeScript) installed in the report-worker release.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const dashboardRoot = path.resolve(__dirname, '..');
const cache = new Map();
const kinds = new Set(['overview', 'analytics', 'guild-preview', 'provider-preview']);

function load(filename) {
  const absolute = path.resolve(filename);
  if (!absolute.startsWith(dashboardRoot + path.sep)) throw new Error('Report module outside dashboard directory');
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const mod = new Module(absolute, module);
  mod.filename = absolute;
  mod.paths = Module._nodeModulePaths(path.dirname(absolute));
  cache.set(absolute, mod);
  const nativeRequire = Module.createRequire(absolute);
  mod.require = id => {
    if (id === 'server-only') return {};
    if (id.startsWith('@/') || id.startsWith('.')) {
      const base = id.startsWith('@/') ? path.join(dashboardRoot, id.slice(2)) : path.resolve(path.dirname(absolute), id);
      for (const ext of ['.ts', '.tsx', '']) {
        const candidate = base + ext;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && /\.tsx?$/.test(candidate)) return load(candidate);
      }
    }
    return nativeRequire(id);
  };
  try {
    const source = fs.readFileSync(absolute, 'utf8');
    const compiled = ts.transpileModule(source, { fileName: absolute, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } });
    mod._compile(compiled.outputText, absolute);
    if (absolute === path.join(__dirname, 'prisma.ts')) {
      // Only this isolated report runtime registers SQL. The wrapper holds an
      // exclusive transaction connection until cancellation and cleanup settle.
      const { wrapPrismaForReports } = require('../../src/adminSupport/reportQueries');
      mod.exports.prisma = wrapPrismaForReports(mod.exports.prisma);
    }
    return mod.exports;
  } catch (error) { cache.delete(absolute); throw error; }
}

async function buildReport(input = {}) {
  if (!kinds.has(input.kind)) throw new Error('Unsupported report kind');
  if (input.filters != null && (typeof input.filters !== 'object' || Array.isArray(input.filters))) throw new Error('Report filters must be an object');
  return load(path.join(__dirname, 'admin-data.ts')).buildAdminReportSnapshot(input.kind, input.filters || {});
}

module.exports = { buildReport };
