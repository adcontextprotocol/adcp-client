/**
 * buildAccount must preserve an explicit `sandbox: false` from the resolved
 * test kit (adcp-client#2580): the comply_controller_mode_gate storyboard's
 * live-mode kit (acme-outdoor-live) sets `sandbox: false`, but the old
 * `{ ...account, sandbox: true }` spread clobbered it — every controller
 * call reached sellers as a sandbox principal, making the storyboard
 * ungradeable by construction. Exercised through the exported
 * callControllerRaw with a capture client (buildAccount is module-private).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { callControllerRaw } = require('../../dist/lib/testing/test-controller.js');

function captureClient() {
  const captured = {};
  return {
    captured,
    executeTask(name, params) {
      captured.name = name;
      captured.params = params;
      return Promise.resolve({ success: true, data: { content: [{ type: 'text', text: '{}' }] } });
    },
  };
}

const BRAND_OPTIONS = { brand: { domain: 'acme-outdoor.example' } };

describe('buildAccount sandbox handling (via callControllerRaw)', () => {
  it("preserves the live-mode kit's explicit sandbox: false", async () => {
    const client = captureClient();
    await callControllerRaw(
      client,
      { scenario: 'force_creative_status' },
      {
        ...BRAND_OPTIONS,
        sandbox: false,
      }
    );
    assert.equal(client.captured.params.account.sandbox, false);
  });

  it('defaults sandbox to true when the kit sets nothing', async () => {
    const client = captureClient();
    await callControllerRaw(client, { scenario: 'seed_product' }, BRAND_OPTIONS);
    assert.equal(client.captured.params.account.sandbox, true);
  });

  it('keeps an explicit sandbox: true untouched', async () => {
    const client = captureClient();
    await callControllerRaw(
      client,
      { scenario: 'seed_product' },
      {
        ...BRAND_OPTIONS,
        sandbox: true,
      }
    );
    assert.equal(client.captured.params.account.sandbox, true);
  });

  it('no options still yields the default sandbox account', async () => {
    const client = captureClient();
    await callControllerRaw(client, { scenario: 'list_scenarios' });
    assert.equal(client.captured.params.account.sandbox, true);
  });
});
