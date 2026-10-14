import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default [
  { ignores: ['dist/**', 'legacy-rust/**', 'compat-rust/**', 'node_modules/**'] },
  { ...js.configs.recommended, files: ['**/*.mjs'], languageOptions: { globals: globals.node } },
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['src/**/*.ts'] })),
  { files: ['src/**/*.ts'], rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } }
];
