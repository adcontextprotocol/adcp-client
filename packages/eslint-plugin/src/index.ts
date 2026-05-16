/**
 * @adcp/eslint-plugin entry.
 *
 * Exposes the rules namespace and a `recommended` config. Adopters wire it
 * as:
 *
 * ```js
 * // .eslintrc.cjs
 * module.exports = {
 *   plugins: ['@adcp'],
 *   extends: ['plugin:@adcp/recommended'],
 * };
 * ```
 *
 * Or, in flat-config style:
 *
 * ```js
 * import adcp from '@adcp/eslint-plugin';
 *
 * export default [
 *   {
 *     plugins: { '@adcp': adcp },
 *     rules: { '@adcp/no-credential-read-from-args': 'error' },
 *   },
 * ];
 * ```
 */

import noCredentialReadFromArgs from './rules/no-credential-read-from-args';

export const rules = {
  'no-credential-read-from-args': noCredentialReadFromArgs,
};

export const configs = {
  recommended: {
    plugins: ['@adcp'],
    rules: {
      '@adcp/no-credential-read-from-args': 'error',
    },
  },
};
