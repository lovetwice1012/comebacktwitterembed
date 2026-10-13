'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

// Client routing retains the previous document's CSP. Entering and leaving a
// payment page must load a document to apply that destination's own policy.
function clientLink(React, navigations) {
    return props => React.createElement('a', {
        ...props,
        onClick: event => {
            props.onClick?.(event);
            if (!event.defaultPrevented) {
                event.preventDefault();
                navigations.push(props.href);
            }
        },
    }, props.children);
}

async function clickNavigation(f, href) {
    const link = f.container.querySelector(`a[href="${href}"]`);
    assert(link, `Missing destination: ${href}`);
    let intercepted;
    const observe = event => {
        intercepted = event.defaultPrevented;
        // Observe after React's handlers, then prevent jsdom's unsupported
        // document navigation without masking a client-router interception.
        event.preventDefault();
    };
    f.dom.window.document.addEventListener('click', observe, { once: true });
    try {
        await f.act(async () => link.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    } finally {
        f.dom.window.document.removeEventListener('click', observe);
    }
    assert.notEqual(intercepted, undefined, 'The click must reach the document');
    return intercepted;
}

test('payment navigation fixture detects a client-router interception instead of merely checking rendered hrefs', async () => {
    const f = await reactFixture('export {};');
    const navigations = [];
    try {
        await f.render(f.React.createElement(clientLink(f.React, navigations), { href: '/dashboard/automation/plans' }, 'Plan'));
        assert.equal(await clickNavigation(f, '/dashboard/automation/plans'), true);
        assert.deepEqual(navigations, ['/dashboard/automation/plans']);
    } finally { await f.close(); }
});

test('automation workspace payment entries use document navigation so Square receives the payment CSP', async () => {
    const navigations = [];
    const f = await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";', {
        moduleOverrides: { 'next/link': React => ({ __esModule: true, default: clientLink(React, navigations) }) },
    });
    try {
        f.set('sessionStorage', f.dom.window.sessionStorage);
        f.set('fetch', async address => {
            const route = new URL(address, 'http://fixture').pathname.slice('/api/automation/'.length);
            let result = { items: [], nextCursor: null };
            if (route === 'catalog') result = {};
            if (route === 'providers') result = { auto: [], price: [], autoRegistration: { eligible: false } };
            if (route === 'entitlements') result = { plan: { name: '無料', slotLimit: 5, minuteLimit: 5, dayLimit: 24 }, slots: { used: 0, max: 5, available: 5 }, usage: { entries: [] } };
            return new Response(JSON.stringify(result), { status: 200 });
        });
        await f.render(f.React.createElement(f.exports.AutomationWorkspace, { viewerId: '222222222222222222' }));
        await f.settle();
        for (const href of ['/dashboard/automation/plans', '/dashboard/automation/support']) {
            assert.equal(await clickNavigation(f, href), false, `${href} must fetch a new document`);
        }
        assert.deepEqual(navigations, []);
    } finally { await f.close(); }
});

for (const [page, sibling, manager] of [
    ['plans', 'support', 'SubscriptionManager'],
    ['support', 'plans', 'SquareDonationManager'],
]) {
    test(`${page} payment page uses document navigation for both its sibling and return to the standard CSP`, async () => {
        const f = await reactFixture('export {};');
        const navigations = [];
        let sessionChecks = 0;
        try {
            const Page = loadDashboard(`app/dashboard/automation/${page}/page.tsx`, {
                '@/lib/server-session': { requireDashboardSession: async () => { sessionChecks++; return { user: { id: '222222222222222222' } }; } },
                '@/components/automation/subscription-manager': { SubscriptionManager: () => null },
                '@/components/automation/square-donation-manager': { SquareDonationManager: () => null },
                'next/link': { __esModule: true, default: clientLink(f.React, navigations) },
            }).default;
            const content = await Page();
            assert.equal(sessionChecks, 1);
            assert.equal(content.props.children.at(-1).key, '222222222222222222', `${manager} stays scoped to the authenticated user`);
            await f.render(content);
            for (const href of ['/dashboard/automation', `/dashboard/automation/${sibling}`]) {
                assert.equal(await clickNavigation(f, href), false, `${href} must fetch a new document`);
            }
            assert.deepEqual(navigations, []);
        } finally { await f.close(); }
    });
}
