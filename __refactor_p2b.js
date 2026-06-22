// One-shot refactor script (P2B): extract slash-command definitions to buildSlashCommands().
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'index.js');
let src = fs.readFileSync(FILE, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n';
const lines = src.split(/\r?\n/);

let startIdx = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('client.application.commands.set([')) {
        startIdx = i;
        break;
    }
}
if (startIdx === -1) throw new Error('start anchor not found');

let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '    ]);') {
        endIdx = i;
        break;
    }
}
if (endIdx === -1) throw new Error('end anchor not found');

const innerLines = lines.slice(startIdx + 1, endIdx);
const reindented = innerLines.map(l => l.startsWith('    ') ? l.slice(4) : l);

const fnSrc = [
    '/**',
    ' * Discord に登録するスラッシュコマンドの定義一覧を返す。',
    ' * ロケール表は commandNameLocales / descriptionLocales を参照。',
    ' */',
    'function buildSlashCommands() {',
    '    return [',
    ...reindented,
    '    ];',
    '}',
].join(eol);

const replacement = '    client.application.commands.set(buildSlashCommands());';
const newLines = [
    ...lines.slice(0, startIdx),
    replacement,
    ...lines.slice(endIdx + 1),
];

let newSrc = newLines.join(eol);

const anchor = 'function conv_en_to_en_US(';
const idx = newSrc.indexOf(anchor);
if (idx === -1) throw new Error('insertion anchor not found');
newSrc = newSrc.slice(0, idx) + fnSrc + eol + eol + newSrc.slice(idx);

fs.writeFileSync(FILE, newSrc);
console.log(`Extracted ${innerLines.length} lines into buildSlashCommands().`);
// One-shot refactor script (P2B): extract slash-command definitions to buildSlashCommands().
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'index.js');
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

// Find the line index (0-based) of `client.application.commands.set([`
let startIdx = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('client.application.commands.set([')) {
        startIdx = i;
        break;
    }
}
if (startIdx === -1) throw new Error('start anchor not found');

// Find the matching `    ]);` after startIdx (the first 4-space-indented `]);`)
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i] === '    ]);') {
        endIdx = i;
        break;
    }
}
if (endIdx === -1) throw new Error('end anchor not found');

// Extract the array body between them.
// startIdx line: `    client.application.commands.set([`
// endIdx line:   `    ]);`
// Everything between is the array contents (already 8-space indented inside).
const innerLines = lines.slice(startIdx + 1, endIdx);

// Build the new function. Re-indent: each existing line is indented by 8 spaces minimum (inside ready),
// we want to bring it down to 4 spaces inside the top-level function.
// Strip exactly 4 leading spaces if present.
const reindented = innerLines.map(l => l.startsWith('    ') ? l.slice(4) : l);

const fnSrc = [
    '/**',
    ' * Discord に登録するスラッシュコマンドの定義一覧を返す。',
    ' * ロケール表は commandNameLocales / descriptionLocales を参照。',
    ' */',
    'function buildSlashCommands() {',
    '    return [',
    ...reindented,
    '    ];',
    '}',
].join('\n');

// Replace lines startIdx..endIdx with a single call.
const replacement = '    client.application.commands.set(buildSlashCommands());';
const newLines = [
    ...lines.slice(0, startIdx),
    replacement,
    ...lines.slice(endIdx + 1),
];

let newSrc = newLines.join('\n');

// Insert function definition just before `function conv_en_to_en_US(`.
const anchor = 'function conv_en_to_en_US(';
const idx = newSrc.indexOf(anchor);
if (idx === -1) throw new Error('insertion anchor not found');
newSrc = newSrc.slice(0, idx) + fnSrc + '\n\n' + newSrc.slice(idx);

fs.writeFileSync(FILE, newSrc);
console.log(`Extracted ${innerLines.length} lines into buildSlashCommands().`);
