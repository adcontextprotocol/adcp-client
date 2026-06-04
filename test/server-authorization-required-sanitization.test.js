'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { adcpError, applyAdcpErrorAllowlist } = require('../dist/lib/server/errors');
const { createAdcpServer } = require('../dist/lib/server/create-adcp-server');

async function callToolRaw(server, toolName, params) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: toolName, arguments: params ?? {} },
  });
}

const unsafeAuthorizationDetails = () => ({
  missing_connections: [
    {
      provider: 'tiktok',
      connection_type: 'publisher_identity',
      required_for: ['sync_creatives'],
      scope: 'identity',
      status: 'missing',
      resource_ref: {
        identity_id: 'creator_456',
        handle: '@acme',
        post_url: 'https://www.tiktok.com/@acme/video/123',
        private_note: 'internal routing note',
      },
      authorization_url: 'https://seller.example/connections/tiktok/creator_456',
      authorization_instructions: 'Connect @acme in TikTok Business Center, then retry.',
      access_token: 'secret_should_not_cross_wire',
      internal_role_bindings: ['admin'],
    },
  ],
  authorization_url: 'https://seller.example/connections',
  authorization_instructions: 'Connect the missing TikTok identity.',
  reference_authorization: {
    provider: 'tiktok',
    identity_id: 'creator_456',
    checked_at: '2026-06-04T12:34:56Z',
    refresh_token: 'secret_should_not_cross_wire',
  },
  refresh_token: 'secret_should_not_cross_wire',
  tenant_id: 'internal_tenant_1',
});

describe('AUTHORIZATION_REQUIRED detail sanitization', () => {
  it('adcpError drops accidental secrets and internal fields from downstream connection details', () => {
    const response = adcpError('AUTHORIZATION_REQUIRED', {
      message: 'Connect the TikTok creator identity before boosting this post.',
      field: 'creatives[0].assets[0].url',
      details: unsafeAuthorizationDetails(),
    });

    const error = response.structuredContent.adcp_error;
    assert.equal(error.code, 'AUTHORIZATION_REQUIRED');
    assert.equal(error.field, 'creatives[0].assets[0].url');
    assert.ok(error.details && typeof error.details === 'object', 'sanitized details must remain present');
    assert.ok(Array.isArray(error.details.missing_connections), 'missing_connections must remain present');
    assert.equal(error.details.refresh_token, undefined);
    assert.equal(error.details.tenant_id, undefined);

    const missing = error.details.missing_connections[0];
    assert.equal(missing.provider, 'tiktok');
    assert.equal(missing.connection_type, 'publisher_identity');
    assert.equal(missing.authorization_url, 'https://seller.example/connections/tiktok/creator_456');
    assert.equal(missing.access_token, undefined);
    assert.equal(missing.internal_role_bindings, undefined);
    assert.deepEqual(missing.resource_ref, {
      identity_id: 'creator_456',
      handle: '@acme',
      post_url: 'https://www.tiktok.com/@acme/video/123',
    });

    assert.deepEqual(error.details.reference_authorization, {
      provider: 'tiktok',
      identity_id: 'creator_456',
      checked_at: '2026-06-04T12:34:56Z',
    });

    const textError = JSON.parse(response.content[0].text).adcp_error;
    assert.ok(
      textError.details && typeof textError.details === 'object',
      'text fallback must retain sanitized details'
    );
    assert.deepEqual(textError.details, error.details);
  });

  it('applyAdcpErrorAllowlist sanitizes hand-rolled AUTHORIZATION_REQUIRED envelopes too', () => {
    const filtered = applyAdcpErrorAllowlist('AUTHORIZATION_REQUIRED', {
      code: 'AUTHORIZATION_REQUIRED',
      message: 'Connect the TikTok creator identity before boosting this post.',
      details: unsafeAuthorizationDetails(),
    });

    assert.ok(
      filtered.details && typeof filtered.details === 'object',
      'allowlisted envelope must retain sanitized details'
    );
    assert.ok(Array.isArray(filtered.details.missing_connections), 'missing_connections must remain present');
    assert.equal(filtered.details.refresh_token, undefined);
    assert.equal(filtered.details.missing_connections[0].access_token, undefined);
    assert.equal(filtered.details.missing_connections[0].resource_ref.private_note, undefined);
  });

  it('sanitizes typed errors[] arms before synthesizing the adcp_error envelope', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      validation: { requests: 'off', responses: 'off' },
      creative: {
        syncCreatives: async () => ({
          errors: [
            {
              code: 'AUTHORIZATION_REQUIRED',
              message: 'Connect the TikTok creator identity before boosting this post.',
              details: unsafeAuthorizationDetails(),
            },
          ],
        }),
      },
    });

    const response = await callToolRaw(server, 'sync_creatives', { creatives: [] });
    assert.equal(response.isError, true);

    const payloadError = response.structuredContent.errors[0];
    assert.equal(payloadError.code, 'AUTHORIZATION_REQUIRED');
    assert.ok(payloadError.details && typeof payloadError.details === 'object', 'payload details must remain present');
    assert.equal(payloadError.details.refresh_token, undefined);
    assert.equal(payloadError.details.tenant_id, undefined);
    assert.equal(payloadError.details.missing_connections[0].access_token, undefined);
    assert.equal(payloadError.details.missing_connections[0].resource_ref.private_note, undefined);

    const envelopeError = response.structuredContent.adcp_error;
    assert.ok(
      envelopeError.details && typeof envelopeError.details === 'object',
      'envelope details must remain present'
    );
    assert.deepEqual(envelopeError.details, payloadError.details);
    assert.doesNotMatch(JSON.stringify(response.structuredContent), /secret_should_not_cross_wire|internal_tenant_1/);
  });
});
