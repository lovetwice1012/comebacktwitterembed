'use strict';

// One-shot refactor: split Twitter-specific commands into src/providers/twitter/commands/.
// 1. Move twitter.js -> twitter/index.js (rewrite relative requires)
// 2. Move Twitter-specific command handlers into twitter/commands/
// 3. Build /twittersettings parent command
// 4. Trim src/commands/handlers/settings.js to non-Twitter subs only
// 5. Update _loader to support directory providers

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');

function read(p)  { return fs.readFileSync(p, 'utf8'); }
function write(p, c) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
}
function moveFile(from, to, transformer) {
    const c = read(from);
    write(to, transformer ? transformer(c) : c);
    fs.unlinkSync(from);
}

// ---- 1. twitter.js -> twitter/index.js ----
const twSrc = path.join(SRC, 'providers', 'twitter.js');
const twDst = path.join(SRC, 'providers', 'twitter', 'index.js');
if (fs.existsSync(twSrc) && !fs.existsSync(twDst)) {
    moveFile(twSrc, twDst, (content) => {
        // require paths shift: providers/twitter.js -> providers/twitter/index.js (1 deeper)
        return content
            // ../settings -> ../../settings
            .replace(/require\('\.\.\/settings'\)/g, "require('../../settings')")
            // ../utils -> ../../utils
            .replace(/require\('\.\.\/utils'\)/g, "require('../../utils')")
            // ./_provider_settings -> ../_provider_settings
            .replace(/require\('\.\/_provider_settings'\)/g, "require('../_provider_settings')")
            // ./_dispatcher -> ../_dispatcher
            .replace(/require\('\.\/_dispatcher'\)/g, "require('../_dispatcher')")
            // ./_types -> ../_types  (in JSDoc imports)
            .replace(/import\('\.\/_types'\)/g, "import('../_types')");
    });
    console.log('moved: providers/twitter.js -> providers/twitter/index.js');
}

// ---- 2. Move Twitter-specific commands ----
// Top-level handlers (depth 2: src/commands/handlers/X.js -> src/providers/twitter/commands/X.js, depth still 4 to src)
const TOP_HANDLERS = ['showsavetweet', 'deletesavetweet', 'savetweetquotaoverride'];
for (const name of TOP_HANDLERS) {
    const from = path.join(SRC, 'commands', 'handlers', name + '.js');
    const to   = path.join(SRC, 'providers', 'twitter', 'commands', name + '.js');
    if (fs.existsSync(from) && !fs.existsSync(to)) {
        moveFile(from, to, (content) => content
            // src/commands/handlers/X.js -> src/providers/twitter/commands/X.js
            // Both are 3 levels deep from project root inside src; old: ../../X (= src/X), new must be ../../../X
            .replace(/require\('\.\.\/\.\.\//g, "require('../../../")
            // For the showsavetweet require of '../../providers/twitter' -> '..' (now sibling dir)
            .replace(/require\(\/\*\* @type \{any\} \*\/ \('\.\.\/\.\.\/providers\/twitter'\)\)/g, "require(/** @type {any} */ ('../..'))")
        );
        console.log('moved: commands/handlers/' + name + '.js -> providers/twitter/commands/' + name + '.js');
    }
}

// Settings sub-handlers (depth 3: src/commands/handlers/settings/X.js -> src/providers/twitter/commands/settings/X.js, both depth 4)
const SETTINGS_TWITTER = [
    'legacymode',
    'anonymousexpand',
    'passivemode',
    'deleteifonlypostedtweetlink',
    'alwaysreplyifpostedtweetlink',
    'secondaryextractmode',
    'secondaryextracttarget',
    'quoterepostdonotextract',
    'quoterepostmaxdepth',
    'setdefaultmediaasattachments',
    'bannedwords',
];
for (const name of SETTINGS_TWITTER) {
    const from = path.join(SRC, 'commands', 'handlers', 'settings', name + '.js');
    const to   = path.join(SRC, 'providers', 'twitter', 'commands', 'settings', name + '.js');
    if (fs.existsSync(from) && !fs.existsSync(to)) {
        moveFile(from, to, (content) => content
            // src/commands/handlers/settings/X.js -> src/providers/twitter/commands/settings/X.js
            // Old paths: ../../../X (= src/X). New depth (4 deep): need ../../../../X
            .replace(/require\('\.\.\/\.\.\/\.\.\//g, "require('../../../../")
        );
        console.log('moved: commands/handlers/settings/' + name + '.js -> providers/twitter/commands/settings/' + name + '.js');
    }
}

console.log('done.');
