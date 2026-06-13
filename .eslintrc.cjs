'use strict';

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    'import/no-cycle': 'error',
  },
  overrides: [
    {
      // Core package must never import provider SDKs or DB drivers
      files: ['packages/core/src/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              'better-sqlite3',
              'pg',
              'postgres',
              'mysql*',
              'openai',
              '@anthropic-ai/*',
              '@google-ai/*',
              'cohere*',
              'replicate',
            ],
          },
        ],
        // Prevent direct process.env access outside config/ directory
        'no-restricted-syntax': [
          'error',
          {
            selector: 'MemberExpression[object.name="process"][property.name="env"]',
            message:
              'Direct process.env access is forbidden in core. Use config/secrets abstractions.',
          },
        ],
      },
      excludedFiles: ['packages/core/src/config/**'],
    },
    {
      files: ['**/*.test.ts', '**/*.spec.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        'no-restricted-imports': 'off',
        'no-restricted-syntax': 'off',
      },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', '*.js', '*.cjs', '*.mjs'],
};
