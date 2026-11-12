'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

test('optional config declaration resolves the one intended path with or without runtime JSON', () => {
    const root = path.resolve(__dirname, '../..');
    const virtualJson = path.join(root, 'config.json').toLowerCase();
    const declared = path.join(root, 'config.json.d.ts');
    const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    for (const present of [false, true]) {
        const host = { ...ts.sys, fileExists: filename => path.resolve(filename).toLowerCase() === virtualJson
            ? present : ts.sys.fileExists(filename) };
        for (const [moduleName, source] of [
            ['../config.json', 'src/delegatedAccess.js'],
            ['../../config.json', 'src/lifecycle/mediaDeliveryServer.js'],
            ['../../../config.json', 'src/providers/autoWatch/_shared.js'],
        ]) {
            const resolution = ts.resolveModuleName(moduleName, path.join(root, source), parsed.options, host);
            assert.equal(path.resolve(resolution.resolvedModule.resolvedFileName).toLowerCase(), declared.toLowerCase());
        }
    }
    const other = ts.resolveModuleName('./missing-config.json', path.join(root, 'src/delegatedAccess.js'), parsed.options, ts.sys);
    assert.equal(other.resolvedModule, undefined, 'unrelated missing config must not be hidden');
});

test('a declaration alone never substitutes for a runtime config file', t => {
    const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'cbte-config-type-test-'));
    t.after(() => {
        const actual = fs.realpathSync(root);
        assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
        assert.match(path.basename(actual), /^cbte-config-type-test-/);
        fs.rmSync(actual, { recursive: true });
    });
    fs.writeFileSync(path.join(root, 'config.json.d.ts'), 'declare const value: unknown; export = value;');
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const inspect = () => spawnSync(process.execPath, ['-e', "try { const config = require('./config.json'); process.stdout.write(config.synthetic ? 'json' : 'unexpected'); } catch (error) { process.stdout.write(error.code); }"],
        { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const absent = inspect(); assert.equal(absent.status, 0); assert.equal(absent.stdout, 'MODULE_NOT_FOUND');
    fs.writeFileSync(path.join(root, 'config.json'), '{"synthetic":true}');
    const present = inspect(); assert.equal(present.status, 0); assert.equal(present.stdout, 'json');
});
