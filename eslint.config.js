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
    // The control panel's client-side scripts. Same lint rules, but they run
    // in a browser rather than in Node, so `document` and friends are the
    // globals that exist and `process` is not.
    //
    // ES modules: app.js imports the shared scorer from search.js, which the
    // Discord command layer imports as well so the two surfaces cannot rank
    // search results differently.
    files: ['src/web/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
];