const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'test-results/', 'playwright-report/', 'data/', '.local/'] },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'tools/**/*.js', 'tests/**/*.js', '*.config.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } }
  },
  {
    // The app: native ES modules in the browser, no build step
    files: ['public/assets/js/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser } }
  },
  {
    files: ['tests/e2e/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } }
  },
  { rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] } }
];
