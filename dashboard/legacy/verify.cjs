"use strict";

(async () => {
  const [fs, path, crypto, typescript, processModule, consoleModule] = await Promise.all([
    import("node:fs"), import("node:path"), import("node:crypto"), import("typescript"), import("node:process"), import("node:console"),
  ]);
  const ts = typescript.default;
  const runtimeProcess = processModule.default;
  const runtimeConsole = consoleModule.default;
  const legacyDirectory = path.resolve(path.dirname(runtimeProcess.argv[1]));
  const workspace = path.resolve(legacyDirectory, "../..");
  const manifest = JSON.parse(fs.readFileSync(path.join(legacyDirectory, "legacy-manifest.json"), "utf8"));
  const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  const isolated = new Set(manifest.files.map(file => file.source));
  const errors = [];
  let sourceRoot;
  let requireOriginalSources = false;
  const args = runtimeProcess.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--source-root" && args[index + 1] && !args[index + 1].startsWith("--")) {
      sourceRoot = path.resolve(args[++index]);
    } else if (args[index] === "--require-original-sources") {
      requireOriginalSources = true;
    } else {
      errors.push(`Unknown or incomplete argument: ${args[index]}`);
    }
  }
  if (requireOriginalSources && !sourceRoot) errors.push("Original source verification requires --source-root PATH");

  function safePath(root, relative) {
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Path escapes its verification root: ${relative}`);
    return resolved;
  }
  function readFile(root, relative) {
    try { return fs.readFileSync(safePath(root, relative)); }
    catch { errors.push(`Missing or unreadable verification file: ${relative}`); return null; }
  }

  // Historical absolute capture paths are metadata, never required local inputs.
  const capturedManifestBytes = readFile(legacyDirectory, "production-source-manifest.json");
  let capturedSources = [];
  if (capturedManifestBytes) {
    if (sha256(capturedManifestBytes) !== manifest.snapshot.manifestSha256) errors.push("Captured production source manifest hash differs");
    try { capturedSources = JSON.parse(capturedManifestBytes.toString("utf8")); }
    catch { errors.push("Captured production source manifest is invalid JSON"); }
  }
  if (!Array.isArray(capturedSources)) { errors.push("Captured production source manifest is not an array"); capturedSources = []; }
  if (capturedSources.length !== manifest.snapshot.capturedFileCount) errors.push("Captured production source count differs");
  const capturedHashes = new Map(capturedSources.map(file => [file.path, file.sha256]));

  let checkedImports = 0;
  for (const file of [...manifest.files, ...manifest.generatedFiles]) {
    if (!file.output.startsWith("dashboard/legacy/")) { errors.push(`Output leaves the legacy presentation tree: ${file.output}`); continue; }
    const content = readFile(workspace, file.output);
    if (!content) continue;
    if (sha256(content) !== file.outputSha256) errors.push(`Output hash differs: ${file.output}`);
    if (file.source && capturedHashes.get(file.source) !== file.sourceSha256) errors.push(`Recorded source hash differs: ${file.source}`);
    if (!/\.tsx?$/.test(file.output)) continue;
    const source = ts.createSourceFile(file.output, content.toString("utf8"), ts.ScriptTarget.Latest, true, file.output.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) {
      let literal;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) literal = node.moduleSpecifier;
      else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) literal = node.arguments[0];
      if (literal) {
        checkedImports++;
        const specifier = literal.text;
        const canonical = specifier.startsWith("@/") ? `dashboard/${specifier.slice(2)}` : specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file.output), specifier)) : null;
        if (canonical && [canonical, `${canonical}.ts`, `${canonical}.tsx`].some(target => isolated.has(target))) errors.push(`Canonical presentation import leaks: ${file.output} -> ${specifier}`);
        if (specifier.includes("components/automation/") || specifier.includes("ui-rollout")) errors.push(`Excluded dependency: ${file.output} -> ${specifier}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const diagnostic of source.parseDiagnostics) errors.push(`Syntax: ${file.output}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
  for (const dependency of manifest.outsideSnapshotSharedDependencies) {
    if (!fs.existsSync(safePath(workspace, dependency.path))) errors.push(`Missing current shared contract: ${dependency.path}`);
  }

  let originalSourceFilesVerified = 0;
  let originalSourceErrors = 0;
  if (sourceRoot) {
    const errorsBefore = errors.length;
    for (const file of capturedSources) {
      const original = readFile(sourceRoot, file.path);
      if (!original) continue;
      if (sha256(original) !== file.sha256) errors.push(`Original source hash differs: ${file.path}`);
      else originalSourceFilesVerified++;
    }
    originalSourceErrors = errors.length - errorsBefore;
  }
  const report = {
    files: manifest.files.length + manifest.generatedFiles.length,
    imports: checkedImports,
    capturedSourceManifestFiles: capturedSources.length,
    originalSourcesVerified: Boolean(sourceRoot) && originalSourceErrors === 0 && originalSourceFilesVerified === capturedSources.length && capturedSources.length > 0,
    originalSourceFilesVerified,
    missingDependencies: manifest.missingDependencies.length,
    errors: errors.length,
  };
  if (errors.length) {
    runtimeConsole.error(JSON.stringify({ ...report, failures: errors }, null, 2));
    runtimeProcess.exitCode = 1;
  } else {
    runtimeConsole.log(JSON.stringify(report));
  }
})().catch(async error => {
  const { default: runtimeProcess } = await import("node:process");
  const { default: runtimeConsole } = await import("node:console");
  runtimeConsole.error(JSON.stringify({ errors: 1, originalSourcesVerified: false, failures: [error.message] }));
  runtimeProcess.exitCode = 1;
});
