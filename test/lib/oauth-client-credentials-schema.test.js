const assert = require('node:assert/strict');
const { test } = require('node:test');

test('public OAuth client credentials schema validates API settings in CommonJS and ESM', async () => {
  const credentials = {
    token_endpoint: 'https://auth.example.com/oauth/token',
    client_id: 'client-id',
    client_secret: 'client-secret',
  };

  for (const entry of ['@adcp/sdk', '@adcp/sdk/auth', '@adcp/sdk/schemas']) {
    for (const sdk of [require(entry), await import(entry)]) {
      const schema = sdk.AgentOAuthClientCredentialsSchema;
      assert.ok(schema, `${entry} exports AgentOAuthClientCredentialsSchema`);
      assert.deepEqual(schema.parse(credentials), credentials);

      for (const auth_method of ['basic', 'body']) {
        for (const resource of ['https://agent.example.com', ['https://agent.example.com', 'urn:adcp:agent']]) {
          const settings = {
            ...credentials,
            client_id: '$ENV:ADCP_CLIENT_ID',
            client_secret: '$ENV:ADCP_CLIENT_SECRET',
            scope: 'adcp read',
            resource,
            audience: 'agent-audience',
            auth_method,
          };
          assert.deepEqual(schema.parse(settings), settings);
        }
      }
      assert.equal(schema.safeParse({ ...credentials, token_endpoint: 'http://localhost:8080/token' }).success, true);

      for (const field of ['token_endpoint', 'client_id', 'client_secret']) {
        const missing = { ...credentials };
        delete missing[field];
        assert.equal(schema.safeParse(missing).success, false, `${field} is required`);
        assert.equal(schema.safeParse({ ...credentials, [field]: '' }).success, false, `${field} is non-empty`);
      }
      for (const invalid of [
        null,
        [],
        { ...credentials, token_endpoint: 'not a URL' },
        { ...credentials, token_endpoint: 123 },
        { ...credentials, client_id: 123 },
        { ...credentials, client_secret: 123 },
        { ...credentials, scope: ['adcp'] },
        { ...credentials, resource: 123 },
        { ...credentials, resource: ['https://agent.example.com', 123] },
        { ...credentials, audience: 123 },
        { ...credentials, auth_method: 'bearer' },
      ]) {
        assert.equal(schema.safeParse(invalid).success, false, JSON.stringify(invalid));
      }
    }
  }
});
