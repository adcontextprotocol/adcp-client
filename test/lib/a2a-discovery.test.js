const test = require('node:test');
const assert = require('node:assert');
const {
  isAgentCardPath,
  isWellKnownAgentCardUrl,
  buildCardUrls,
  stripAgentCardPath,
} = require('../../dist/lib/index.js');

test('isAgentCardPath', async t => {
  await t.test('matches /.well-known/agent.json', () => {
    assert.strictEqual(isAgentCardPath('https://example.com/.well-known/agent.json'), true);
  });

  await t.test('matches /.well-known/agent-card.json', () => {
    assert.strictEqual(isAgentCardPath('https://example.com/.well-known/agent-card.json'), true);
  });

  await t.test('is case-insensitive', () => {
    assert.strictEqual(isAgentCardPath('https://example.com/.Well-Known/Agent.json'), true);
    assert.strictEqual(isAgentCardPath('https://example.com/.Well-Known/Agent-Card.json'), true);
  });

  await t.test('rejects non-card paths', () => {
    assert.strictEqual(isAgentCardPath('https://example.com/mcp'), false);
    assert.strictEqual(isAgentCardPath('https://example.com'), false);
  });

  await t.test('rejects paths with trailing content', () => {
    assert.strictEqual(isAgentCardPath('https://example.com/.well-known/agent.json.bak'), false);
    assert.strictEqual(isAgentCardPath('https://example.com/.well-known/agent.json/../../task'), false);
  });
});

test('isWellKnownAgentCardUrl', async t => {
  await t.test('matches root-level agent.json', () => {
    assert.strictEqual(isWellKnownAgentCardUrl('https://example.com/.well-known/agent.json'), true);
  });

  await t.test('matches root-level agent-card.json', () => {
    assert.strictEqual(isWellKnownAgentCardUrl('https://example.com/.well-known/agent-card.json'), true);
  });

  await t.test('rejects subdirectory paths', () => {
    assert.strictEqual(isWellKnownAgentCardUrl('https://example.com/api/.well-known/agent.json'), false);
    assert.strictEqual(isWellKnownAgentCardUrl('https://example.com/api/.well-known/agent-card.json'), false);
  });

  await t.test('rejects non-https schemes', () => {
    assert.strictEqual(isWellKnownAgentCardUrl('ftp://example.com/.well-known/agent.json'), false);
  });

  await t.test('accepts http scheme', () => {
    assert.strictEqual(isWellKnownAgentCardUrl('http://localhost:3000/.well-known/agent.json'), true);
  });
});

test('buildCardUrls', async t => {
  await t.test('returns both paths for a base URL', () => {
    const urls = buildCardUrls('https://example.com');
    assert.deepStrictEqual(urls, [
      'https://example.com/.well-known/agent.json',
      'https://example.com/.well-known/agent-card.json',
    ]);
  });

  await t.test('strips trailing slash before appending paths', () => {
    const urls = buildCardUrls('https://example.com/');
    assert.deepStrictEqual(urls, [
      'https://example.com/.well-known/agent.json',
      'https://example.com/.well-known/agent-card.json',
    ]);
  });

  await t.test('returns explicit agent.json URL as-is', () => {
    const urls = buildCardUrls('https://example.com/.well-known/agent.json');
    assert.deepStrictEqual(urls, ['https://example.com/.well-known/agent.json']);
  });

  await t.test('returns explicit agent-card.json URL as-is', () => {
    const urls = buildCardUrls('https://example.com/.well-known/agent-card.json');
    assert.deepStrictEqual(urls, ['https://example.com/.well-known/agent-card.json']);
  });
});

test('stripAgentCardPath', async t => {
  await t.test('strips /.well-known/agent.json', () => {
    assert.strictEqual(stripAgentCardPath('https://example.com/.well-known/agent.json'), 'https://example.com');
  });

  await t.test('strips /.well-known/agent-card.json', () => {
    assert.strictEqual(stripAgentCardPath('https://example.com/.well-known/agent-card.json'), 'https://example.com');
  });

  await t.test('returns non-card URLs unchanged', () => {
    assert.strictEqual(stripAgentCardPath('https://example.com/mcp'), 'https://example.com/mcp');
  });
});
