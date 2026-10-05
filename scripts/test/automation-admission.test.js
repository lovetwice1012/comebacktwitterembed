'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const Module = require('node:module');
const path = require('node:path');
test('body admission enforces concurrent large-body, per-actor and rate ceilings before allocation', async () => {
    const build = await esbuild.build({ entryPoints: [path.resolve(__dirname, '../../dashboard/lib/automation-admission.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' });
    const compiled = new Module('admission-test', module); compiled._compile(build.outputFiles[0].text, 'admission-test');
    const { reserveAdmission, bodyLimit } = compiled.exports;
    const active = [];
    try {
        active.push(reserveAdmission('large-one', bodyLimit('/dictionary-preview'), 1000));
        assert.throws(() => reserveAdmission('large-two', bodyLimit('/dictionaries/123/patch'), 1000), { code: 'AUTOMATION_BODY_BUSY' });
        for (let i = 0; i < 4; i++) active.push(reserveAdmission('small', bodyLimit('/validate'), 1000));
        assert.throws(() => reserveAdmission('small', 0, 1000), { code: 'AUTOMATION_USER_BUSY' });
    } finally { active.forEach(release => { release(); release(); }); }
    const retry = reserveAdmission('large-two', bodyLimit('/dictionary-preview'), 61001); retry();
    for (let i = 0; i < 120; i++) reserveAdmission('frequent', 0, 100000)();
    assert.throws(() => reserveAdmission('frequent', 0, 100000), { code: 'AUTOMATION_USER_BUSY' });
    reserveAdmission('frequent', 0, 160001)();
    assert.equal(bodyLimit('/monitors/auto'), 256 * 1024);
});
