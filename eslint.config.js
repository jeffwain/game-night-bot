import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Catches the cronTz-style "used before declaration" bug
      'no-use-before-define': ['error', { functions: false, variables: true, classes: true }],
      // Unused imports like `path`/`fs` -> warning, not failure
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The control panel's client-side script. Same lint rules, but it runs in
    // a browser rather than in Node, so `document` and friends are the globals
    // that exist and `process` is not.
    files: ['src/web/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
];