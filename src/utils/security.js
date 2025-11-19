const path = require('path');
const fs = require('fs');

/**
 * Prevents directory traversal attacks
 * @param {string} userInput - User-provided path
 * @returns {string} - Validated absolute path
 * @throws {Error} - If path is invalid or malicious
 */
function antiDirectoryTraversalAttack(userInput) {
    const baseDirectory = path.resolve('saves');
    const invalidPathPattern = /(\.\.(\/|\\|$))/;
    const joinedPath = path.join(baseDirectory, userInput);
    let realPath;

    try {
        realPath = fs.realpathSync(joinedPath);
    } catch (err) {
        throw new Error('不正なパスが検出されました。');
    }

    const relativePath = path.relative(baseDirectory, realPath);
    if (
        userInput.includes('\0') ||
        invalidPathPattern.test(userInput) ||
        relativePath.startsWith('..') ||
        path.isAbsolute(relativePath) ||
        relativePath.includes('\0') ||
        !realPath.startsWith(baseDirectory)
    ) {
        throw new Error('不正なパスが検出されました。');
    }

    return realPath;
}

module.exports = {
    antiDirectoryTraversalAttack
};
