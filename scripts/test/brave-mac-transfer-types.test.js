'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require('typescript');

test('TypeScript consumers can use the explicit Mac Brave transfer option', () => {
    const virtualFile = path.resolve(__dirname, 'brave-mac-transfer-types.fixture.ts');
    const source = `
        import { BraveTransferFile, parseTransferFile, identifyTransfer, createTransferSealer,
            createTransferWorkerVault, createTransferPublicSealer, createTransferPrivateWorkerVault } from '../../src/automation/x-setup-transfer';
        declare const file: BraveTransferFile;
        declare const key: import('node:crypto').KeyObject;
        const category: 'com.brave.windows' | 'com.brave.macosx' = file.push.productCategory;
        const mac: BraveTransferFile['push']['productCategory'] = 'com.brave.macosx';
        const options = { allowBraveMac: true };
        parseTransferFile('{}', options); identifyTransfer(file, options);
        createTransferSealer({ activeKeyId: 'a', keys: { a: Buffer.alloc(32) }, ...options });
        createTransferWorkerVault({ activeKeyId: 'a', keys: { a: Buffer.alloc(32) }, ...options });
        createTransferPublicSealer({ activeKeyId: 'a', publicKeys: { a: key }, ...options });
        createTransferPrivateWorkerVault({ activeKeyId: 'a', privateKeys: { a: key }, ...options });
        // @ts-expect-error An unknown product category is not supported.
        const invalid: BraveTransferFile['push']['productCategory'] = 'com.brave.other';
        // @ts-expect-error The rollout option is a boolean.
        parseTransferFile('{}', { allowBraveMac: 'true' });
        void [category, mac, invalid];
    `;
    const options = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, types: ['node'] };
    const host = ts.createCompilerHost(options), oldGet = host.getSourceFile.bind(host), oldExists = host.fileExists.bind(host);
    host.fileExists = name => path.resolve(name) === virtualFile || oldExists(name);
    host.getSourceFile = (name, language, ...rest) => path.resolve(name) === virtualFile
        ? ts.createSourceFile(name, source, language, true) : oldGet(name, language, ...rest);
    const program = ts.createProgram([virtualFile], options, host);
    const errors = ts.getPreEmitDiagnostics(program);
    assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
        getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => '\n',
    }));
});
