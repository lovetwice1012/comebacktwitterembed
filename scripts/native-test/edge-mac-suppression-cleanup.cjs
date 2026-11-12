'use strict';
function trackFixtureChild(child) {
    const item = { child, closed: false };
    item.done = new Promise(resolve => { child.once('close', () => { item.closed = true; resolve(); }); });
    child.on('error', () => {}); // Error does not prove pipe/child closure.
    return item;
}
async function runFixtureCleanup(steps) {
    let safe = true;
    for (const step of steps) { try { if (await step() !== true) safe = false; } catch { safe = false; } }
    return safe;
}
module.exports = { trackFixtureChild, runFixtureCleanup };
