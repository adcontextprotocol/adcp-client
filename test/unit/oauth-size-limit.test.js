/**
 * Unit tests for response-size cap on OAuth perimeter (#1175).
 *
 * `exchangeClientCredentials` (token endpoint) and `discoverOAuthMetadata`
 * (well-known metadata) used raw `fetch` until #1175. Both now wrap with
 * `wrapFetchWithSizeLimit`, so a hostile AS that buffer-bombs from either
 * endpoint hits the same cap that protects the MCP/A2A response paths.
 *
 * Tests exercise the compiled `dist/` output to pin shipped behavior.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { exchangeClientCredentials } = require('../../dist/lib/auth/oauth/ClientCredentialsFlow');
const { discoverOAuthMetadata } = require('../../dist/lib/auth/oauth/discovery');
const { withResponseSizeLimit } = require('../../dist/lib/protocols/responseSizeLimit');
const { ResponseTooLargeError } = require('../../dist/lib/errors');

describe('OAuth perimeter response-size cap (#1175)', () => {
  describe('exchangeClientCredentials', () => {
    const credentials = {
      token_endpoint: 'https://as.example.invalid/oauth/token',
      client_id: 'cid',
      client_secret: 'csecret',
    };

    it('refuses oversized token responses when a size-limit slot is active', async () => {
      const oversized = JSON.stringify({ access_token: 'x'.repeat(10_000), token_type: 'Bearer' });
      const hostileFetch = async () =>
        new Response(oversized, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(oversized)),
          },
        });

      await assert.rejects(
        withResponseSizeLimit(500, () =>
          exchangeClientCredentials(credentials, { fetch: hostileFetch, allowPrivateIp: true })
        ),
        err => {
          // The cap throws ResponseTooLargeError before parsing; the OAuth
          // wrapper rethrows it as a ClientCredentialsExchangeError with the
          // 'network' kind. Either surfaces correctly — we accept both.
          if (err instanceof ResponseTooLargeError) {
            assert.strictEqual(err.code, 'RESPONSE_TOO_LARGE');
            return true;
          }
          assert.ok(err.message.includes('exceeds maxResponseBytes') || err.cause instanceof ResponseTooLargeError);
          return true;
        }
      );
    });

    it('passes responses through when no size-limit slot is active', async () => {
      const ok = JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 });
      const benignFetch = async () =>
        new Response(ok, {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(ok)) },
        });

      // No `withResponseSizeLimit` wrapper — the wrapper must be a no-op so
      // direct callers without the option pay nothing.
      const tokens = await exchangeClientCredentials(credentials, { fetch: benignFetch, allowPrivateIp: true });
      assert.strictEqual(tokens.access_token, 'tok');
    });
  });

  describe('discoverOAuthMetadata', () => {
    it('refuses oversized metadata responses when a size-limit slot is active', async () => {
      const oversized = JSON.stringify({
        authorization_endpoint: 'https://as.example.invalid/auth',
        token_endpoint: 'https://as.example.invalid/token',
        // Pad to exceed the cap — discovery doesn't validate size of any
        // single field, so a hostile AS can stuff arbitrary data here.
        scopes_supported: Array.from({ length: 1000 }, (_, i) => `scope_${i}_${'x'.repeat(40)}`),
      });
      const hostileFetch = async () =>
        new Response(oversized, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(oversized)),
          },
        });

      // discoverOAuthMetadata swallows individual URL errors and returns
      // null after exhausting candidates. Under a tight cap, both URL
      // attempts fail with ResponseTooLargeError → function returns null.
      const result = await withResponseSizeLimit(500, () =>
        discoverOAuthMetadata('https://agent.example.invalid/mcp', { fetch: hostileFetch })
      );
      assert.strictEqual(result, null, 'oversized metadata must not surface as a successful discovery');
    });

    it('passes metadata through when no size-limit slot is active', async () => {
      const ok = JSON.stringify({
        authorization_endpoint: 'https://as.example.invalid/auth',
        token_endpoint: 'https://as.example.invalid/token',
      });
      const benignFetch = async () =>
        new Response(ok, {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(ok)) },
        });

      const metadata = await discoverOAuthMetadata('https://agent.example.invalid/mcp', { fetch: benignFetch });
      assert.ok(metadata, 'discovery must succeed without a size-limit slot');
      assert.strictEqual(metadata.token_endpoint, 'https://as.example.invalid/token');
    });
  });
});
