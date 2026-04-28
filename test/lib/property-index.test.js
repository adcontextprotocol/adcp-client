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

  test('does not throw when property.identifiers is undefined', () => {
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

    // Property is still attached to the agent so the agent index reflects
    // what the publisher claimed, even though it cannot be looked up by
    // identifier.
    const auth = index.getAgentAuthorizations('https://agent.example.com');
    assert.ok(auth);
    assert.strictEqual(auth.properties.length, 1);
    assert.deepStrictEqual(auth.publisher_domains, ['example.com']);
  });

  test('does not throw when property.identifiers is not an array', () => {
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
  });

  test('returns empty stats on a fresh index', () => {
    const index = new PropertyIndex();
    const stats = index.getStats();
    assert.strictEqual(stats.totalIdentifiers, 0);
    assert.strictEqual(stats.totalAgents, 0);
    assert.strictEqual(stats.totalProperties, 0);
  });
});
