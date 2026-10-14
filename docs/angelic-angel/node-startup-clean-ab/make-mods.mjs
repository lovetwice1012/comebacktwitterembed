import { mkdirSync, writeFileSync } from 'node:fs';
const directory = new URL('./mods/', import.meta.url);
mkdirSync(directory, { recursive: true });
for (let index = 0; index < 54; index++) {
  const next = index < 53 ? `export { v${index + 1} } from './m${index + 1}.mjs';` : '';
  writeFileSync(new URL(`m${index}.mjs`, directory), `${next}\nexport const v${index} = ${index};\n`);
}
