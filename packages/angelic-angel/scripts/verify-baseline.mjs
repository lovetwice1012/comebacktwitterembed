import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('legacy-manifest.json', root), 'utf8'));
for (const [path, expected] of Object.entries(manifest.files)) {
  const buffer = await readFile(new URL(`legacy-rust/${path}`,root));
  assert.equal(createHash('sha256').update(buffer).digest('hex'),expected,`baseline changed: ${path}`);
}
process.stdout.write(`Verified ${Object.keys(manifest.files).length} immutable reference files at ${manifest.commit}\n`);
export const baselinePath = fileURLToPath(new URL('legacy-rust/', root));
