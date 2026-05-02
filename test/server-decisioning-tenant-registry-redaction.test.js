'use strict';

// #1330 — tenant-registry redaction hardening. The TenantStatus.reason
// field flows to the wire via the admin router (`GET /tenants/:id`,
// `POST /tenants/:id/recheck`). Three sites in tenant-registry.ts and
// one in admin-router.ts project `err.message` from upstream code into
// the reason; without redaction, an upstream library that includes
// credential bytes in its error message leaks them on the admin wire.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createTenantRegistry, createSelfSignedTenantKey } = require('../dist/lib/server/decisioning/tenant-registry');

const DEFAULT_SERVER_OPTIONS = { capabilities: { specialisms: [] } };

function basePlatform() {
  return {
    capabilities: { specialisms: [], creative_agents: [], channels: [], pricingModels: [], config: {} },
    accounts: {
      resolve: async () => null,
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
  };
}

function fakeValidator(impl) {
  return { validate: impl };
}

let SAMPLE_KEY;
async function ensureSampleKey() {
  if (!SAMPLE_KEY) SAMPLE_KEY = await createSelfSignedTenantKey('kid-test');
  return SAMPLE_KEY;
}

describe('#1330 — tenant-registry redacts credentials from validator error messages', () => {
  it('validator throw with bearer token in message → reason has token redacted', async () => {
    const sampleKey = await ensureSampleKey();
    const validator = fakeValidator(async () => {
      throw new Error('upstream auth failure: Bearer sk_live_secret_value_abc123');
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });
    registry.register('t1', {
      agentUrl: 'https://t1.example.com',
      signingKey: sampleKey,
      platform: basePlatform(),
    });

    const status = await registry.recheck('t1');
    assert.equal(status.health, 'pending');
    assert.ok(status.reason);
    assert.equal(
      status.reason.includes('sk_live_secret_value_abc123'),
      false,
      `reason leaked credential: ${status.reason}`
    );
    assert.match(status.reason, /Bearer <redacted>/);
  });

  it('validator throw with token=value in message → reason has labeled credential redacted', async () => {
    const sampleKey = await ensureSampleKey();
    const validator = fakeValidator(async () => {
      throw new Error('upstream rejected: token=abc123def456ghi789jkl');
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });
    registry.register('t2', {
      agentUrl: 'https://t2.example.com',
      signingKey: sampleKey,
      platform: basePlatform(),
    });

    const status = await registry.recheck('t2');
    assert.equal(status.reason.includes('abc123def456ghi789jkl'), false, `reason leaked credential: ${status.reason}`);
    assert.match(status.reason, /token=<redacted>/);
  });

  it('validator throw with URL-embedded credential → password redacted, scheme + user preserved', async () => {
    const sampleKey = await ensureSampleKey();
    const validator = fakeValidator(async () => {
      throw new Error('failed to GET https://service:supersecretpassword@vendor.example/jwks');
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });
    registry.register('t3', {
      agentUrl: 'https://t3.example.com',
      signingKey: sampleKey,
      platform: basePlatform(),
    });

    const status = await registry.recheck('t3');
    assert.equal(status.reason.includes('supersecretpassword'), false);
    assert.match(status.reason, /https:\/\/service:<redacted>@vendor\.example/);
  });

  it('benign error messages pass through unchanged (no false-positive redaction)', async () => {
    const sampleKey = await ensureSampleKey();
    const validator = fakeValidator(async () => {
      throw new Error('connection reset by peer');
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });
    registry.register('t4', {
      agentUrl: 'https://t4.example.com',
      signingKey: sampleKey,
      platform: basePlatform(),
    });

    const status = await registry.recheck('t4');
    assert.match(status.reason, /connection reset by peer/);
  });
});
