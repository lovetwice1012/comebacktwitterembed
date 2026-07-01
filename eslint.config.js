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
        ignores: [
            'node_modules/**',
            'dashboard/**',
            'saves/**',
            'scripts/**',
            '__*.js',
            'settings.json',
            'config.json',
        ],
    },
];
