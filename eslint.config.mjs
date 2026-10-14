import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'src/generated/**', 'coverage/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  // scripts/ is plain .mjs run by node, so no-undef is live there (it is off for
  // TypeScript, where tsc owns the question). Declaring the three globals the
  // scripts use beats pulling in the `globals` package for them.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', fetch: 'readonly', process: 'readonly' },
    },
  },
  {
    // The hard caps on size and complexity, each an error. Split a function or a file that goes
    // over one. Do not raise a value here, put an `eslint-disable` or an inline `/* eslint */`
    // config on one of these rules, or run ESLint's `--suppress-all` or `--suppress-rule`,
    // which would start an eslint-suppressions.json. Function length counts code lines only,
    // and file length counts every line.
    rules: {
      complexity: ['error', 25],
      'max-lines-per-function': [
        'error',
        { max: 150, skipBlankLines: true, skipComments: true },
      ],
      'max-depth': ['error', 4],
      'max-params': ['error', 6],
      'max-lines': ['error', 1000],
    },
  },
  {
    // A `describe` or `it` callback is a function, so in a test file the length cap would
    // measure a whole suite. Every other cap holds there, file length included.
    files: ['test/**', '**/*.test.{ts,mts,cts,js,mjs,cjs}'],
    rules: { 'max-lines-per-function': 'off' },
  },
);
