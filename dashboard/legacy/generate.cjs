/* Reproduce the verified live production presentation without copying auth/data code. */
/* global require, __dirname, process, console */
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node.js CommonJS executable. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ts = require("../node_modules/typescript");

const workspace = path.resolve(__dirname, "../..");
const sha256 = content => crypto.createHash("sha256").update(content).digest("hex");
const slash = value => value.replace(/\\/g, "/");
const sourceRoot = path.resolve(process.argv[2] || "C:/Users/yussy/AppData/Local/Temp/cbte-production-ui-20261013/source");
const sourceTarPath = path.resolve(sourceRoot, "../codex-dashboard-before-preview-20261013.tar.gz");
const expectedTarSha256 = "db08f056ebef96bb1f42be254dfc3427fe56ca3cbf8e3242cdce14bbb17ef14c";
if (sha256(fs.readFileSync(sourceTarPath)) !== expectedTarSha256) throw new Error("Production source archive SHA-256 does not match the verified snapshot");
const sourceManifestPath = path.join(__dirname, "production-source-manifest.json");
const capturedFiles = [];
function capture(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) capture(resolved);
    else if (entry.isFile()) capturedFiles.push({ path: slash(path.relative(sourceRoot, resolved)), sha256: sha256(fs.readFileSync(resolved)) });
  }
}
capture(path.join(sourceRoot, "dashboard"));
capturedFiles.sort((a, b) => a.path.localeCompare(b.path));
fs.writeFileSync(sourceManifestPath, JSON.stringify(capturedFiles, null, 2) + "\n");
const sourceManifest = new Map(capturedFiles.map(entry => [entry.path, entry.sha256]));
const previousManifestPath = path.join(__dirname, "legacy-manifest.json");
const previousManifest = fs.existsSync(previousManifestPath) ? JSON.parse(fs.readFileSync(previousManifestPath, "utf8")) : null;
const pageEntries = {
  "dashboard/app/page.tsx": ["pages/home.tsx", "LegacyHomePage"],
  "dashboard/app/dashboard/page.tsx": ["pages/dashboard.tsx", "LegacyDashboardPage"],
  "dashboard/app/dashboard/bulk/page.tsx": ["pages/bulk.tsx", "LegacyBulkPage"],
  "dashboard/app/dashboard/personal-links/page.tsx": ["pages/personal-links.tsx", "LegacyPersonalLinksPage"],
  "dashboard/app/dashboard/[guildId]/page.tsx": ["pages/guild-overview.tsx", "LegacyGuildOverviewPage"],
  "dashboard/app/dashboard/[guildId]/access/page.tsx": ["pages/guild-access.tsx", "LegacyGuildAccessPage"],
  "dashboard/app/dashboard/[guildId]/diagnostics/page.tsx": ["pages/guild-diagnostics.tsx", "LegacyGuildDiagnosticsPage"],
  "dashboard/app/dashboard/[guildId]/media/page.tsx": ["pages/guild-media.tsx", "LegacyGuildMediaPage"],
  "dashboard/app/dashboard/[guildId]/preview/page.tsx": ["pages/guild-preview.tsx", "LegacyGuildPreviewPage"],
  "dashboard/app/dashboard/[guildId]/providers/page.tsx": ["pages/guild-providers.tsx", "LegacyGuildProvidersPage"],
  "dashboard/app/dashboard/[guildId]/providers/[providerId]/page.tsx": ["pages/guild-provider-settings.tsx", "LegacyGuildProviderSettingsPage"],
  "dashboard/app/dashboard/[guildId]/settings/page.tsx": ["pages/guild-settings.tsx", "LegacyGuildSettingsPage"],
  "dashboard/app/admin/page.tsx": ["pages/admin.tsx", "LegacyAdminPage"],
  "dashboard/app/admin/support-console/page.tsx": ["pages/admin-support-console.tsx", "LegacyAdminSupportConsolePage"],
  "dashboard/app/admin/send-message/page.tsx": ["pages/admin-send-message.tsx", "LegacyAdminSendMessagePage"],
  "dashboard/app/admin/url-inspector/page.tsx": ["pages/admin-url-inspector.tsx", "LegacyAdminUrlInspectorPage"],
};
const roots = [...Object.keys(pageEntries), "dashboard/features/audit/audit-logs-page.tsx"];
const sharedContracts = new Set([
  "dashboard/lib/types.ts", "dashboard/lib/personal-links-types.ts",
]);
const graph = new Map();
const shared = new Map();
const missing = [];
const outsideSnapshotShared = new Map();

function sourceBytes(relative) {
  const bytes = fs.readFileSync(path.join(sourceRoot, relative));
  const expected = sourceManifest.get(relative);
  if (!expected || sha256(bytes) !== expected) throw new Error(`Snapshot provenance mismatch: ${relative}`);
  return bytes;
}

function resolveReference(from, specifier) {
  if (!specifier.startsWith("@/") && !specifier.startsWith(".")) return null;
  const relative = slash(specifier.startsWith("@/")
    ? path.posix.join("dashboard", specifier.slice(2))
    : path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
  const candidates = [relative, `${relative}.ts`, `${relative}.tsx`, `${relative}.js`, `${relative}.css`, `${relative}/index.ts`, `${relative}/index.tsx`];
  for (const candidate of candidates) {
    if (sourceManifest.has(candidate) && fs.existsSync(path.join(sourceRoot, candidate))) return candidate;
  }
  if (!relative.startsWith("dashboard/")) {
    for (const candidate of candidates) {
      const currentPath = path.join(workspace, candidate);
      if (fs.existsSync(currentPath) && fs.statSync(currentPath).isFile()) {
        outsideSnapshotShared.set(candidate, { path: candidate, currentSha256: sha256(fs.readFileSync(currentPath)), reason: "Shared contract outside the captured dashboard snapshot" });
        return candidate;
      }
    }
  }
  missing.push({ from, specifier, attempted: candidates });
  return null;
}

function references(relative, text) {
  const ast = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const refs = [];
  function visit(node) {
    let literal;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      literal = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      literal = node.arguments[0];
    }
    if (literal) {
      const resolved = resolveReference(relative, literal.text);
      if (resolved) refs.push({ specifier: literal.text, resolved, start: literal.getStart(ast) + 1, end: literal.getEnd() - 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { ast, refs };
}

function canClone(relative, text) {
  if (roots.includes(relative)) return true;
  if (/^[\s\S]*?import\s+["']server-only["']/.test(text)) return false;
  if (relative.startsWith("dashboard/components/automation/")) return false;
  return relative.startsWith("dashboard/components/") || relative.startsWith("dashboard/features/audit/")
    || (relative.startsWith("dashboard/lib/") && !sharedContracts.has(relative));
}

function visit(relative) {
  if (graph.has(relative)) return;
  const bytes = sourceBytes(relative);
  const source = bytes.toString("utf8");
  const parsed = references(relative, source);
  graph.set(relative, { source, bytes, refs: parsed.refs });
  for (const ref of parsed.refs) {
    if (outsideSnapshotShared.has(ref.resolved)) continue;
    const dependencyBytes = sourceBytes(ref.resolved);
    const dependencyText = dependencyBytes.toString("utf8");
    if (canClone(ref.resolved, dependencyText)) visit(ref.resolved);
    else shared.set(ref.resolved, sha256(dependencyBytes));
  }
}
for (const root of roots) visit(root);
if (missing.length) throw new Error(`Missing snapshot references: ${JSON.stringify(missing)}`);

// Isolate the entire reachable live presentation graph. Future canonical UI
// edits must never change the production fallback's appearance implicitly.
const selected = new Set(graph.keys());
const outputFor = relative => pageEntries[relative]?.[0] || relative.slice("dashboard/".length);
const mappedAlias = relative => `@/legacy/${outputFor(relative).replace(/\.(?:tsx?|js)$/, "")}`;
function outputSpecifier(from, ref) {
  if (selected.has(ref.resolved)) return mappedAlias(ref.resolved);
  if (ref.resolved.startsWith("dashboard/")) return `@/${ref.resolved.slice("dashboard/".length).replace(/\.(?:tsx?|js)$/, "")}`;
  const target = ref.resolved.replace(/\.(?:tsx?|js)$/, "");
  const relative = path.posix.relative(path.posix.dirname(`dashboard/legacy/${outputFor(from)}`), target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}
const files = [];
const referencesReport = [];
for (const relative of [...selected].sort()) {
  const entry = graph.get(relative);
  let output = entry.source;
  const replacements = entry.refs.filter(ref => outputSpecifier(relative, ref) !== ref.specifier);
  for (const ref of replacements.sort((a, b) => b.start - a.start)) {
    output = `${output.slice(0, ref.start)}${outputSpecifier(relative, ref)}${output.slice(ref.end)}`;
  }
  const outputRelative = outputFor(relative);
  const outputPath = path.join(__dirname, outputRelative);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
  files.push({ source: relative, output: `dashboard/legacy/${outputRelative}`, sourceSha256: sha256(entry.bytes), outputSha256: sha256(output), importRewrites: replacements.length });
  for (const ref of entry.refs) {
    referencesReport.push({ from: `dashboard/legacy/${outputRelative}`, originalSpecifier: ref.specifier, target: selected.has(ref.resolved) ? `dashboard/legacy/${outputFor(ref.resolved)}` : ref.resolved, mode: selected.has(ref.resolved) ? "isolated-presentation" : "shared-current" });
  }
}

const baseline = sourceBytes("dashboard/app/globals.css");
fs.writeFileSync(path.join(__dirname, "globals-baseline.css"), baseline);
files.push({ source: "dashboard/app/globals.css", output: "dashboard/legacy/globals-baseline.css", sourceSha256: sha256(baseline), outputSha256: sha256(baseline), importRewrites: 0 });
const index = Object.values(pageEntries).map(([relative, name]) => `export { default as ${name} } from "./${relative.slice("pages/".length).replace(/\.tsx$/, "")}";`).join("\n") + "\n";
fs.writeFileSync(path.join(__dirname, "pages/index.ts"), index);
const generatedFiles = [
  { output: "dashboard/legacy/pages/index.ts", outputSha256: sha256(index) },
  { output: "dashboard/legacy/production-source-manifest.json", outputSha256: sha256(fs.readFileSync(sourceManifestPath)) },
];
const keptOutputs = new Set([...files, ...generatedFiles].map(file => file.output));
const removedStaleOutputs = [];
for (const file of [...(previousManifest?.files || []), ...(previousManifest?.generatedFiles || [])]) {
  if (keptOutputs.has(file.output)) continue;
  const resolved = path.resolve(workspace, file.output);
  if (!resolved.startsWith(`${path.resolve(__dirname)}${path.sep}`)) throw new Error(`Unsafe stale output path: ${file.output}`);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    fs.unlinkSync(resolved);
    removedStaleOutputs.push(file.output);
  }
}

const manifest = {
  version: 2,
  snapshot: {
    sourceDirectory: slash(sourceRoot), manifestPath: slash(sourceManifestPath), manifestSha256: sha256(fs.readFileSync(sourceManifestPath)),
    origin: "Authenticated live production source captured before the preview rollout", sourceTarPath: slash(sourceTarPath), sourceTarSha256: expectedTarSha256,
    releaseRevision: "02f26665277c5866c2ddb4309c1c9646f28c317b", buildId: "bP2v88Nr8XVzXWJrmDlz2", capturedFileCount: capturedFiles.length,
  },
  boundary: "All reachable live production presentation is isolated. Auth, sessions, access checks, databases, validation, settings catalog and data contracts remain current. Automation UI is excluded.",
  pageExports: Object.entries(pageEntries).map(([source, [relative, exportName]]) => ({ source, module: `@/legacy/${relative.replace(/\.tsx$/, "")}`, exportName })),
  auditExport: { module: "@/legacy/features/audit/audit-logs-page", exportName: "AuditLogsPage" },
  files,
  generatedFiles,
  references: referencesReport,
  preservedSharedModules: [...shared].sort(([a], [b]) => a.localeCompare(b)).map(([relative, snapshotSha256]) => ({ path: relative, snapshotSha256 })),
  outsideSnapshotSharedDependencies: [...outsideSnapshotShared.values()],
  missingDependencies: missing,
  removedStaleOutputs,
};
fs.writeFileSync(path.join(__dirname, "legacy-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ modules: selected.size, pages: Object.keys(pageEntries).length, sharedReferences: referencesReport.filter(ref => ref.mode === "shared-current").length, missingDependencies: missing.length }));
