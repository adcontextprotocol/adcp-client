/**
 * ESLint Configuration for AdCP Client
 *
 * Key rules:
 * - Prevent direct protocol SDK imports in server code (use @adcp/client library)
 * - Maintain code quality standards
 */

module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  rules: {
    // Prevent bypassing library type safety by importing protocol SDKs directly
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
            message:
              'Import from @adcp/client library instead of MCP SDK directly. ' +
              'Server code must use the type-safe library to prevent invalid requests.',
            allowImportNames: [], // No exceptions - always use library
          },
          {
            group: ['@a2a-js/sdk', '@a2a-js/sdk/*'],
            message:
              'Import from @adcp/client library instead of A2A SDK directly. ' +
              'Server code must use the type-safe library to prevent invalid requests.',
            allowImportNames: [], // No exceptions - always use library
          },
        ],
        paths: [
          {
            name: '@modelcontextprotocol/sdk',
            message: 'Import from @adcp/client library instead of MCP SDK directly.',
          },
          {
            name: '@a2a-js/sdk',
            message: 'Import from @adcp/client library instead of A2A SDK directly.',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // Library code CAN import protocol SDKs (it wraps them)
      files: ['src/lib/**/*.ts', 'src/lib/**/*.js'],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
    {
      // Server code MUST NOT import protocol SDKs (use library)
      files: ['src/server/**/*.ts', 'src/server/**/*.js', 'server.js'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', '@a2a-js/sdk', '@a2a-js/sdk/*'],
                message:
                  '❌ Server code must use @adcp/client library, not protocol SDKs directly. ' +
                  'This ensures type safety and prevents invalid requests like adcp_version being sent to agents.',
              },
            ],
          },
        ],
      },
    },
    {
      // TypeScript files
      files: ['*.ts', '**/*.ts'],
      parser: '@typescript-eslint/parser',
      plugins: ['@typescript-eslint'],
      extends: ['plugin:@typescript-eslint/recommended'],
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
  ],
};
