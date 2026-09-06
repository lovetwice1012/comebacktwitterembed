'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Bot/legacy media commands historically use cwd/saves; independent admin
// workers pass their repository fallback explicitly. OCI supplies SAVES_DIR.
function getSavedRoot(fallbackBase = process.cwd()) {
    return path.resolve(process.env.SAVES_DIR || path.join(process.env.ADMIN_SUPPORT_DATA_DIR || fallbackBase, 'saves'));
}

function invalidPath() { return new Error('Saved-data path is outside the configured root or contains a symbolic link.'); }

function assertSavedPath(target, { root = getSavedRoot(), mustExist = false, allowRoot = false } = {}) {
    root = path.resolve(root);
    target = path.resolve(target);
    const relative = path.relative(root, target);
    if ((!relative && !allowRoot) || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw invalidPath();
    // Check the configured root and its ancestors too. A root symlink must not
    // turn correct-looking paths into reads/deletes in a different data tree.
    let cursor = path.parse(target).root;
    const parts = path.relative(cursor, target).split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
        cursor = path.join(cursor, parts[index]);
        let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
            if (error.code === 'ENOENT' && !mustExist) break;
            throw error;
        }
        if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory()) throw invalidPath();
    }
    return target;
}

function resolveSavedPath(relativePath, options = {}) {
    if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')
        || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) throw invalidPath();
    const parts = relativePath.split(/[\\/]/);
    if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || part.includes(':'))) throw invalidPath();
    const root = options.root || getSavedRoot();
    return assertSavedPath(path.resolve(root, ...parts), { ...options, root });
}

module.exports = { getSavedRoot, resolveSavedPath, assertSavedPath };
