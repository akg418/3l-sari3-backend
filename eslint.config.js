/**
 * Flat ESLint config using core rules only - no plugin dependencies to keep
 * installed and in sync. It catches the mistakes that actually matter here:
 * unused code, accidental globals, and unsafe comparisons.
 */
const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  structuredClone: 'readonly',
};

export default [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'no-return-await': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
    },
  },
  {
    // Tests may use the vitest globals-free API plus a few extra globals.
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...NODE_GLOBALS, WebSocket: 'readonly' },
    },
    rules: {
      'no-console': 'off',
    },
  },
];
