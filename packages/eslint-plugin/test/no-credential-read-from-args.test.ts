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
  ],
});
