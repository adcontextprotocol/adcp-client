const test = require('node:test');
const assert = require('node:assert');

const {
  buildActivateSignalRequest,
  getSignalActivationId,
  getSignalPricingOptionIds,
  normalizeDiscoveredSignal,
  signalId,
} = require('../../dist/lib/index.js');

function makeSignal(overrides = {}) {
  return {
    signal_agent_segment_id: 'activation-handle-123',
    signal_id: signalId.catalog({ data_provider_domain: 'polk.com', id: 'likely_ev_buyers' }),
    name: 'Likely EV buyers',
    signal_type: 'marketplace',
    data_provider: 'Polk',
    pricing_options: [
      { pricing_option_id: 'po_cpm', model: 'cpm', cpm: 2.5, currency: 'USD' },
      { pricing_option_id: 'po_flat', model: 'flat_rate', amount: 500, currency: 'USD' },
    ],
    restricted_attributes: ['precise_location'],
    policy_categories: ['automotive'],
    ...overrides,
  };
}

test('normalizeDiscoveredSignal separates activation handle from signal_id provenance', () => {
  const normalized = normalizeDiscoveredSignal(makeSignal());

  assert.strictEqual(normalized.signalAgentSegmentId, 'activation-handle-123');
  assert.strictEqual(normalized.signalIdValue, 'likely_ev_buyers');
  assert.notStrictEqual(normalized.signalAgentSegmentId, normalized.signalIdValue);
  assert.strictEqual(normalized.signalSource, 'catalog');
  assert.strictEqual(normalized.signalIssuer, 'polk.com');
  assert.deepStrictEqual(normalized.pricingOptionIds, ['po_cpm', 'po_flat']);
  assert.deepStrictEqual(normalized.restrictedAttributes, ['precise_location']);
  assert.deepStrictEqual(normalized.policyCategories, ['automotive']);
});

test('normalizeDiscoveredSignal handles agent-native signal_id provenance', () => {
  const normalized = normalizeDiscoveredSignal(
    makeSignal({
      signal_id: signalId.agent({
        agent_url: 'https://signals.example.com/.well-known/adcp/signals',
        id: 'agent-native-intenders',
      }),
    })
  );

  assert.strictEqual(normalized.signalSource, 'agent');
  assert.strictEqual(normalized.signalIdValue, 'agent-native-intenders');
  assert.strictEqual(normalized.signalIssuer, 'https://signals.example.com/.well-known/adcp/signals');
});

test('normalizeDiscoveredSignal handles rows without signal_id provenance', () => {
  const { signal_id, ...signal } = makeSignal();
  void signal_id;
  const normalized = normalizeDiscoveredSignal(signal);

  assert.strictEqual(normalized.signalAgentSegmentId, 'activation-handle-123');
  assert.strictEqual(normalized.signalId, undefined);
  assert.strictEqual(normalized.signalIssuer, undefined);
  assert.deepStrictEqual(normalized.pricingOptionIds, ['po_cpm', 'po_flat']);
});

test('buildActivateSignalRequest uses signal_agent_segment_id and preserves activation options', () => {
  const req = buildActivateSignalRequest(makeSignal(), {
    destinations: [{ type: 'platform', platform: 'dv360' }],
    account: { account_id: 'acc_acme' },
    action: 'activate',
    pricingOptionId: 'po_cpm',
    context: { buyer_ref: 'sig-activation-1' },
  });

  assert.deepStrictEqual(req, {
    signal_agent_segment_id: 'activation-handle-123',
    destinations: [{ type: 'platform', platform: 'dv360' }],
    account: { account_id: 'acc_acme' },
    action: 'activate',
    pricing_option_id: 'po_cpm',
    context: { buyer_ref: 'sig-activation-1' },
  });
});

test('buildActivateSignalRequest accepts a pre-normalized signal and snake-case pricing takes precedence', () => {
  const normalized = normalizeDiscoveredSignal(makeSignal());
  const req = buildActivateSignalRequest(normalized, {
    destinations: [{ type: 'platform', platform: 'meta' }],
    pricing_option_id: 'po_flat',
    pricingOptionId: 'po_cpm',
    idempotency_key: 'signal-activation-key-123',
  });

  assert.strictEqual(req.signal_agent_segment_id, 'activation-handle-123');
  assert.strictEqual(req.pricing_option_id, 'po_flat');
  assert.strictEqual(req.idempotency_key, 'signal-activation-key-123');
});

test('signal discovery accessors expose activation and pricing ids', () => {
  const signal = makeSignal();

  assert.strictEqual(getSignalActivationId(signal), 'activation-handle-123');
  assert.deepStrictEqual(getSignalPricingOptionIds(signal), ['po_cpm', 'po_flat']);
});

test('getSignalActivationId fails clearly when the discovery row is not activatable', () => {
  const { signal_agent_segment_id, ...signal } = makeSignal();
  void signal_agent_segment_id;

  assert.throws(() => getSignalActivationId(signal), /signal_agent_segment_id is required/);
});
