'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prismaClientState, shouldGeneratePrismaClient, runProductionBuild } = require('../../dashboard/scripts/start-dashboard')._internal;

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-prisma-build-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const client = path.join(root, 'node_modules/.prisma/client');
    const templates = path.join(root, 'node_modules/@prisma/client/scripts');
    fs.mkdirSync(client, { recursive: true }); fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(path.join(templates, 'default-index.js'), 'placeholder client');
    fs.writeFileSync(path.join(templates, 'default-index.d.ts'), 'placeholder types');
    const write = (name, data) => fs.writeFileSync(path.join(client, name), data);
    const stub = () => { write('index.js', 'placeholder client'); write('index.d.ts', 'placeholder types'); };
    const generated = () => { write('index.js', 'generated client'); write('index.d.ts', 'generated types'); write('schema.prisma', 'generated schema'); write('default.js', 'generated default'); write('default.d.ts', 'generated default types'); write('package.json', JSON.stringify({ main: 'index.js', types: 'index.d.ts' })); };
    const prisma = path.join(root, 'node_modules/prisma/build/index.js');
    const next = path.join(root, 'node_modules/next/dist/bin/next');
    fs.mkdirSync(path.dirname(prisma), { recursive: true }); fs.mkdirSync(path.dirname(next), { recursive: true });
    fs.writeFileSync(prisma, `const fs = require('fs'); const path = require('path');
        const client = path.join(process.cwd(), 'node_modules/.prisma/client');
        fs.writeFileSync(path.join(process.cwd(), 'generated-marker'), 'yes');
        if (!process.env.FAIL_FIXTURE_GENERATION) {
          fs.writeFileSync(path.join(client, 'index.js'), 'generated client');
          fs.writeFileSync(path.join(client, 'index.d.ts'), 'generated types');
          fs.writeFileSync(path.join(client, 'schema.prisma'), 'generated schema');
          fs.writeFileSync(path.join(client, 'default.js'), 'generated default');
          fs.writeFileSync(path.join(client, 'default.d.ts'), 'generated default types');
          fs.writeFileSync(path.join(client, 'package.json'), JSON.stringify({ main: 'index.js', types: 'index.d.ts' }));
        }`);
    fs.writeFileSync(next, `const fs = require('fs'); const path = require('path');
        const dir = path.join(process.cwd(), process.env.DASHBOARD_NEXT_DIST_DIR);
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'BUILD_ID'), 'fixture');
        fs.writeFileSync(path.join(process.cwd(), 'built-marker'), 'yes');`);
    return { root, client, stub, generated, write };
}

const env = { ...process.env, DASHBOARD_FORCE_PRISMA_GENERATE: '', FAIL_FIXTURE_GENERATION: '' };

test('fresh installation and matching npm placeholder trigger generation before Next build', t => {
    const f = fixture(t);
    assert.equal(prismaClientState(f.root), 'absent');
    f.stub();
    assert.equal(prismaClientState(f.root), 'stub');
    assert.equal(shouldGeneratePrismaClient(f.root, env), true);
    assert.equal(runProductionBuild(f.root, env), 0);
    assert.equal(prismaClientState(f.root), 'generated');
    assert(fs.existsSync(path.join(f.root, 'generated-marker')));
    assert(fs.existsSync(path.join(f.root, 'built-marker')));
});

test('complete client, including an older generated schema, is not replaced during live build', t => {
    const f = fixture(t); f.generated();
    fs.mkdirSync(path.join(f.root, 'prisma')); fs.writeFileSync(path.join(f.root, 'prisma/schema.prisma'), 'changed schema');
    assert.equal(shouldGeneratePrismaClient(f.root, env), false);
    assert.equal(runProductionBuild(f.root, env), 0);
    assert.equal(fs.readFileSync(path.join(f.client, 'index.js'), 'utf8'), 'generated client');
    assert(!fs.existsSync(path.join(f.root, 'generated-marker')));
});

test('unrecognized incomplete clients fail closed until explicit regeneration', t => {
    const f = fixture(t); f.generated(); fs.rmSync(path.join(f.client, 'schema.prisma'));
    assert.equal(prismaClientState(f.root), 'incomplete');
    assert.equal(runProductionBuild(f.root, env), 1);
    assert(!fs.existsSync(path.join(f.root, 'generated-marker')));
    assert(!fs.existsSync(path.join(f.root, 'built-marker')));
    assert.equal(fs.readFileSync(path.join(f.client, 'index.js'), 'utf8'), 'generated client');
    assert.equal(runProductionBuild(f.root, { ...env, DASHBOARD_FORCE_PRISMA_GENERATE: '1' }), 0);
});

test('partial generation never reaches Next build', t => {
    const f = fixture(t); f.stub();
    assert.equal(runProductionBuild(f.root, { ...env, FAIL_FIXTURE_GENERATION: '1' }), 1);
    assert(fs.existsSync(path.join(f.root, 'generated-marker')));
    assert(!fs.existsSync(path.join(f.root, 'built-marker')));
});

test('partial or mixed placeholder state is never silently accepted', t => {
    const f = fixture(t); f.stub(); f.write('schema.prisma', 'unexpected');
    assert.equal(prismaClientState(f.root), 'incomplete');
    assert.throws(() => shouldGeneratePrismaClient(f.root, env), /incomplete/);
    f.generated(); f.write('index.d.ts', 'placeholder types');
    assert.equal(prismaClientState(f.root), 'incomplete');
});


test('automatic generation refuses a linked client directory but explicit force retains its override', t => {
    const f = fixture(t); f.stub();
    const original = path.join(f.root, 'node_modules/.prisma/client');
    const shared = path.join(f.root, 'shared-client');
    fs.renameSync(original, shared);
    fs.symlinkSync(shared, original, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(prismaClientState(f.root), 'stub');
    assert.throws(() => shouldGeneratePrismaClient(f.root, env), /linked dependencies/);
    assert.equal(runProductionBuild(f.root, env), 1);
    assert(!fs.existsSync(path.join(f.root, 'generated-marker')));
    assert.equal(shouldGeneratePrismaClient(f.root, { ...env, DASHBOARD_FORCE_PRISMA_GENERATE: '1' }), true);
});

test('empty generated artifacts fail closed', t => {
    const f = fixture(t); f.generated(); f.write('schema.prisma', '');
    assert.equal(prismaClientState(f.root), 'incomplete');
    assert.throws(() => shouldGeneratePrismaClient(f.root, env), /incomplete/);
});


test('leftover generated files prevent automatic replacement even when the entry point is a stub or absent', t => {
    const f = fixture(t); f.stub(); f.write('query_engine.node', 'in-use generated engine');
    assert.equal(prismaClientState(f.root), 'incomplete');
    assert.throws(() => shouldGeneratePrismaClient(f.root, env), /incomplete/);
    fs.rmSync(path.join(f.client, 'index.js')); fs.rmSync(path.join(f.client, 'index.d.ts'));
    assert.equal(prismaClientState(f.root), 'incomplete');
    assert.equal(runProductionBuild(f.root, env), 1);
    assert.equal(fs.readFileSync(path.join(f.client, 'query_engine.node'), 'utf8'), 'in-use generated engine');
});


test('the full Prisma npm placeholder set is recognized; absent templates fail closed', t => {
    const f = fixture(t);
    for (const name of ['index', 'edge', 'default', 'wasm', 'index-browser']) f.write(`${name}.js`, 'placeholder client');
    for (const name of ['index', 'edge', 'default', 'wasm']) f.write(`${name}.d.ts`, 'placeholder types');
    assert.equal(prismaClientState(f.root), 'stub');
    f.generated(); fs.rmSync(path.join(f.root, 'node_modules/@prisma/client/scripts/default-index.js'));
    assert.equal(prismaClientState(f.root), 'incomplete');
    assert.throws(() => shouldGeneratePrismaClient(f.root, env), /incomplete/);
});


test('default entry points and manifest must be generated and internally consistent', t => {
    const f = fixture(t); f.generated();
    f.write('default.js', 'placeholder client');
    assert.equal(prismaClientState(f.root), 'incomplete');
    f.generated(); f.write('default.d.ts', 'placeholder types');
    assert.equal(prismaClientState(f.root), 'incomplete');
    f.generated(); fs.rmSync(path.join(f.client, 'default.js'));
    assert.equal(prismaClientState(f.root), 'incomplete');
    f.generated(); f.write('package.json', '{invalid');
    assert.equal(prismaClientState(f.root), 'incomplete');
    f.generated(); f.write('default.js', "module.exports = require('#main-entry-point')");
    assert.equal(prismaClientState(f.root), 'incomplete');
    const manifest = { main: 'index.js', types: 'index.d.ts', imports: { '#main-entry-point': { require: { node: './index.js' }, import: { node: './index.js' } } } };
    f.write('package.json', JSON.stringify(manifest));
    assert.equal(prismaClientState(f.root), 'generated');
    manifest.imports['#main-entry-point'].require.node = './other.js';
    f.write('package.json', JSON.stringify(manifest));
    assert.equal(prismaClientState(f.root), 'incomplete');
});
