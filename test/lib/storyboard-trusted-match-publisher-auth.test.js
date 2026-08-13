const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard/index.js');
const {
  TRUSTED_MATCH_PUBLISHER_AUTH_TASK_MAPPING,
  prepareTrustedMatchPublisherAuthProbes,
  probeTrustedMatchPublisherAuth,
} = require('../../dist/lib/testing/storyboard/trusted-match-publisher-auth.js');

const EXPECTED_REQUESTS = {
  trusted_match_missing_auth_context_probe: {
    type: 'context_match_request',
    protocol_version: '1.0',
    request_id: 'tmp-auth-probe-0001',
    property_rid: '01916f3a-f8cb-7000-8000-000000000099',
    property_type: 'website',
    placement_id: 'tmp-authentication-probe',
    seller_agent_url: 'https://publisher-auth-probe.example/mcp',
  },
  trusted_match_invalid_auth_context_probe: {
    type: 'context_match_request',
    protocol_version: '1.0',
    request_id: 'tmp-invalid-auth-probe-0001',
    property_rid: '01916f3a-f8cb-7000-8000-000000000099',
    property_type: 'website',
    placement_id: 'tmp-authentication-probe',
    seller_agent_url: 'https://publisher-auth-probe.example/mcp',
  },
  trusted_match_missing_auth_identity_probe: {
    type: 'identity_match_request',
    protocol_version: '1.0',
    request_id: 'tmp-auth-identity-probe-0001',
    seller_agent_url: 'https://publisher-auth-probe.example/mcp',
    identities: [{ uid_type: 'publisher_first_party', user_token: 'tmp-auth-probe-opaque-token' }],
  },
  trusted_match_invalid_auth_identity_probe: {
    type: 'identity_match_request',
    protocol_version: '1.0',
    request_id: 'tmp-invalid-auth-identity-probe-0001',
    seller_agent_url: 'https://publisher-auth-probe.example/mcp',
    identities: [{ uid_type: 'publisher_first_party', user_token: 'tmp-auth-probe-opaque-token' }],
  },
};

function storyboard(overrides = {}) {
  return {
    id: 'trusted_match_publisher_authentication',
    version: '1.0.0',
    title: 'Trusted Match publisher authentication rejection',
    category: 'security',
    summary: 'Publisher auth probes',
    narrative: '',
    requires_capability: { path: 'experimental_features', contains: 'trusted_match.core' },
    requires: ['trusted_match_publisher_auth_runner'],
    agent: { interaction_model: 'sync', capabilities: [] },
    caller: { role: 'unauthenticated_publisher' },
    phases: [
      {
        id: 'publisher_auth',
        title: 'Publisher auth',
        steps: Object.entries(EXPECTED_REQUESTS).map(([task, sample_request]) => ({
          id: task,
          title: task,
          task,
          stateful: false,
          sample_request,
          validations: [
            { check: 'http_status', value: 401, description: 'Authentication is rejected' },
            {
              check: 'on_401_require_header',
              value: 'www-authenticate',
              description: 'A challenge is present',
            },
          ],
        })),
      },
    ],
    ...overrides,
  };
}

const tmpProfile = {
  name: 'TMP router',
  tools: [],
  raw_capabilities: { experimental_features: ['trusted_match.core'] },
};
const nonTmpProfile = { name: 'ordinary agent', tools: [], raw_capabilities: { experimental_features: [] } };
const stubClient = { getAgentInfo: async () => tmpProfile };

function runnerOptions(profile, extra = {}) {
  return { _client: stubClient, _profile: profile, agentTools: [], allow_http: true, ...extra };
}

let certificatePem;
let privateKeyPem;
let server;
let baseUrl;
let received;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-tmp-auth-'));
  const keyPath = path.join(dir, 'server.key');
  const certPath = path.join(dir, 'server.crt');
  const generated = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(generated.status, 0, `openssl certificate generation failed: ${generated.stderr}`);
  privateKeyPem = fs.readFileSync(keyPath, 'utf8');
  certificatePem = fs.readFileSync(certPath, 'utf8');
  fs.rmSync(dir, { recursive: true });

  received = [];
  server = https.createServer({ key: privateKeyPem, cert: certificatePem }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    received.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/must-not-follow' });
      res.end();
      return;
    }
    if (req.url === '/oversized') {
      res.writeHead(401, { 'www-authenticate': 'Test realm="tmp"', 'content-type': 'text/plain' });
      res.end('x'.repeat(70 * 1024));
      return;
    }
    if (req.url === '/text-secret') {
      res.writeHead(401, { 'www-authenticate': 'Test realm="tmp"', 'content-type': 'text/plain' });
      res.end('Authorization: Bearer response-secret');
      return;
    }
    if (req.url === '/reflect-secret') {
      const reflected = req.headers['x-custom-credential'];
      res.writeHead(401, {
        'www-authenticate': `Custom reflected="${reflected}"`,
        'content-type': 'text/plain',
      });
      res.end(`credential=${reflected}`);
      return;
    }
    if (req.url === '/must-not-follow') {
      res.writeHead(200);
      res.end('redirect followed');
      return;
    }
    res.writeHead(401, { 'www-authenticate': 'Test realm="tmp"', 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'publisher auth required', access_token: 'response-secret' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', resolve);
  });
  baseUrl = `https://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
});

describe('Trusted Match publisher-auth runner (#2526)', () => {
  test('maps every pseudo-task to the exact endpoint, operation, and credential state', () => {
    assert.deepEqual(TRUSTED_MATCH_PUBLISHER_AUTH_TASK_MAPPING, {
      trusted_match_missing_auth_context_probe: {
        endpoint: 'contextEndpoint',
        operation: 'context',
        credentialState: 'absent',
      },
      trusted_match_invalid_auth_context_probe: {
        endpoint: 'contextEndpoint',
        operation: 'context',
        credentialState: 'invalid',
      },
      trusted_match_missing_auth_identity_probe: {
        endpoint: 'identityEndpoint',
        operation: 'identity',
        credentialState: 'absent',
      },
      trusted_match_invalid_auth_identity_probe: {
        endpoint: 'identityEndpoint',
        operation: 'identity',
        credentialState: 'invalid',
      },
    });
  });

  test('evaluates capability applicability before the runtime requirement', async () => {
    const notApplicable = await runStoryboard('https://unused.example/mcp', storyboard(), runnerOptions(nonTmpProfile));
    assert.equal(notApplicable.phases[0].steps[0].skip.reason, 'not_applicable');
    assert.equal(notApplicable.phases[0].steps[0].skip.requirement, undefined);

    const noRawDeclaration = await runStoryboard(
      'https://unused.example/mcp',
      storyboard(),
      runnerOptions({ name: 'normalized only', tools: ['get_adcp_capabilities'] })
    );
    assert.equal(noRawDeclaration.phases[0].steps[0].skip.reason, 'not_applicable');
    assert.equal(noRawDeclaration.phases[0].steps[0].skip.requirement, undefined);

    const selected = await runStoryboard('https://unused.example/mcp', storyboard(), runnerOptions(tmpProfile));
    assert.equal(selected.phases[0].steps[0].skip.reason, 'requirement_unmet');
    assert.equal(selected.phases[0].steps[0].skip.requirement, 'trusted_match_publisher_auth_runner');

    const forgedInternalState = await runStoryboard(
      'https://unused.example/mcp',
      storyboard(),
      runnerOptions(tmpProfile, {
        _trustedMatchPublisherAuthPrepared: {
          trusted_match_missing_auth_context_probe: {
            endpoint: `${baseUrl}/publisher/context-entry`,
            credentialHeaders: { host: 'forged.example' },
          },
        },
      })
    );
    assert.equal(forgedInternalState.phases[0].steps[0].skip.reason, 'requirement_unmet');

    const standalone = await runStoryboardStep(
      'https://unused.example/mcp',
      storyboard(),
      'trusted_match_missing_auth_context_probe',
      runnerOptions(nonTmpProfile)
    );
    assert.equal(standalone.skip.reason, 'not_applicable');
    assert.equal(standalone.skip.requirement, undefined);
  });

  test('preflights all four states and grades incomplete configuration requirement_unmet', async () => {
    const calls = [];
    const result = await runStoryboard(
      'https://unused.example/mcp',
      storyboard(),
      runnerOptions(tmpProfile, {
        trusted_match_publisher_auth_runner: {
          contextEndpoint: `${baseUrl}/publisher/context-entry`,
          identityEndpoint: `${baseUrl}/publisher/identity-entry`,
          preparePublisherAuthProbe: async input => {
            calls.push(input);
            return input.credentialState === 'absent'
              ? { tls: { caCertificatePem: certificatePem } }
              : { tls: { caCertificatePem: certificatePem } };
          },
        },
      })
    );
    assert.equal(result.phases[0].steps[0].skip.reason, 'requirement_unmet');
    assert.match(result.phases[0].steps[0].skip.detail, /invalid.*must return credential headers/i);
    assert.deepEqual(calls, [
      { operation: 'context', credentialState: 'absent' },
      { operation: 'context', credentialState: 'invalid' },
    ]);
  });

  test('redacts adapter failures and never routes pseudo-tasks through a protocol client', async () => {
    let routed = 0;
    const client = {
      getAgentInfo: async () => tmpProfile,
      executeTask: async () => {
        routed += 1;
        throw new Error('must not route');
      },
    };
    const missingContract = await runStoryboard(
      'https://unused.example/mcp',
      storyboard({ requires: undefined }),
      runnerOptions(tmpProfile, { _client: client })
    );
    assert.equal(missingContract.failed_count, 4);
    assert.match(missingContract.phases[0].steps[0].error, /valid only.*trusted_match_publisher_auth_runner/i);
    assert.equal(routed, 0);

    const secret = 'super-secret-adapter-token';
    const rejected = await runStoryboard(
      'https://unused.example/mcp',
      storyboard(),
      runnerOptions(tmpProfile, {
        trusted_match_publisher_auth_runner: {
          contextEndpoint: `${baseUrl}/publisher/context-entry`,
          identityEndpoint: `${baseUrl}/publisher/identity-entry`,
          preparePublisherAuthProbe: async () => {
            throw new Error(`Authorization: Bearer ${secret}`);
          },
        },
      })
    );
    const detail = rejected.phases[0].steps[0].skip.detail;
    assert.doesNotMatch(detail, new RegExp(secret));
    assert.match(detail, /Authorization: \[redacted\]/);
  });

  test('posts exact storyboard bodies to exact URLs without merging run-level credentials', async () => {
    received.length = 0;
    const preparedCalls = [];
    const result = await runStoryboard(
      'https://unused.example/mcp',
      storyboard(),
      runnerOptions(tmpProfile, {
        headers: { authorization: 'Bearer ambient-run-header', 'x-adcp-tenant': 'ambient-tenant' },
        request: { attacker_controlled_override: true },
        trusted_match_publisher_auth_runner: {
          contextEndpoint: `${baseUrl}/publisher/context-entry`,
          identityEndpoint: `${baseUrl}/publisher/identity-entry`,
          preparePublisherAuthProbe: async input => {
            preparedCalls.push(input);
            return {
              ...(input.credentialState === 'invalid'
                ? { credentialHeaders: { authorization: `Bearer invalid-${input.operation}` } }
                : {}),
              tls: { caCertificatePem: certificatePem },
            };
          },
        },
      })
    );

    assert.equal(result.overall_passed, true);
    assert.equal(result.passed_count, 4);
    assert.equal(result.failed_count, 0);
    assert.deepEqual(preparedCalls, [
      { operation: 'context', credentialState: 'absent' },
      { operation: 'context', credentialState: 'invalid' },
      { operation: 'identity', credentialState: 'absent' },
      { operation: 'identity', credentialState: 'invalid' },
    ]);
    assert.equal(received.length, 4);

    const tasks = Object.keys(EXPECTED_REQUESTS);
    for (let i = 0; i < received.length; i++) {
      const observation = received[i];
      const task = tasks[i];
      const mapping = TRUSTED_MATCH_PUBLISHER_AUTH_TASK_MAPPING[task];
      assert.equal(observation.method, 'POST');
      assert.equal(
        observation.url,
        mapping.operation === 'context' ? '/publisher/context-entry' : '/publisher/identity-entry'
      );
      assert.deepEqual(JSON.parse(observation.body), EXPECTED_REQUESTS[task]);
      assert.equal(observation.headers['content-type'], 'application/json');
      assert.equal(observation.headers['x-adcp-tenant'], undefined);
      assert.equal(
        observation.headers.authorization,
        mapping.credentialState === 'invalid' ? `Bearer invalid-${mapping.operation}` : undefined
      );
    }

    for (const step of result.phases[0].steps) {
      assert.equal(step.response.headers['www-authenticate'], 'Test realm="tmp"');
      assert.equal(step.response.body.access_token, '[redacted]');
      assert.equal(step.request.headers, undefined, 'credential headers are never recorded');
      assert.doesNotMatch(JSON.stringify(step), /ambient-run-header|invalid-context|invalid-identity|response-secret/);
    }
  });

  test('rejects adapter transport overrides and reserved routing/framing headers', async () => {
    const baseRunner = output => ({
      contextEndpoint: `${baseUrl}/publisher/context-entry`,
      identityEndpoint: `${baseUrl}/publisher/identity-entry`,
      preparePublisherAuthProbe: async ({ credentialState }) =>
        credentialState === 'absent' ? { tls: { caCertificatePem: certificatePem } } : output,
    });

    await assert.rejects(
      prepareTrustedMatchPublisherAuthProbes(
        baseRunner({ credentialHeaders: { authorization: 'bad' }, fetchImpl: async () => new Response() })
      ),
      /forbidden field.*fetchImpl/
    );
    for (const header of [
      'Host',
      'Content-Length',
      'Connection',
      'Forwarded',
      'X-Forwarded-Host',
      'X-Forwarded',
      'Forwarded-For',
      'Proxy',
      'X-Proxy-URL',
      'X-Adcp-Tenant',
      'Proxy-Authorization',
    ]) {
      await assert.rejects(
        prepareTrustedMatchPublisherAuthProbes(baseRunner({ credentialHeaders: { [header]: 'bad' } })),
        new RegExp(`forbidden header.*${header}`, 'i')
      );
    }
    await assert.rejects(
      prepareTrustedMatchPublisherAuthProbes(
        baseRunner({ credentialHeaders: { authorization: 'bad' }, tls: { rejectUnauthorized: false } })
      ),
      /forbidden field.*rejectUnauthorized/
    );
    await assert.rejects(
      prepareTrustedMatchPublisherAuthProbes(baseRunner({ credentialHeaders: { authorization: ' bad ' } })),
      /leading or trailing whitespace/
    );
    await assert.rejects(
      prepareTrustedMatchPublisherAuthProbes(baseRunner({ credentialHeaders: { authorization: '' } })),
      /non-empty printable string/
    );
  });

  test('owns redirect refusal, response bounds, and TLS verification', async () => {
    received.length = 0;
    const common = {
      operation: 'context',
      credentialState: 'invalid',
      credentialHeaders: { authorization: 'Bearer invalid' },
      tls: { caCertificatePem: certificatePem },
    };

    const redirect = await probeTrustedMatchPublisherAuth(
      { ...common, endpoint: `${baseUrl}/redirect` },
      EXPECTED_REQUESTS.trusted_match_invalid_auth_context_probe,
      { allowPrivateIp: true }
    );
    assert.equal(redirect.status, 302);
    assert.match(redirect.error, /redirect.*forbidden/i);
    assert.equal(
      received.some(entry => entry.url === '/must-not-follow'),
      false
    );

    const oversized = await probeTrustedMatchPublisherAuth(
      { ...common, endpoint: `${baseUrl}/oversized` },
      EXPECTED_REQUESTS.trusted_match_invalid_auth_context_probe,
      { allowPrivateIp: true }
    );
    assert.equal(oversized.status, 0);
    assert.match(oversized.error, /exceeded 65536 bytes/i);

    const untrustedCertificate = await probeTrustedMatchPublisherAuth(
      { ...common, endpoint: `${baseUrl}/publisher/context-entry`, tls: {} },
      EXPECTED_REQUESTS.trusted_match_invalid_auth_context_probe,
      { allowPrivateIp: true }
    );
    assert.equal(untrustedCertificate.status, 0);
    assert.match(untrustedCertificate.error, /fetch failed|certificate|self-signed/i);

    const textSecret = await probeTrustedMatchPublisherAuth(
      { ...common, endpoint: `${baseUrl}/text-secret` },
      EXPECTED_REQUESTS.trusted_match_invalid_auth_context_probe,
      { allowPrivateIp: true }
    );
    assert.equal(textSecret.status, 401);
    assert.equal(textSecret.body, 'Authorization: [redacted]');

    const reflectedSecret = 'deployment-defined-invalid-credential';
    const reflected = await probeTrustedMatchPublisherAuth(
      {
        ...common,
        endpoint: `${baseUrl}/reflect-secret`,
        credentialHeaders: { 'x-custom-credential': reflectedSecret },
      },
      EXPECTED_REQUESTS.trusted_match_invalid_auth_context_probe,
      { allowPrivateIp: true }
    );
    assert.equal(reflected.status, 401);
    assert.equal(reflected.body, 'credential=[redacted]');
    assert.equal(reflected.headers['www-authenticate'], 'Custom reflected="[redacted]"');
    assert.doesNotMatch(JSON.stringify(reflected), new RegExp(reflectedSecret));
  });
});
