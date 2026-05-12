/**
 * Tests for AuthenticationRequiredError
 *
 * Verifies that MCP endpoint discovery correctly handles 401 Unauthorized
 * responses by throwing AuthenticationRequiredError with OAuth metadata.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import error class from built library
const { AuthenticationRequiredError, isADCPError, isErrorOfType, is401Error } = require('../../dist/lib/errors');

describe('AuthenticationRequiredError', () => {
  describe('constructor', () => {
    test('creates error with OAuth metadata', () => {
      const oauthMetadata = {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
      };

      const error = new AuthenticationRequiredError('https://agent.example.com/mcp', oauthMetadata);

      assert.strictEqual(error.agentUrl, 'https://agent.example.com/mcp');
      assert.strictEqual(error.oauthMetadata.authorization_endpoint, 'https://auth.example.com/authorize');
      assert.strictEqual(error.code, 'AUTHENTICATION_REQUIRED');
      assert.ok(error.message.includes('https://auth.example.com/authorize'));
    });

    test('creates error without OAuth metadata', () => {
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp');

      assert.strictEqual(error.agentUrl, 'https://agent.example.com/mcp');
      assert.strictEqual(error.oauthMetadata, undefined);
      assert.ok(error.message.includes('provide auth_token'));
    });

    test('creates error with custom message', () => {
      const error = new AuthenticationRequiredError(
        'https://agent.example.com/mcp',
        undefined,
        'Custom auth error message'
      );

      assert.strictEqual(error.message, 'Custom auth error message');
    });
  });

  describe('hasOAuth getter', () => {
    test('returns true when OAuth metadata present', () => {
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp', {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      });

      assert.strictEqual(error.hasOAuth, true);
    });

    test('returns false when OAuth metadata absent', () => {
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp');

      assert.strictEqual(error.hasOAuth, false);
    });
  });

  describe('authorizationUrl getter', () => {
    test('returns authorization endpoint when OAuth metadata present', () => {
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp', {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      });

      assert.strictEqual(error.authorizationUrl, 'https://auth.example.com/authorize');
    });

    test('returns undefined when OAuth metadata absent', () => {
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp');

      assert.strictEqual(error.authorizationUrl, undefined);
    });
  });

  describe('error type checking', () => {
    test('is recognized as ADCP error', () => {
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp');

      assert.strictEqual(isADCPError(error), true);
    });

    test('can be type checked with isErrorOfType', () => {
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp');

      assert.strictEqual(isErrorOfType(error, AuthenticationRequiredError), true);
    });
  });

  describe('details property', () => {
    test('contains agentUrl and oauthMetadata', () => {
      const oauthMetadata = {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      };

      const error = new AuthenticationRequiredError('https://agent.example.com/mcp', oauthMetadata);

      assert.strictEqual(error.details.agentUrl, 'https://agent.example.com/mcp');
      assert.deepStrictEqual(error.details.oauthMetadata, oauthMetadata);
    });

    test('contains challenge when provided', () => {
      const challenge = { scheme: 'basic', realm: 'API', params: { realm: 'API' } };
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp', undefined, undefined, challenge);
      assert.deepStrictEqual(error.details.challenge, challenge);
    });
  });

  describe('scheme-aware default message', () => {
    test('Basic challenge → message names HTTP Basic and points at SDK + CLI shapes', () => {
      // Gateway-fronted agent: a Basic challenge should NOT teleport consumers
      // at OAuth metadata. The message names the SDK shape and the CLI shape so
      // the same envelope serves library and CLI consumers without an extra
      // hop through docs.
      const challenge = {
        scheme: 'basic',
        realm: 'Apigee',
        params: { realm: 'Apigee' },
      };
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp', undefined, undefined, challenge);
      assert.match(error.message, /HTTP Basic/);
      assert.match(error.message, /createTestClient\({ auth: { type: 'basic'/);
      assert.match(error.message, /--auth-scheme basic/);
      // Must NOT mention OAuth — the consumer should not bounce through a flow
      // that will never succeed against a BasicAuthentication gateway.
      assert.doesNotMatch(error.message, /OAuth/);
      assert.doesNotMatch(error.message, /provide auth_token/);
    });

    test('non-Bearer non-Basic challenge → generic remediation with scheme name', () => {
      const challenge = { scheme: 'digest', realm: 'corp', params: { realm: 'corp' } };
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp', undefined, undefined, challenge);
      assert.match(error.message, /digest/);
      assert.match(error.message, /realm: corp/);
      assert.match(error.message, /not natively supported/);
    });

    test('Bearer challenge with OAuth metadata → OAuth message (Bearer-scheme branch falls through)', () => {
      // When the challenge IS Bearer, the OAuth-metadata branch wins — that's
      // the path the existing OAuth-discovery flow already exercises.
      const challenge = { scheme: 'bearer', params: {} };
      const oauthMetadata = {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      };
      const error = new AuthenticationRequiredError(
        'https://agent.example.com/mcp',
        oauthMetadata,
        undefined,
        challenge
      );
      assert.match(error.message, /OAuth available at: https:\/\/auth\.example\.com\/authorize/);
    });

    test('no challenge, no oauthMetadata → legacy fallback message (back-compat)', () => {
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp');
      assert.match(error.message, /No OAuth metadata available - provide auth_token/);
    });

    test('custom message wins over scheme-aware default', () => {
      const challenge = { scheme: 'basic', realm: 'x', params: { realm: 'x' } };
      const error = new AuthenticationRequiredError(
        'https://agent.example.com/mcp',
        undefined,
        'Custom message here',
        challenge
      );
      assert.strictEqual(error.message, 'Custom message here');
    });
  });

  describe('suggestedScheme getter', () => {
    test('returns the lowercased scheme from the challenge', () => {
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp', undefined, undefined, {
        scheme: 'basic',
        params: {},
      });
      assert.strictEqual(error.suggestedScheme, 'basic');
    });

    test('returns undefined when no challenge supplied', () => {
      const error = new AuthenticationRequiredError('https://agent.example.com/mcp');
      assert.strictEqual(error.suggestedScheme, undefined);
    });
  });
});

describe('is401Error', () => {
  describe('with got401Flag', () => {
    test('returns true when got401Flag is true', () => {
      assert.strictEqual(is401Error(new Error('some error'), true), true);
    });

    test('returns true when got401Flag is true even with null error', () => {
      assert.strictEqual(is401Error(null, true), true);
    });
  });

  describe('with status property', () => {
    test('returns true when error.status is 401', () => {
      const error = { status: 401, message: 'Forbidden' };
      assert.strictEqual(is401Error(error), true);
    });

    test('returns true when error.response.status is 401', () => {
      const error = { response: { status: 401 }, message: 'Forbidden' };
      assert.strictEqual(is401Error(error), true);
    });

    test('returns true when error.cause.status is 401', () => {
      const error = { cause: { status: 401 }, message: 'Forbidden' };
      assert.strictEqual(is401Error(error), true);
    });

    test('returns false when status is not 401', () => {
      const error = { status: 403, message: 'Forbidden' };
      assert.strictEqual(is401Error(error), false);
    });
  });

  describe('with error message', () => {
    test('returns true when message contains "401"', () => {
      const error = new Error('HTTP 401: Not authenticated');
      assert.strictEqual(is401Error(error), true);
    });

    test('returns true when message contains "Unauthorized"', () => {
      const error = new Error('Request failed: Unauthorized');
      assert.strictEqual(is401Error(error), true);
    });

    test('returns false when message does not indicate 401', () => {
      const error = new Error('HTTP 403: Forbidden');
      assert.strictEqual(is401Error(error), false);
    });
  });

  describe('edge cases', () => {
    test('returns false for null error', () => {
      assert.strictEqual(is401Error(null), false);
    });

    test('returns false for undefined error', () => {
      assert.strictEqual(is401Error(undefined), false);
    });

    test('returns false for empty object', () => {
      assert.strictEqual(is401Error({}), false);
    });

    test('returns false for string error', () => {
      assert.strictEqual(is401Error('some error'), false);
    });
  });
});
