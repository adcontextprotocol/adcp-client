'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { adcpError, applyAdcpErrorAllowlist } = require('../dist/lib/server/errors');

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
    assert.deepEqual(textError.details, error.details);
  });

  it('applyAdcpErrorAllowlist sanitizes hand-rolled AUTHORIZATION_REQUIRED envelopes too', () => {
    const filtered = applyAdcpErrorAllowlist('AUTHORIZATION_REQUIRED', {
      code: 'AUTHORIZATION_REQUIRED',
      message: 'Connect the TikTok creator identity before boosting this post.',
      details: unsafeAuthorizationDetails(),
    });

    assert.equal(filtered.details.refresh_token, undefined);
    assert.equal(filtered.details.missing_connections[0].access_token, undefined);
    assert.equal(filtered.details.missing_connections[0].resource_ref.private_note, undefined);
  });
});
