/* global require, __dirname, process, console */
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node.js CommonJS executable. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ts = require("../node_modules/typescript");
const workspace = path.resolve(__dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "legacy-manifest.json"), "utf8"));
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const isolated = new Set(manifest.files.map(file => file.source));
const errors = [];
let checkedImports = 0;
for (const file of [...manifest.files, ...manifest.generatedFiles]) {
  const content = fs.readFileSync(path.join(workspace, file.output));
  if (sha256(content) !== file.outputSha256) errors.push(`Output hash differs: ${file.output}`);
  if (file.source) {
    const sourcePath = path.join(manifest.snapshot.sourceDirectory, file.source);
    if (!fs.existsSync(sourcePath) || sha256(fs.readFileSync(sourcePath)) !== file.sourceSha256) errors.push(`Snapshot hash differs: ${file.source}`);
  }
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
      if (specifier.startsWith("@/")) {
        const canonical = `dashboard/${specifier.slice(2)}`;
        if ([canonical, `${canonical}.ts`, `${canonical}.tsx`].some(target => isolated.has(target))) errors.push(`Canonical presentation import leaks: ${file.output} -> ${specifier}`);
      }
      if (specifier.includes("components/automation/") || specifier.includes("ui-rollout")) errors.push(`Excluded dependency: ${file.output} -> ${specifier}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const diagnostic of source.parseDiagnostics) errors.push(`Syntax: ${file.output}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
}
for (const dependency of manifest.outsideSnapshotSharedDependencies) {
  if (!fs.existsSync(path.join(workspace, dependency.path))) errors.push(`Missing current shared contract: ${dependency.path}`);
}
if (errors.length) {
  console.error(JSON.stringify({ errors }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ files: manifest.files.length + manifest.generatedFiles.length, imports: checkedImports, missingDependencies: manifest.missingDependencies.length, errors: 0 }));
}
