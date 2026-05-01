/**
 * Server-side `VERSION_UNSUPPORTED` checks in `createAdcpServer`.
 *
 * Issue #1075: the dual-field disagreement check (PR #1067) only fires
 * when both `adcp_version` and `adcp_major_version` are present and the
 * majors disagree. A buyer that sends only one field — typically a
 * conformance harness probing the seller's version-negotiation path —
 * bypasses that check. This file covers:
 *
 * - The new single-field rejection (integer-only, string-only).
 * - The 3.1-style seller declaring `supported_versions` and no
 *   `major_versions`.
 * - The pre-existing dual-field disagreement check still fires.
 * - The `details.supported_versions` echo so buyers can downgrade their
 *   pin and retry.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { InMemoryStateStore } = require('../../dist/lib/index.js');
const { createAdcpServer } = require('../../dist/lib/server/legacy/v5/index.js');

async function callTool(server, toolName, params) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: toolName, arguments: params ?? {} },
  });
}

function buildServer(capabilities) {
  return createAdcpServer({
    name: 'version-test',
    version: '0.0.1',
    stateStore: new InMemoryStateStore(),
    validation: { requests: 'off', responses: 'off' },
    capabilities,
    mediaBuy: {
      getProducts: async () => ({ products: [{ id: 'prod-1', name: 'Display', channels: ['display'] }] }),
    },
  });
}

const VALID_GET_PRODUCTS = {
  brief: 'test campaign',
  promoted_offering: 'shoes',
  buying_mode: 'brief',
};

describe('createAdcpServer — VERSION_UNSUPPORTED single-field check (#1075)', () => {
  test('rejects single-field adcp_major_version: 99 against default 3.0 seller', async () => {
    const server = buildServer({ major_versions: [3] });
    const res = await callTool(server, 'get_products', {
      ...VALID_GET_PRODUCTS,
      adcp_major_version: 99,
    });

    assert.strictEqual(res.isError, true);
    assert.strictEqual(res.structuredContent.adcp_error.code, 'VERSION_UNSUPPORTED');
    assert.deepStrictEqual(res.structuredContent.adcp_error.details.supported_versions, ['3']);
    assert.match(
      res.structuredContent.adcp_error.message,
      /major 99/,
      'message must reference the buyer-claimed major'
    );
  });

  test('rejects single-field adcp_version: "99.0" against default 3.0 seller', async () => {
    const server = buildServer({ major_versions: [3] });
    const res = await callTool(server, 'get_products', {
      ...VALID_GET_PRODUCTS,
      adcp_version: '99.0',
    });

    assert.strictEqual(res.isError, true);
    assert.strictEqual(res.structuredContent.adcp_error.code, 'VERSION_UNSUPPORTED');
    assert.deepStrictEqual(res.structuredContent.adcp_error.details.supported_versions, ['3']);
    assert.match(res.structuredContent.adcp_error.message, /adcp_version="99\.0"/);
  });

  test('3.1-style seller (supported_versions only) rejects buyer claiming major 2', async () => {
    // Seller declares only the release-precision string list — no integer
    // `major_versions`. The single-field check must consult both lists
    // and union their parsed majors. 3.1.0 → major 3, so a buyer claiming
    // 2 is outside the window. The error echoes the seller's string list
    // verbatim so the buyer can downgrade and retry.
    const server = buildServer({ supported_versions: ['3.1.0'] });
    const res = await callTool(server, 'get_products', {
      ...VALID_GET_PRODUCTS,
      adcp_major_version: 2,
    });

    assert.strictEqual(res.isError, true);
    assert.strictEqual(res.structuredContent.adcp_error.code, 'VERSION_UNSUPPORTED');
    assert.deepStrictEqual(res.structuredContent.adcp_error.details.supported_versions, ['3.1.0']);
  });

  test('accepts in-window single-field claim (sanity)', async () => {
    const server = buildServer({ major_versions: [3] });
    const res = await callTool(server, 'get_products', {
      ...VALID_GET_PRODUCTS,
      adcp_major_version: 3,
    });

    assert.notStrictEqual(res.isError, true, 'in-window claim must dispatch normally');
    assert.ok(Array.isArray(res.structuredContent.products));
  });

  test('multi-version seller (major_versions: [2, 3]) accepts both majors', async () => {
    const server = buildServer({ major_versions: [2, 3] });
    const res2 = await callTool(server, 'get_products', { ...VALID_GET_PRODUCTS, adcp_major_version: 2 });
    const res3 = await callTool(server, 'get_products', { ...VALID_GET_PRODUCTS, adcp_major_version: 3 });

    assert.notStrictEqual(res2.isError, true);
    assert.notStrictEqual(res3.isError, true);
  });

  test('buyer omits both fields → no version check, dispatches normally', async () => {
    const server = buildServer({ major_versions: [3] });
    const res = await callTool(server, 'get_products', VALID_GET_PRODUCTS);

    assert.notStrictEqual(res.isError, true);
    assert.ok(Array.isArray(res.structuredContent.products));
  });

  test('seller with neither list falls back to server pin', async () => {
    // Default capabilities — no `major_versions`, no `supported_versions`.
    // Server pin (3.0.1 by default) drives the accepted set, so a 99
    // claim still trips VERSION_UNSUPPORTED instead of silently
    // dispatching against the bundle.
    const server = buildServer(undefined);
    const res = await callTool(server, 'get_products', { ...VALID_GET_PRODUCTS, adcp_major_version: 99 });

    assert.strictEqual(res.isError, true);
    assert.strictEqual(res.structuredContent.adcp_error.code, 'VERSION_UNSUPPORTED');
    assert.deepStrictEqual(res.structuredContent.adcp_error.details.supported_versions, ['3']);
  });
});

describe('createAdcpServer — VERSION_UNSUPPORTED dual-field disagreement (regression coverage)', () => {
  test('rejects when adcp_version and adcp_major_version disagree', async () => {
    // Pre-existing check from PR #1067; adding regression coverage so the
    // single-field work in #1075 doesn't accidentally weaken it.
    const server = buildServer({ major_versions: [3] });
    const res = await callTool(server, 'get_products', {
      ...VALID_GET_PRODUCTS,
      adcp_version: '3.1',
      adcp_major_version: 4,
    });

    assert.strictEqual(res.isError, true);
    assert.strictEqual(res.structuredContent.adcp_error.code, 'VERSION_UNSUPPORTED');
    assert.match(res.structuredContent.adcp_error.message, /majors must agree/);
    // #1075 also wires the `details.supported_versions` echo onto this
    // path so buyers can downgrade after either kind of failure.
    assert.deepStrictEqual(res.structuredContent.adcp_error.details.supported_versions, ['3']);
  });

  test('accepts when adcp_version and adcp_major_version agree', async () => {
    const server = buildServer({ major_versions: [3] });
    const res = await callTool(server, 'get_products', {
      ...VALID_GET_PRODUCTS,
      adcp_version: '3.0',
      adcp_major_version: 3,
    });

    assert.notStrictEqual(res.isError, true);
    assert.ok(Array.isArray(res.structuredContent.products));
  });
});
