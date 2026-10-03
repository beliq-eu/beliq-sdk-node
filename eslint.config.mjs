import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'src/generated/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
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
);
