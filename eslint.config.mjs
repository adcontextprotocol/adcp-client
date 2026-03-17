/**
 * ESLint Configuration for AdCP Client
 *
 * Key rules:
 * - Prevent unsafe member access on `any` typed values (catches field name mismatches)
 * - Type-aware linting on testing code to catch schema/field mismatches at lint time
 */

import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  {
    ignores: ['dist/', 'node_modules/', '**/*.js', '!eslint.config.js'],
  },

  // Base TypeScript rules (all .ts files)
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Testing code — type-aware rules to catch field name mismatches on response data.
  // These rules require type information from the TypeScript compiler.
  {
    files: ['src/lib/testing/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
    },
  },
);
