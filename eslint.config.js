'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            'no-unused-vars': ['warn', {
                args: 'none',
                caughtErrors: 'none',
                varsIgnorePattern: '^_',
            }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-constant-condition': ['warn', { checkLoops: false }],
            'no-async-promise-executor': 'off',
            'no-inner-declarations': 'off',
            'no-prototype-builtins': 'off',
        },
    },
    {
        files: ['admin-agent/web/**/*.js'],
        languageOptions: {
            globals: globals.browser,
        },
    },
    {
        files: ['docs/angelic-angel/node-startup-clean-ab/*.mjs'],
        languageOptions: { sourceType: 'module' },
    },
    {
        files: ['client/angelic-setup/Read-PushSubscription.js'],
        languageOptions: {
            sourceType: 'script',
            globals: { ...globals.browser, ChromeUtils: 'readonly', Services: 'readonly', Ci: 'readonly' },
        },
        // Rejecting control bytes is intentional in this input validator.
        rules: { 'no-control-regex': 'off' },
    },
    {
        ignores: [
            'node_modules/**',
            'packages/angelic-angel/**',
            'experiments/angelic-push/**',
            'dashboard/**',
            'saves/**',
            'scripts/**',
            '__*.js',
            'settings.json',
            'config.json',
        ],
    },
];
