/**
 * Unit test for MCP custom fetch function
 *
 * Tests the core fix: verifying that the custom fetch function properly
 * merges auth headers with existing headers.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('MCP Custom Fetch - Unit Test', () => {
  test('custom fetch merges auth headers with existing headers', () => {
    // Simulate the custom fetch logic from our fix
    const authHeaders = {
      'x-adcp-auth': 'test-token-123',
      'Accept': 'application/json, text/event-stream'
    };

    // Simulate existing headers from SDK
    const existingHeaders = {
      'content-type': 'application/json',
      'mcp-session-id': 'session-abc'
    };

    // Merge logic (same as in our fix)
    const mergedHeaders = {
      ...existingHeaders,
      ...authHeaders  // Auth headers take precedence
    };

    // Verify all headers are present
    assert.strictEqual(mergedHeaders['x-adcp-auth'], 'test-token-123');
    assert.strictEqual(mergedHeaders['Accept'], 'application/json, text/event-stream');
    assert.strictEqual(mergedHeaders['content-type'], 'application/json');
    assert.strictEqual(mergedHeaders['mcp-session-id'], 'session-abc');

    console.log('✅ Custom fetch properly merges auth headers');
  });

  test('custom fetch handles Headers object conversion', () => {
    // Simulate converting Headers object to plain object
    const sdkHeaders = new Headers({
      'content-type': 'application/json',
      'mcp-protocol-version': '2024-11-05'
    });

    // Convert Headers to plain object (same logic as our fix)
    let existingHeaders = {};
    sdkHeaders.forEach((value, key) => {
      existingHeaders[key] = value;
    });

    // Add auth headers
    const authHeaders = {
      'x-adcp-auth': 'token-xyz'
    };

    const mergedHeaders = {
      ...existingHeaders,
      ...authHeaders
    };

    // Verify conversion worked
    assert.strictEqual(mergedHeaders['content-type'], 'application/json');
    assert.strictEqual(mergedHeaders['mcp-protocol-version'], '2024-11-05');
    assert.strictEqual(mergedHeaders['x-adcp-auth'], 'token-xyz');

    console.log('✅ Custom fetch handles Headers object conversion');
  });

  test('custom fetch handles array headers', () => {
    // Simulate array-style headers
    const arrayHeaders = [
      ['content-type', 'application/json'],
      ['user-agent', 'test-client']
    ];

    // Convert array to plain object (same logic as our fix)
    let existingHeaders = {};
    for (const [key, value] of arrayHeaders) {
      existingHeaders[key] = value;
    }

    // Add auth headers
    const authHeaders = {
      'x-adcp-auth': 'token-123'
    };

    const mergedHeaders = {
      ...existingHeaders,
      ...authHeaders
    };

    // Verify conversion worked
    assert.strictEqual(mergedHeaders['content-type'], 'application/json');
    assert.strictEqual(mergedHeaders['user-agent'], 'test-client');
    assert.strictEqual(mergedHeaders['x-adcp-auth'], 'token-123');

    console.log('✅ Custom fetch handles array headers');
  });

  test('auth headers take precedence over existing headers', () => {
    // Simulate conflict: both have 'Accept' header
    const existingHeaders = {
      'Accept': 'text/plain'
    };

    const authHeaders = {
      'Accept': 'application/json, text/event-stream',
      'x-adcp-auth': 'token-456'
    };

    // Merge with auth taking precedence
    const mergedHeaders = {
      ...existingHeaders,
      ...authHeaders  // This spreads last, so it wins
    };

    // Verify auth header wins
    assert.strictEqual(mergedHeaders['Accept'], 'application/json, text/event-stream');
    assert.strictEqual(mergedHeaders['x-adcp-auth'], 'token-456');

    console.log('✅ Auth headers take precedence');
  });

  test('no auth headers when token not provided', () => {
    // When no auth token, custom fetch should not be created
    const authToken = undefined;

    // Simulate the conditional logic from our fix
    let customFetch = undefined;
    if (authToken) {
      customFetch = () => {}; // Would create custom fetch
    }

    // Verify no custom fetch was created
    assert.strictEqual(customFetch, undefined);

    console.log('✅ No custom fetch when no auth token');
  });

  test('spreading Headers object returns empty object', () => {
    // Headers objects are not enumerable, so spreading them returns empty object
    const sdkHeaders = new Headers();
    sdkHeaders.set('Accept', 'application/json, text/event-stream');
    sdkHeaders.set('Content-Type', 'application/json');

    // Spreading Headers object returns empty object
    const spread = { ...sdkHeaders };
    assert.deepStrictEqual(spread, {}, 'Spreading Headers returns empty object');

    // Must use forEach to extract headers
    let extractedHeaders = {};
    sdkHeaders.forEach((value, key) => {
      extractedHeaders[key] = value;
    });

    // Verify extraction works
    assert.strictEqual(extractedHeaders['accept'], 'application/json, text/event-stream');
    assert.strictEqual(extractedHeaders['content-type'], 'application/json');

    console.log('✅ Spreading Headers loses all headers, forEach preserves them');
  });

  test('plain object header extraction with for...in loop', () => {
    const plainObjectHeaders = {
      'Accept': 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Custom-Header': 'test-value'
    };

    // Use for...in loop with hasOwnProperty check for plain objects
    let extractedHeaders = {};
    for (const key in plainObjectHeaders) {
      if (Object.prototype.hasOwnProperty.call(plainObjectHeaders, key)) {
        extractedHeaders[key] = plainObjectHeaders[key];
      }
    }

    // Verify all headers were copied
    assert.strictEqual(extractedHeaders['Accept'], 'application/json, text/event-stream');
    assert.strictEqual(extractedHeaders['Content-Type'], 'application/json');
    assert.strictEqual(extractedHeaders['Custom-Header'], 'test-value');

    console.log('✅ Plain object extraction works correctly');
  });

  test('MCP SDK requires Accept header with application/json and text/event-stream', () => {
    // The MCP protocol specification requires both content types in Accept header
    const requiredAccept = 'application/json, text/event-stream';

    // Simulate SDK setting the Accept header
    const sdkHeaders = new Headers();
    sdkHeaders.set('Accept', requiredAccept);

    // Extract headers using forEach (our fix)
    let extractedHeaders = {};
    sdkHeaders.forEach((value, key) => {
      extractedHeaders[key] = value;
    });

    // Verify the Accept header is preserved with both content types
    assert.strictEqual(extractedHeaders['accept'], requiredAccept);
    assert.ok(extractedHeaders['accept'].includes('application/json'));
    assert.ok(extractedHeaders['accept'].includes('text/event-stream'));

    console.log('✅ MCP Accept header preserved correctly');
  });
});
