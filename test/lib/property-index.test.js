// Unit tests for PropertyIndex
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { PropertyIndex } = require('../../dist/lib/discovery/property-index.js');

describe('PropertyIndex.addProperty', () => {
  test('indexes a well-formed property by every identifier', () => {
    const index = new PropertyIndex();
    index.addProperty(
      {
        property_type: 'website',
        name: 'Example',
        identifiers: [
          { type: 'domain', value: 'example.com' },
          { type: 'subdomain', value: 'www.example.com' },
        ],
      },
      'https://agent.example.com',
      'example.com'
    );

    assert.strictEqual(index.findAgentsForProperty('domain', 'example.com').length, 1);
    assert.strictEqual(index.findAgentsForProperty('subdomain', 'www.example.com').length, 1);

    const auth = index.getAgentAuthorizations('https://agent.example.com');
    assert.ok(auth);
    assert.strictEqual(auth.properties.length, 1);
    assert.deepStrictEqual(auth.publisher_domains, ['example.com']);
  });

  test('drops the property entirely when identifiers is undefined', () => {
    const index = new PropertyIndex();

    assert.doesNotThrow(() => {
      index.addProperty(
        {
          property_type: 'website',
          name: 'Missing identifiers',
        },
        'https://agent.example.com',
        'example.com'
      );
    });

    // The property is dropped so consumers that iterate
    // AgentAuthorization.properties never see an entry that cannot be
    // looked up by identifier.
    assert.strictEqual(index.getAgentAuthorizations('https://agent.example.com'), null);
    assert.strictEqual(index.getStats().totalProperties, 0);
  });

  test('drops the property when identifiers is not an array', () => {
    const index = new PropertyIndex();

    assert.doesNotThrow(() => {
      index.addProperty(
        {
          property_type: 'website',
          name: 'Bad shape',
          identifiers: 'domain:example.com',
        },
        'https://agent.example.com',
        'example.com'
      );
    });

    assert.strictEqual(
      index.findAgentsForProperty('domain', 'example.com').length,
      0,
      'Malformed identifiers should not register lookups'
    );
    assert.strictEqual(index.getAgentAuthorizations('https://agent.example.com'), null);
  });

  test('drops items missing type/value but indexes the rest', () => {
    const index = new PropertyIndex();
    index.addProperty(
      {
        property_type: 'website',
        name: 'Mixed',
        identifiers: [
          { type: 'domain', value: 'example.com' },
          { type: 'domain' }, // missing value
          null,
          { value: 'orphan.example.com' }, // missing type
        ],
      },
      'https://agent.example.com',
      'example.com'
    );

    assert.strictEqual(index.findAgentsForProperty('domain', 'example.com').length, 1);
    const auth = index.getAgentAuthorizations('https://agent.example.com');
    assert.ok(auth);
    assert.strictEqual(auth.properties.length, 1);
  });

  test('returns empty stats on a fresh index', () => {
    const index = new PropertyIndex();
    const stats = index.getStats();
    assert.strictEqual(stats.totalIdentifiers, 0);
    assert.strictEqual(stats.totalAgents, 0);
    assert.strictEqual(stats.totalProperties, 0);
  });
});
