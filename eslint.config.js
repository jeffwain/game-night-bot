import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
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
];