'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const dashboardRoot = path.resolve(__dirname, '../../../dashboard');

module.exports = function loadDashboard(relativePath, mocks = {}, expose = []) {
    const cache = new Map();
    function load(filename, exportsToExpose = []) {
        if (filename.endsWith('.json')) return JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (cache.has(filename)) return cache.get(filename).exports;
        const mod = new Module(filename, module);
        mod.filename = filename;
        mod.paths = Module._nodeModulePaths(path.dirname(filename));
        cache.set(filename, mod);
        const nativeRequire = Module.createRequire(filename);
        mod.require = id => {
            if (Object.hasOwn(mocks, id)) return mocks[id];
            if (id === 'server-only') return {};
            if (id.startsWith('@/') || id.startsWith('.')) {
                const base = id.startsWith('@/') ? path.join(dashboardRoot, id.slice(2)) : path.resolve(path.dirname(filename), id);
                for (const extension of ['', '.ts', '.tsx']) {
                    if (fs.existsSync(base + extension) && fs.statSync(base + extension).isFile()) return load(base + extension);
                }
            }
            return nativeRequire(id);
        };
        const source = fs.readFileSync(filename, 'utf8') + (exportsToExpose.length ? `\nexport const __test = { ${exportsToExpose.join(', ')} };` : '');
        const compiled = ts.transpileModule(source, { compilerOptions: {
            target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
            esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
        }, fileName: filename });
        mod._compile(compiled.outputText, filename);
        return mod.exports;
    }
    return load(path.join(dashboardRoot, relativePath), expose);
};
