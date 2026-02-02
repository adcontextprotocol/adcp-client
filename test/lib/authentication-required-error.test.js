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
