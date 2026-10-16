/**
 * Dependency-direction lint: nothing the SDK publishes may import `@adcp/reporting-storage`.
 *
 * The storage package depends on `@adcp/sdk` (a peer dependency), never the other way round. This is a
 * separate flat config, not part of `eslint.config.mjs`, so it can run over all of `src/`, `bin/` and
 * `examples/` without pulling the repository's general lint rules over code they were never applied to.
 * `test/lib/reporting-storage-boundary.test.js` checks the same rule, plus the reverse direction (the
 * storage package imports only public `@adcp/sdk` subpaths), without ESLint.
 *
 *   npm run lint:boundaries
 */
import tseslint from 'typescript-eslint';

const STORAGE = '@adcp/reporting-storage';
const message =
  '@adcp/sdk must not import @adcp/reporting-storage. The storage package depends on the SDK, not the reverse. ' +
  'See docs/guides/REPORTING-STABILITY.md and test/lib/reporting-storage-boundary.test.js.';

const restrictedSyntax = [
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=/^${STORAGE.replace('/', '\\/')}(\\/|$)/]`,
    message,
  },
  {
    selector: `ImportExpression[source.value=/^${STORAGE.replace('/', '\\/')}(\\/|$)/]`,
    message,
  },
];

export default [
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  // Existing `eslint-disable` comments name rules from other configs; reporting them as unused or unknown
  // is not this config's job.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['**/*.ts', '**/*.tsx'],
    // The plugin is loaded (no rules enabled) so inline directives that name its rules resolve. `ban-types` was
    // removed from typescript-eslint but is still named by one directive in `src/`, hence the inert stand-in.
    plugins: {
      '@typescript-eslint': {
        ...tseslint.plugin,
        rules: { ...tseslint.plugin.rules, 'ban-types': { meta: { schema: [] }, create: () => ({}) } },
      },
    },
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: [STORAGE, `${STORAGE}/*`], message }] }],
      'no-restricted-syntax': ['error', ...restrictedSyntax],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2023 },
    rules: {
      'no-restricted-syntax': ['error', ...restrictedSyntax],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module', ecmaVersion: 2023 },
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: [STORAGE, `${STORAGE}/*`], message }] }],
    },
  },
];
