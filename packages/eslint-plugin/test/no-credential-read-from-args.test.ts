/**
 * Tests for `no-credential-read-from-args`. Uses `@typescript-eslint/utils`'s
 * RuleTester (parser-agnostic) with the TypeScript parser so destructure /
 * method-shorthand cases parse cleanly. RuleTester's `it`/`describe` is
 * shimmed onto node:test below.
 */

import { RuleTester } from '@typescript-eslint/utils/ts-eslint';
import { describe, it } from 'node:test';
import rule from '../src/rules/no-credential-read-from-args';

RuleTester.afterAll = () => {};
RuleTester.describe = (name, fn) => describe(name, fn);
RuleTester.it = (name, fn) => it(name, fn);
RuleTester.itOnly = (name, fn) => it.only(name, fn);

const ruleTester = new RuleTester({
  languageOptions: {
    parser: require('@typescript-eslint/parser'),
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
});

ruleTester.run('no-credential-read-from-args', rule, {
  valid: [
    {
      name: 'non-credential read inside extractContext',
      code: `
        const platform = {
          extractContext(args) {
            return { sessionId: args.session_id };
          },
        };
      `,
    },
    {
      name: 'credential read OUTSIDE extractContext / synthesizeFromArgs (rule is scoped)',
      code: `
        function someOtherFn(args) {
          return args.access_token;
        }
      `,
    },
    {
      name: 'non-credential nested read inside synthesizeFromArgs',
      code: `
        const platform = {
          synthesizeFromArgs(args) {
            return { account: args.context.account_id };
          },
        };
      `,
    },
    {
      name: 'credential-shaped key inside an unrelated method name',
      code: `
        const platform = {
          handleRequest(args) {
            return args.access_token;
          },
        };
      `,
    },
    {
      name: 'free-standing function named extractContext — not a method binding (no false positive)',
      code: `
        function extractContext(args) {
          return args.access_token;
        }
      `,
    },
    {
      name: 'spread aliasing is a documented gap and stays valid in lint',
      code: `
        const platform = {
          extractContext(args) {
            const ctx = { ...args };
            return ctx.access_token;
          },
        };
      `,
    },
    {
      name: 'plain aliasing is a documented gap and stays valid in lint',
      code: `
        const platform = {
          extractContext(args) {
            const a = args;
            return a.access_token;
          },
        };
      `,
    },
    {
      name: 'destructure-then-read of a non-credential key',
      code: `
        const platform = {
          extractContext(args) {
            const { session_id } = args;
            return { sessionId: session_id };
          },
        };
      `,
    },
  ],
  invalid: [
    {
      name: 'args.access_token inside extractContext',
      code: `
        const platform = {
          extractContext(args) {
            return { token: args.access_token };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.access_token' } }],
    },
    {
      name: 'vendor-prefixed credential inside extractContext',
      code: `
        const platform = {
          extractContext(args) {
            return { token: args.snap_access_token };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.snap_access_token' } }],
    },
    {
      name: 'args.api_key inside extractContext',
      code: `
        const platform = {
          extractContext(args) {
            return { key: args.api_key };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.api_key' } }],
    },
    {
      name: 'nested args.context.access_token inside extractContext',
      code: `
        const platform = {
          extractContext(args) {
            return { token: args.context.access_token };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.context.access_token' } }],
    },
    {
      name: 'args.client_secret inside synthesizeFromArgs',
      code: `
        const platform = {
          synthesizeFromArgs(args) {
            return { secret: args.client_secret };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.client_secret' } }],
    },
    {
      name: 'vendor-prefixed credential inside synthesizeFromArgs',
      code: `
        const platform = {
          synthesizeFromArgs(args) {
            return { token: args.linkedin_access_token };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.linkedin_access_token' } }],
    },
    {
      name: 'destructured credential param in extractContext',
      code: `
        const platform = {
          extractContext({ access_token, session_id }) {
            return { token: access_token, sessionId: session_id };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.access_token' } }],
    },
    {
      name: 'class method shorthand — extractContext on a class',
      code: `
        class MyPlatform {
          extractContext(args) {
            return { token: args.bearer };
          }
        }
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.bearer' } }],
    },
    {
      name: 'arrow-form synthesizeFromArgs assigned in object literal',
      code: `
        const platform = {
          synthesizeFromArgs: (args) => ({ key: args.api_key }),
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.api_key' } }],
    },
    {
      name: 'computed string-literal access flags',
      code: `
        const platform = {
          extractContext(args) {
            return args['access_token'];
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.access_token' } }],
    },
    {
      name: 'destructure-then-read inside extractContext',
      code: `
        const platform = {
          extractContext(args) {
            const { access_token } = args;
            return { token: access_token };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.access_token' } }],
    },
    {
      name: 'destructure-then-read with rename — fires on source key, not alias',
      code: `
        const platform = {
          extractContext(args) {
            const { access_token: tok } = args;
            return { token: tok };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.access_token' } }],
    },
    {
      name: 'default-value first param does not silently disable scanning',
      code: `
        const platform = {
          extractContext(args = {}) {
            return args.access_token;
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.access_token' } }],
    },
    {
      name: 'destructure-with-default first param',
      code: `
        const platform = {
          extractContext({ access_token } = {}) {
            return { token: access_token };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.access_token' } }],
    },
    {
      name: 'nested destructure in first param',
      code: `
        const platform = {
          extractContext({ context: { access_token } }) {
            return { token: access_token };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.context.access_token' } }],
    },
    {
      name: 'nested destructure with rename — fires on source key, not alias',
      code: `
        const platform = {
          extractContext({ context: { access_token: tok } }) {
            return { token: tok };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.context.access_token' } }],
    },
    {
      name: 'additionalPatterns flags a custom upstream credential name',
      code: `
        const platform = {
          extractContext(args) {
            return { token: args.platform_session_key };
          },
        };
      `,
      options: [{ additionalPatterns: ['platform_session_key'] }],
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.platform_session_key' } }],
    },
    {
      name: 'additionalPatterns flags a destructured custom credential name',
      code: `
        const platform = {
          extractContext(args) {
            const { vendor_bearer } = args;
            return { token: vendor_bearer };
          },
        };
      `,
      options: [{ additionalPatterns: ['vendor_bearer'] }],
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.vendor_bearer' } }],
    },
    {
      name: 'destructure-then-read with default value in declarator',
      code: `
        const platform = {
          extractContext(args) {
            const { access_token = 'fallback' } = args;
            return { token: access_token };
          },
        };
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.access_token' } }],
    },
    {
      name: 'class method — destructure-then-read still fires (regression for FunctionDeclaration drop)',
      code: `
        class MyPlatform {
          extractContext(args) {
            const { access_token } = args;
            return { token: access_token };
          }
        }
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.access_token' } }],
    },
    {
      name: 'class method — default-value param still fires',
      code: `
        class MyPlatform {
          extractContext(args = {}) {
            return { token: args.access_token };
          }
        }
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.access_token' } }],
    },
    {
      name: 'class method — nested destructure still fires',
      code: `
        class MyPlatform {
          extractContext({ context: { access_token } }) {
            return { token: access_token };
          }
        }
      `,
      errors: [{ messageId: 'credentialReadFromArgs', data: { path: 'args.context.access_token' } }],
    },
  ],
});
