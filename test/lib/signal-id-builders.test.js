const test = require('node:test');
const assert = require('node:assert');
const { signalId, catalogSignalId, agentSignalId, getSignalId, getSignalIssuer } = require('../../dist/lib/index.js');

test('signal-id builders', async t => {
  await t.test('catalogSignalId injects source and forwards fields', () => {
    assert.deepStrictEqual(catalogSignalId({ data_provider_domain: 'polk.com', id: 'likely_ev_buyers' }), {
      source: 'catalog',
      data_provider_domain: 'polk.com',
      id: 'likely_ev_buyers',
    });
  });

  await t.test('agentSignalId injects source and forwards fields', () => {
    assert.deepStrictEqual(
      agentSignalId({ agent_url: 'https://liveramp.com/.well-known/adcp/signals', id: 'custom_intenders' }),
      { source: 'agent', agent_url: 'https://liveramp.com/.well-known/adcp/signals', id: 'custom_intenders' }
    );
  });

  await t.test('signalId namespace delegates to the typed factories', () => {
    assert.strictEqual(signalId.catalog({ data_provider_domain: 'polk.com', id: 'x' }).source, 'catalog');
    assert.strictEqual(
      signalId.agent({ agent_url: 'https://example.com/.well-known/adcp/signals', id: 'x' }).source,
      'agent'
    );
  });
});

test('getSignalId', async t => {
  await t.test('returns id from a catalog SignalID', () => {
    const sid = signalId.catalog({ data_provider_domain: 'polk.com', id: 'likely_ev_buyers' });
    assert.strictEqual(getSignalId(sid), 'likely_ev_buyers');
  });

  await t.test('returns id from an agent SignalID', () => {
    const sid = signalId.agent({ agent_url: 'https://liveramp.com/.well-known/adcp/signals', id: 'custom_intenders' });
    assert.strictEqual(getSignalId(sid), 'custom_intenders');
  });
});

test('getSignalIssuer', async t => {
  await t.test('returns data_provider_domain for catalog variant', () => {
    const sid = signalId.catalog({ data_provider_domain: 'polk.com', id: 'likely_ev_buyers' });
    assert.strictEqual(getSignalIssuer(sid), 'polk.com');
  });

  await t.test('returns agent_url for agent variant', () => {
    const sid = signalId.agent({
      agent_url: 'https://liveramp.com/.well-known/adcp/signals',
      id: 'custom_intenders',
    });
    assert.strictEqual(getSignalIssuer(sid), 'https://liveramp.com/.well-known/adcp/signals');
  });

  await t.test('throws on unrecognized source (exhaustiveness guard)', () => {
    const sid = /** @type {any} */ ({ source: 'unknown', id: 'x' });
    assert.throws(() => getSignalIssuer(sid), /Unhandled SignalID source/);
  });
});
