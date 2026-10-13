'use strict';
const path = require('node:path');
const Module = require('node:module');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');

async function reactFixture(entry, { moduleOverrides = {} } = {}) {
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1/', pretendToBeVisual: true });
    const previous = new Map();
    const set = (key, value) => { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'MutationObserver']) set(key, dom.window[key]);
    set('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window)); set('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
    set('getComputedStyle', dom.window.getComputedStyle.bind(dom.window)); set('IS_REACT_ACT_ENVIRONMENT', true);
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    const dashboard = path.resolve(__dirname, '../../../dashboard'), localRequire = Module.createRequire(path.join(dashboard, 'package.json'));
    const React = localRequire('react'), { createRoot } = localRequire('react-dom/client'), { act } = React;
    const build = await esbuild.build({ stdin: { contents: entry, resolveDir: dashboard, loader: 'tsx' },
        bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external',
        tsconfig: path.join(dashboard, 'tsconfig.json'), loader: { '.css': 'empty' } });
    const compiled = new Module(path.join(dashboard, '__ux_dom_test__.js'), module);
    compiled.filename = path.join(dashboard, '__ux_dom_test__.js'); compiled.paths = Module._nodeModulePaths(dashboard);
    const originalRequire = compiled.require.bind(compiled);
    const resolvedOverrides = new Map(Object.entries(moduleOverrides).map(([id, value]) => [id, typeof value === 'function' ? value(React) : value]));
    compiled.require = id => resolvedOverrides.has(id) ? resolvedOverrides.get(id) : id.endsWith('.css') ? {} : id === 'next/navigation' ? { usePathname: () => '/dashboard/automation', useRouter: () => ({ refresh() {}, push(url) { dom.window.history.pushState({}, '', url); }, replace(url) { dom.window.history.replaceState({}, '', url); } }) }
        : id === 'next/link' ? { __esModule: true, default: props => React.createElement('a', props, props.children) } : originalRequire(id);
    compiled._compile(build.outputFiles[0].text, compiled.filename);
    const container = dom.window.document.getElementById('root'), root = createRoot(container);
    const fixture = {
        React, act, dom, container, exports: compiled.exports, set,
        render: async element => act(async () => root.render(element)),
        settle: async () => act(async () => { await new Promise(resolve => setImmediate(resolve)); }),
        click: async text => {
            const element = [...container.querySelectorAll('button')].find(node => node.textContent.trim() === text);
            if (!element) throw new Error(`Missing button: ${text}`);
            await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
        },
        field: label => [...container.querySelectorAll('label')].find(node => node.textContent.trim().startsWith(label))?.querySelector('input,select,textarea'),
        fill: async (element, value) => {
            if (!element) throw new Error('Missing field');
            await act(async () => {
                Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value);
                element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
            });
        },
        submit: async () => act(async () => container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))),
        close: async () => {
            await act(async () => root.unmount()); dom.window.close();
            for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
        },
    };
    return fixture;
}
module.exports = { reactFixture };
