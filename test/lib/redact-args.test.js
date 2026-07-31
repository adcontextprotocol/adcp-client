/**
 * Tool arguments reach caller-visible `debug_logs`, which land in ordinary
 * application logs and CI output. Two AdCP argument fields carry credentials,
 * and both must be masked:
 *
 * - `push_notification_config` — async task-status notifications
 * - `reporting_webhook` — automated delivery reports, on `create_media_buy`
 *
 * The second one is the easy one to miss and the more certain to be populated:
 * `reporting-webhook.json` makes `authentication` REQUIRED for all of AdCP 3.x,
 * so a `create_media_buy` that registers reporting always carries a real HMAC
 * secret in `reporting_webhook.authentication.credentials`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { redactArgsForLog } = require('../../dist/lib/utils/redact-args.js');

const SECRET = 'a-real-hmac-shared-secret-over-32-chars';
const TOKEN = 'a-real-echo-token-value';

describe('redactArgsForLog', () => {
  test('masks push_notification_config credentials and token', () => {
    const out = redactArgsForLog({
      push_notification_config: {
        url: 'https://buyer.example/hook',
        token: TOKEN,
        authentication: { schemes: ['HMAC-SHA256'], credentials: SECRET },
      },
    });

    const serialized = JSON.stringify(out);
    assert.doesNotMatch(serialized, new RegExp(SECRET));
    assert.doesNotMatch(serialized, new RegExp(TOKEN));
    assert.strictEqual(out.push_notification_config.url, 'https://buyer.example/hook', 'url is not a secret');
  });

  test('masks reporting_webhook credentials and token', () => {
    // The gap this test exists for: masking only the push config left the
    // reporting registration's HMAC secret in plaintext on create_media_buy.
    const out = redactArgsForLog({
      reporting_webhook: {
        url: 'https://buyer.example/reports',
        token: TOKEN,
        authentication: { schemes: ['HMAC-SHA256'], credentials: SECRET },
        reporting_frequency: 'daily',
      },
    });

    const serialized = JSON.stringify(out);
    assert.doesNotMatch(serialized, new RegExp(SECRET), 'reporting_webhook credentials must be masked');
    assert.doesNotMatch(serialized, new RegExp(TOKEN), 'reporting_webhook token must be masked');
    assert.strictEqual(out.reporting_webhook.reporting_frequency, 'daily', 'non-secret fields are preserved');
  });

  test('masks both registrations on a single create_media_buy payload', () => {
    const out = redactArgsForLog({
      buyer_ref: 'br_1',
      push_notification_config: {
        url: 'https://buyer.example/hook',
        authentication: { schemes: ['HMAC-SHA256'], credentials: SECRET },
      },
      reporting_webhook: {
        url: 'https://buyer.example/reports',
        authentication: { schemes: ['HMAC-SHA256'], credentials: SECRET },
        reporting_frequency: 'daily',
      },
    });

    assert.doesNotMatch(JSON.stringify(out), new RegExp(SECRET));
    assert.strictEqual(out.buyer_ref, 'br_1', 'unrelated fields pass through');
  });

  test('replaces the whole authentication block, not just credentials', () => {
    // A future field added under `authentication` cannot start leaking silently.
    const out = redactArgsForLog({
      reporting_webhook: { authentication: { schemes: ['Bearer'], credentials: SECRET } },
    });
    assert.strictEqual(out.reporting_webhook.authentication, '***');
  });

  test('does not invent fields that were absent', () => {
    const out = redactArgsForLog({ reporting_webhook: { url: 'https://x.example/r' } });
    assert.strictEqual('authentication' in out.reporting_webhook, false);
    assert.strictEqual('token' in out.reporting_webhook, false);
  });

  test('leaves args without either registration untouched', () => {
    const args = { buyer_ref: 'br_1', packages: [{ product_id: 'p1' }] };
    assert.deepStrictEqual(redactArgsForLog(args), args);
  });

  test('does not mutate the caller-supplied object', () => {
    // The caller still sends the real args on the wire; only the log copy is masked.
    const args = {
      reporting_webhook: { authentication: { schemes: ['HMAC-SHA256'], credentials: SECRET } },
    };
    redactArgsForLog(args);
    assert.strictEqual(args.reporting_webhook.authentication.credentials, SECRET);
  });
});
