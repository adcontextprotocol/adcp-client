const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { gradeOAuthMetadataGraphVector, loadOAuthMetadataGraphVectors } = require('../dist/lib/testing/index.js');

const corpus = loadOAuthMetadataGraphVectors(path.join(__dirname, 'fixtures', 'oauth-setup', 'vectors.json'));

describe('oauth_metadata_graph upstream vectors', () => {
  for (const vector of corpus.positive) {
    it(`passes ${vector.id}`, async () => {
      const grade = await gradeOAuthMetadataGraphVector(vector);
      assert.strictEqual(grade.success, true, `${vector.id}: ${grade.error_code}: ${grade.error}`);
      assert.strictEqual(grade.error_code, undefined);
    });
  }

  for (const vector of corpus.negative) {
    it(`fails ${vector.id} with the exact stable code`, async () => {
      const grade = await gradeOAuthMetadataGraphVector(vector);
      assert.strictEqual(grade.success, false, `${vector.id} unexpectedly passed`);
      assert.strictEqual(grade.error_code, vector.expected_outcome.error_code, JSON.stringify(grade.findings));
    });
  }

  it('treats token endpoint 404 as passive transport reachability', async () => {
    const vector = structuredClone(corpus.positive.find(candidate => candidate.id === '003-client-credentials-only'));
    vector.responses['GET https://machine-identity.example.net/token'] = {
      status: 404,
      content_type: 'application/json',
      json: { error: 'not_found' },
    };
    const grade = await gradeOAuthMetadataGraphVector(vector);
    assert.strictEqual(grade.success, true, `${grade.error_code}: ${grade.error}`);
  });

  it('classifies a non-string authorization-server item as an invalid URL', async () => {
    const vector = structuredClone(corpus.positive[0]);
    const prm = vector.responses['GET https://agent.example.com/.well-known/oauth-protected-resource/mcp'];
    prm.json.authorization_servers = [42];
    const grade = await gradeOAuthMetadataGraphVector(vector);
    assert.strictEqual(grade.success, false);
    assert.strictEqual(grade.error_code, 'oauth_authorization_server_url_invalid');
  });

  it('deduplicates an exact URL shared by token_endpoint and jwks_uri', async () => {
    const vector = structuredClone(corpus.positive.find(candidate => candidate.id === '003-client-credentials-only'));
    const metadata =
      vector.responses['GET https://machine-identity.example.net/.well-known/oauth-authorization-server'].json;
    metadata.jwks_uri = 'https://machine-identity.example.net/token';
    vector.responses['GET https://machine-identity.example.net/token'] = {
      status: 200,
      content_type: 'application/json',
      json: { keys: [] },
    };
    const grade = await gradeOAuthMetadataGraphVector(vector);
    assert.strictEqual(grade.success, true, `${grade.error_code}: ${grade.error}`);
    assert.strictEqual(grade.total_requests, 3);
  });
});
