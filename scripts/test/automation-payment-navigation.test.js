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

async function clickNavigation(f, href, selector) {
    const link = f.container.querySelector(selector || `a[href="${href}"]`);
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

test('the shared notification navigation uses document navigation so Square receives the payment CSP', async () => {
    const navigations = [];
    const f = await reactFixture('export {};', {
        moduleOverrides: { 'next/link': React => ({ __esModule: true, default: clientLink(React, navigations) }) },
    });
    try {
        const { AutomationPageFrame } = loadDashboard('components/automation/automation-page-frame.tsx', {
            '@/components/dashboard/dashboard-shell': { DashboardShell: props => f.React.createElement('main', null, props.children) },
            './notification-workspace.css': {},
            'next/link': { __esModule: true, default: clientLink(f.React, navigations) },
        });
        await f.render(f.React.createElement(AutomationPageFrame, { locale: 'ja', section: 'notifications', title: '通知' }));
        for (const href of ['/dashboard/automation/plans', '/dashboard/automation/x']) {
            assert.equal(await clickNavigation(f, href), false, `${href} must fetch a new document`);
        }
        assert.deepEqual(navigations, []);
    } finally { await f.close(); }
});

test('the real payment Shell brand and sidebar use document navigation while ordinary dashboard navigation stays client-side', async () => {
    const f = await reactFixture('export {};');
    const navigations = [], routerPushes = [], documentTargets = [];
    try {
        // Keep the actual Shell, Workspace, navigation model and <a> handlers.
        // Unrelated account controls are replaced without intercepting links.
        const { DashboardShell } = loadDashboard('components/dashboard/dashboard-shell.tsx', {
            '@/components/dashboard/auth-buttons': { SignOutButton: () => null },
            '@/components/dashboard/guild-switcher': { GuildSwitcher: () => null },
            '@/components/dashboard/language-switcher': { LanguageSwitcher: () => null },
            'next/link': { __esModule: true, default: clientLink(f.React, navigations) },
            'next/navigation': { usePathname: () => '/dashboard/automation/plans', useRouter: () => ({ push: href => routerPushes.push(href) }) },
        });
        const targets = [
            ['/dashboard?mode=user', '.dashboard-brand'],
            ['/dashboard?mode=user', '.dashboard-primary-navigation a[href="/dashboard?mode=user"]'],
            ['/dashboard/automation', '.dashboard-primary-navigation a[href="/dashboard/automation"]'],
            ['/dashboard/personal-links', '.dashboard-primary-navigation a[href="/dashboard/personal-links"]'],
        ];
        for (const documentNavigation of [true, false]) {
            await f.render(f.React.createElement(DashboardShell, { locale: 'ja', documentNavigation }, f.React.createElement('p', null, '支払いページの内容')));
            const current = f.container.querySelector('.dashboard-primary-navigation a[aria-current="page"]');
            assert.equal(current.getAttribute('href'), '/dashboard/automation');
            for (const [href, selector] of targets) assert.equal(await clickNavigation(f, href, selector), !documentNavigation, `${selector} must respect the payment document boundary`);
            // Dispatch through the real Workspace listener. Swap only its
            // location sink during this synchronous event so jsdom performs no
            // real navigation; restore the browser before React can render.
            const browser = globalThis.window;
            const event = new f.dom.window.CustomEvent('dashboard:guild-navigation', { cancelable: true, detail: { href: '/dashboard/111111111111111111/providers' } });
            try {
                globalThis.window = { location: { assign: href => documentTargets.push(href) } };
                f.dom.window.dispatchEvent(event);
            } finally { globalThis.window = browser; }
            assert.equal(event.defaultPrevented, true);
        }
        assert.equal(navigations.length, targets.length, 'Only the ordinary shell is intercepted by the Next client link');
        assert.deepEqual(documentTargets, ['/dashboard/111111111111111111/providers']);
        assert.deepEqual(routerPushes, ['/dashboard/111111111111111111/providers'], 'Only an ordinary shell guild event uses router.push');
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
                '@/components/automation/notification-usage-overview': { NotificationUsageOverview: () => null },
                '@/components/dashboard/dashboard-shell': { DashboardShell: props => f.React.createElement('main', null, props.children) },
                '@/lib/server-locale': { getDashboardLocale: async () => 'ja' },
                '@/lib/ui-rollout': { usesNewDashboardUI: async () => true },
                './notification-workspace.css': {},
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

test('the legacy frame keeps the UI selection and also uses document navigation around payments', async () => {
    const f = await reactFixture('export {};');
    const navigations = [];
    try {
        const { AutomationPageFrame } = loadDashboard('components/automation/automation-page-frame.tsx', {
            '@/components/dashboard/dashboard-shell': { DashboardShell: () => { throw new Error('New Shell must not replace an explicit legacy selection'); } },
            './notification-workspace.css': {},
            'next/link': { __esModule: true, default: clientLink(f.React, navigations) },
            'next/navigation': { usePathname: () => '/dashboard/automation/plans', useRouter: () => ({ push() {} }) },
        });
        await f.render(f.React.createElement(AutomationPageFrame, { locale: 'ja', newUI: false, section: 'plans', title: '利用状況とプラン' }));
        assert.equal(f.container.querySelector('.dashboard-app'), null);
        for (const href of ['/dashboard', '/dashboard/automation', '/dashboard/personal-links', '/dashboard/automation/plans']) assert.equal(await clickNavigation(f, href), false);
        assert.deepEqual(navigations, []);
    } finally { await f.close(); }
});
