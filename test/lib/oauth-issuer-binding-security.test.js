const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const {
  MCPOAuthProvider,
  createNonInteractiveOAuthProvider,
  createCLIOAuthProvider,
  DEFAULT_CLIENT_METADATA,
  toMCPTokens,
  fromMCPTokens,
  toMCPClientInfo,
  fromMCPClientInfo,
  startWebOAuthFlow,
  completeWebOAuthFlow,
  InMemoryPendingFlowStore,
  runAuthDiagnosis,
  createFileOAuthStorage,
  AgentVanishedDuringFlowError,
  ensureClientCredentialsTokens,
  clearOAuthTokens,
} = require('../../dist/lib/auth/oauth');

async function fixture() {
  const state = {
    origin: '',
    selected: 'owner',
    metadataIssuer: undefined,
    invalidGrant: false,
    posts: [],
    metadataGate: undefined,
  };
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, state.origin).pathname;
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, {
        resource: `${state.origin}/mcp`,
        authorization_servers: [`${state.origin}/${state.selected}`],
      });
    }
    if (pathname.includes('/.well-known/oauth-authorization-server')) {
      if (state.metadataGate) {
        state.metadataEntered?.();
        await state.metadataGate;
      }
      const selected = pathname.includes('attacker') ? 'attacker' : 'owner';
      const issuer = `${state.origin}/${selected}`;
      return json(200, {
        issuer: state.metadataIssuer ?? issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      });
    }
    if (req.method === 'POST' && /\/(token|register)$/.test(pathname)) {
      state.posts.push({ path: pathname, form: new URLSearchParams(body) });
      if (pathname.endsWith('/register')) {
        if (state.registrationGate) {
          state.registrationEntered?.();
          await state.registrationGate;
        }
        return json(201, {
          ...JSON.parse(body),
          client_id: 'synthetic-client',
          issuer: `${state.origin}/forged-wire-issuer`,
        });
      }
      if (state.invalidGrant) return json(400, { error: 'invalid_grant' });
      return json(200, {
        access_token: 'fresh-synthetic-access',
        refresh_token: 'rotated-synthetic-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        issuer: `${state.origin}/forged-wire-issuer`,
      });
    }
    return json(401, { error: 'unauthorized' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.origin = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    agent: () => ({
      id: 'issuer-security',
      name: 'Synthetic issuer fixture',
      agent_uri: `${state.origin}/mcp`,
      protocol: 'mcp',
      oauth_tokens: {
        access_token: 'expired-synthetic-access',
        refresh_token: 'synthetic-refresh',
        token_type: 'Bearer',
        issuer: `${state.origin}/owner`,
      },
      oauth_client: {
        client_id: 'synthetic-client',
        client_secret: 'synthetic-client-secret',
        issuer: `${state.origin}/owner`,
      },
    }),
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function storageFor(agent) {
  let saved = structuredClone(agent);
  return {
    async loadAgent() {
      return structuredClone(saved);
    },
    async saveAgent(value) {
      saved = structuredClone(value);
    },
    current() {
      return structuredClone(saved);
    },
    replace(value) {
      saved = structuredClone(value);
    },
  };
}

test('all token/client conversion directions retain the exact issuer stamp', () => {
  const issuer = 'https://identity.example/tenant-one';
  const token = { access_token: 'synthetic', token_type: 'Bearer', issuer };
  const client = { client_id: 'synthetic', issuer };
  assert.equal(toMCPTokens(token).issuer, issuer);
  assert.equal(fromMCPTokens(token).issuer, issuer);
  assert.equal(toMCPClientInfo(client).issuer, issuer);
  assert.equal(fromMCPClientInfo(client).issuer, issuer);
});

for (const era of ['modern', 'legacy']) {
  test(`${era} metadata issuer echo mismatch refuses before any token POST`, async () => {
    const f = await fixture();
    try {
      f.state.metadataIssuer = `${f.state.origin}/other-tenant`;
      const agent = f.agent();
      const provider = createNonInteractiveOAuthProvider(agent, { allowHttp: true });
      const auth =
        era === 'modern'
          ? require('@modelcontextprotocol/client').auth
          : (await import('@modelcontextprotocol/sdk/client/auth.js')).auth;
      const outcome = await Promise.allSettled([auth(provider, { serverUrl: agent.agent_uri })]);
      assert.equal(f.state.posts.length, 0);
      assert.equal(outcome[0].status, 'rejected');
    } finally {
      await f.close();
    }
  });

  for (const variant of ['different issuer', 'missing token issuer', 'missing client issuer']) {
    test(`${era} official auth refuses ${variant} before any foreign token or DCR POST`, async () => {
      const f = await fixture();
      try {
        const agent = f.agent();
        if (variant === 'different issuer') f.state.selected = 'attacker';
        if (variant === 'missing token issuer') delete agent.oauth_tokens.issuer;
        if (variant === 'missing client issuer') delete agent.oauth_client.issuer;
        const original = structuredClone(agent);
        const storage = storageFor(agent);
        const provider = createNonInteractiveOAuthProvider(agent, { storage, allowHttp: true });
        const auth =
          era === 'modern'
            ? require('@modelcontextprotocol/client').auth
            : (await import('@modelcontextprotocol/sdk/client/auth.js')).auth;
        const outcome = await Promise.allSettled([auth(provider, { serverUrl: agent.agent_uri })]);
        assert.equal(f.state.posts.length, 0, 'prior credentials must not be spent or replaced at the attacker AS');
        assert.equal(outcome[0].status, 'rejected');
        assert.doesNotMatch(
          outcome[0].reason.message,
          /synthetic-refresh|synthetic-client-secret|expired-synthetic-access/
        );
        assert.deepEqual(agent, original);
        assert.deepEqual(storage.current(), original);
      } finally {
        await f.close();
      }
    });
  }

  test(`${era} matching refresh persists issuer and rotated grant for a separately reconstructed provider`, async () => {
    const f = await fixture();
    try {
      const agent = f.agent();
      const storage = storageFor(agent);
      const provider = createNonInteractiveOAuthProvider(agent, { storage, allowHttp: true });
      const auth =
        era === 'modern'
          ? require('@modelcontextprotocol/client').auth
          : (await import('@modelcontextprotocol/sdk/client/auth.js')).auth;
      assert.equal(await auth(provider, { serverUrl: agent.agent_uri }), 'AUTHORIZED');
      assert.equal(f.state.posts.length, 1);
      const reader = createNonInteractiveOAuthProvider(await storage.loadAgent(), { allowHttp: true });
      assert.equal((await reader.tokens()).issuer, `${f.state.origin}/owner`);
      assert.equal((await reader.tokens()).refresh_token, 'rotated-synthetic-refresh');
      assert.equal((await reader.clientInformation()).issuer, `${f.state.origin}/owner`);
    } finally {
      await f.close();
    }
  });

  test(`${era} invalid_grant preserves the owner registration and grant without re-registering`, async () => {
    const f = await fixture();
    try {
      f.state.invalidGrant = true;
      const agent = f.agent();
      const original = structuredClone(agent);
      const storage = storageFor(agent);
      const provider = createNonInteractiveOAuthProvider(agent, { storage, allowHttp: true });
      const auth =
        era === 'modern'
          ? require('@modelcontextprotocol/client').auth
          : (await import('@modelcontextprotocol/sdk/client/auth.js')).auth;
      await assert.rejects(auth(provider, { serverUrl: agent.agent_uri }));
      assert.equal(f.state.posts.length, 1);
      assert.deepEqual(agent, original);
      assert.deepEqual(storage.current(), original);
    } finally {
      await f.close();
    }
  });
}

test('CLI factories explicitly permit fresh registration while the background factory refuses it', async () => {
  const f = await fixture();
  try {
    const agent = f.agent();
    delete agent.oauth_tokens;
    delete agent.oauth_client;
    const state = {
      authorizationServerUrl: `${f.state.origin}/owner`,
      authorizationServerMetadata: { issuer: `${f.state.origin}/owner` },
    };
    const flowHandler = {
      getRedirectUrl: () => `${f.state.origin}/callback`,
      async redirectToAuthorization() {},
      async waitForCallback() {},
      async cleanup() {},
    };
    for (const provider of [
      createCLIOAuthProvider({ ...agent }, { quiet: true, allowHttp: true }),
      MCPOAuthProvider.forCLI({ ...agent }, flowHandler, undefined, undefined, { allowHttp: true }),
    ]) {
      try {
        await provider.saveDiscoveryState(state);
        assert.equal(await provider.clientInformation({ issuer: `${f.state.origin}/owner` }), undefined);
      } finally {
        await provider.cleanup();
      }
    }
    const background = createNonInteractiveOAuthProvider({ ...agent }, { allowHttp: true });
    await assert.rejects(background.saveDiscoveryState(state));
    assert.equal(f.state.posts.length, 0);
  } finally {
    await f.close();
  }
});

for (const scope of ['tokens', 'client', 'all']) {
  test(`noninteractive automatic ${scope} invalidation preserves the owner data`, async () => {
    const f = await fixture();
    try {
      const agent = f.agent();
      const original = structuredClone(agent);
      const storage = storageFor(agent);
      const provider = createNonInteractiveOAuthProvider(agent, { storage, allowHttp: true });
      await assert.rejects(provider.invalidateCredentials(scope));
      assert.deepEqual(agent, original);
      assert.deepEqual(storage.current(), original);
    } finally {
      await f.close();
    }
  });
}

test('direct constructor refuses registration by default, while explicit credentialless interactive startup is supported', async () => {
  const f = await fixture();
  try {
    const agent = f.agent();
    delete agent.oauth_tokens;
    delete agent.oauth_client;
    let redirects = 0;
    const flowHandler = {
      getRedirectUrl: () => `${f.state.origin}/callback`,
      async redirectToAuthorization() {
        redirects++;
      },
      async waitForCallback() {
        return 'synthetic-code';
      },
      async cleanup() {},
    };
    const auth = require('@modelcontextprotocol/client').auth;
    const options = { agent, flowHandler, clientMetadata: DEFAULT_CLIENT_METADATA, allowHttp: true };
    const first = await Promise.allSettled([auth(new MCPOAuthProvider(options), { serverUrl: agent.agent_uri })]);
    assert.equal(f.state.posts.length, 0);
    assert.equal(first[0].status, 'rejected');
    const provider = new MCPOAuthProvider({ ...options, allowInteractiveAuthorization: true });
    assert.equal(await auth(provider, { serverUrl: agent.agent_uri }), 'REDIRECT');
    assert.equal(redirects, 1);
    assert.equal(agent.oauth_client.issuer, `${f.state.origin}/owner`);
    assert.equal(
      await auth(provider, { serverUrl: agent.agent_uri, authorizationCode: 'synthetic-code' }),
      'AUTHORIZED'
    );
    assert.equal(agent.oauth_tokens.issuer, `${f.state.origin}/owner`);
  } finally {
    await f.close();
  }
});

test('direct web start refuses a prior client at a different issuer without DCR', async () => {
  const f = await fixture();
  try {
    f.state.selected = 'attacker';
    const outcome = await Promise.allSettled([
      startWebOAuthFlow({
        agent: f.agent(),
        redirectUri: `${f.state.origin}/callback`,
        pendingFlowStore: new InMemoryPendingFlowStore(),
        allowHttp: true,
      }),
    ]);
    assert.equal(outcome[0].status, 'rejected');
    assert.equal(f.state.posts.length, 0);
  } finally {
    await f.close();
  }
});

test('web callback refuses a client cleared during metadata discovery before spending the frozen client secret', async () => {
  const f = await fixture();
  let release;
  try {
    const agent = f.agent();
    const storage = storageFor(agent);
    const pendingFlowStore = new InMemoryPendingFlowStore();
    const started = await startWebOAuthFlow({
      agent,
      redirectUri: `${f.state.origin}/callback`,
      pendingFlowStore,
      agentStorage: storage,
      allowHttp: true,
    });
    f.state.metadataGate = new Promise(resolve => {
      release = resolve;
    });
    const entered = new Promise(resolve => {
      f.state.metadataEntered = resolve;
    });
    const completion = completeWebOAuthFlow({
      state: started.state,
      code: 'synthetic-code',
      expectedState: started.state,
      pendingFlowStore,
      agentStorage: storage,
      allowHttp: true,
    });
    await entered;
    const cleared = storage.current();
    delete cleared.oauth_client;
    delete cleared.oauth_tokens;
    storage.replace(cleared);
    release();
    const result = await Promise.allSettled([completion]);
    assert.equal(result[0].status, 'rejected');
    assert.equal(f.state.posts.length, 0);
    assert.deepEqual(storage.current(), cleared);
  } finally {
    release?.();
    await f.close();
  }
});

test('web registration preserves an owner deletion while its registration response is pending', async () => {
  const f = await fixture();
  let releaseRegistration;
  try {
    const agent = f.agent();
    delete agent.oauth_tokens;
    delete agent.oauth_client;
    let current = structuredClone(agent);
    let saves = 0;
    const storage = {
      async loadAgent() {
        return current && structuredClone(current);
      },
      async saveAgent(value) {
        saves++;
        current = structuredClone(value);
      },
    };
    const entered = new Promise(resolve => {
      f.state.registrationEntered = resolve;
    });
    f.state.registrationGate = new Promise(resolve => {
      releaseRegistration = resolve;
    });
    const pending = startWebOAuthFlow({
      agent,
      agentStorage: storage,
      redirectUri: `${f.state.origin}/callback`,
      pendingFlowStore: new InMemoryPendingFlowStore(),
      allowHttp: true,
    });
    await entered;
    current = undefined;
    releaseRegistration();
    const outcome = await Promise.allSettled([pending]);
    assert.equal(outcome[0].status, 'rejected');
    assert.ok(outcome[0].reason instanceof AgentVanishedDuringFlowError);
    assert.equal(saves, 0);
    assert.equal(current, undefined);
    // Remote registration already occurred; the guard prevents local resurrection.
    assert.equal(f.state.posts.length, 1);
    assert.equal(f.state.posts[0].path, '/owner/register');
  } finally {
    releaseRegistration?.();
    await f.close();
  }
});

test('credentialless web registration and code exchange persist only the validated frozen issuer', async () => {
  const f = await fixture();
  try {
    const agent = f.agent();
    delete agent.oauth_tokens;
    delete agent.oauth_client;
    const storage = storageFor(agent);
    const pendingFlowStore = new InMemoryPendingFlowStore();
    const started = await startWebOAuthFlow({
      agent,
      redirectUri: `${f.state.origin}/callback`,
      pendingFlowStore,
      agentStorage: storage,
      allowHttp: true,
    });
    const result = await completeWebOAuthFlow({
      state: started.state,
      code: 'synthetic-code',
      expectedState: started.state,
      pendingFlowStore,
      agentStorage: storage,
      allowHttp: true,
    });
    assert.equal(result.tokens.issuer, `${f.state.origin}/owner`);
    assert.equal(storage.current().oauth_tokens.issuer, `${f.state.origin}/owner`);
    assert.equal(storage.current().oauth_client.issuer, `${f.state.origin}/owner`);
  } finally {
    await f.close();
  }
});

test('web callback refuses metadata issuer replacement and legacy pending rows before code exchange', async () => {
  const f = await fixture();
  try {
    for (const variant of ['issuer changed', 'binding missing']) {
      let flow;
      const pendingFlowStore = {
        async put(value) {
          flow = structuredClone(value);
        },
        async consume() {
          const found = flow;
          flow = undefined;
          return found;
        },
      };
      const started = await startWebOAuthFlow({
        agent: f.agent(),
        redirectUri: `${f.state.origin}/callback`,
        pendingFlowStore,
        allowHttp: true,
      });
      if (variant === 'issuer changed') f.state.metadataIssuer = `${f.state.origin}/attacker`;
      else delete flow.authorizationServerIssuer;
      const outcome = await Promise.allSettled([
        completeWebOAuthFlow({
          state: started.state,
          code: 'synthetic-code',
          expectedState: started.state,
          pendingFlowStore,
          allowHttp: true,
        }),
      ]);
      assert.equal(outcome[0].status, 'rejected');
      assert.equal(f.state.posts.length, 0);
      f.state.metadataIssuer = undefined;
    }
  } finally {
    await f.close();
  }
});

test('public web storage supports an explicitly fresh owner flow with privately staged registration', async () => {
  const f = await fixture();
  try {
    const oldOwnerRecord = f.agent();
    delete oldOwnerRecord.oauth_tokens.issuer;
    delete oldOwnerRecord.oauth_client.issuer;
    const original = structuredClone(oldOwnerRecord);
    const fresh = {
      id: oldOwnerRecord.id,
      name: oldOwnerRecord.name,
      agent_uri: oldOwnerRecord.agent_uri,
      protocol: oldOwnerRecord.protocol,
    };
    let staged = structuredClone(fresh);
    let final;
    const agentStorage = {
      async loadAgent() {
        return structuredClone(staged);
      },
      async saveAgent(agent) {
        staged = structuredClone(agent);
        if (agent.oauth_tokens) final = structuredClone(agent);
      },
    };
    const pendingFlowStore = new InMemoryPendingFlowStore();
    const started = await startWebOAuthFlow({
      agent: fresh,
      redirectUri: `${f.state.origin}/callback`,
      pendingFlowStore,
      agentStorage,
      allowHttp: true,
    });
    assert.deepEqual(oldOwnerRecord, original);
    assert.equal(final, undefined);
    assert.equal(staged.oauth_client.issuer, `${f.state.origin}/owner`);
    await completeWebOAuthFlow({
      state: started.state,
      code: 'synthetic-code',
      expectedState: started.state,
      pendingFlowStore,
      agentStorage,
      allowHttp: true,
    });
    assert.deepEqual(oldOwnerRecord, original);
    assert.equal(final.oauth_tokens.issuer, `${f.state.origin}/owner`);
    assert.equal(final.oauth_client.issuer, `${f.state.origin}/owner`);
  } finally {
    await f.close();
  }
});

test('raw diagnosis keeps a matching issuer refresh and refuses a forged metadata echo', async () => {
  const f = await fixture();
  try {
    const agent = f.agent();
    const original = structuredClone(agent);
    const report = await runAuthDiagnosis(agent, { allowPrivateIp: true, skipToolCall: true });
    assert.equal(report.steps.find(step => step.name === 'token_refresh_attempt').http.status, 200);
    assert.equal(f.state.posts.length, 1);
    assert.deepEqual(agent, original);
    f.state.posts = [];
    f.state.metadataIssuer = `${f.state.origin}/other-tenant`;
    const refused = await runAuthDiagnosis(agent, { allowPrivateIp: true, skipToolCall: true });
    assert.equal(f.state.posts.length, 0);
    assert.ok(refused.steps.find(step => step.name === 'token_refresh_attempt').error);
    assert.deepEqual(agent, original);
  } finally {
    await f.close();
  }
});

for (const variant of ['different issuer', 'missing token issuer', 'missing client issuer']) {
  test(`raw auth diagnosis refuses ${variant} before secret-bearing POST`, async () => {
    const f = await fixture();
    try {
      if (variant === 'different issuer') f.state.selected = 'attacker';
      const agent = f.agent();
      if (variant === 'missing token issuer') delete agent.oauth_tokens.issuer;
      if (variant === 'missing client issuer') delete agent.oauth_client.issuer;
      const report = await runAuthDiagnosis(agent, { allowPrivateIp: true, skipToolCall: true });
      assert.equal(f.state.posts.length, 0);
      assert.ok(report.steps.find(step => step.name === 'token_refresh_attempt').error);
      assert.doesNotMatch(JSON.stringify(report), /synthetic-refresh|synthetic-client-secret|expired-synthetic-access/);
    } finally {
      await f.close();
    }
  });
}

test('explicit owner clearAuth removes persisted credentials while retaining unrelated configuration', async () => {
  const f = await fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'sdk-issuer-clear-'));
  try {
    const configPath = path.join(directory, 'config.json');
    const storage = createFileOAuthStorage({ configPath });
    const agent = f.agent();
    agent.oauth_code_verifier = 'synthetic-verifier';
    await storage.saveAgent(agent);
    const provider = createNonInteractiveOAuthProvider(agent, { storage, allowHttp: true });
    await provider.clearAuth();
    const saved = JSON.parse(await readFile(configPath, 'utf8')).agents[agent.id];
    assert.equal(saved.url, agent.agent_uri);
    assert.equal(saved.oauth_tokens, undefined);
    assert.equal(saved.oauth_client, undefined);
    assert.equal(saved.oauth_code_verifier, undefined);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('file-backed client-credentials refresh preserves omitted authorization-code client and verifier', async () => {
  const f = await fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'sdk-issuer-cc-partial-'));
  try {
    const configPath = path.join(directory, 'config.json');
    const agent = f.agent();
    agent.auth_token = 'synthetic-static-bearer';
    agent.oauth_code_verifier = 'synthetic-verifier';
    agent.oauth_client_credentials = {
      client_id: 'synthetic-cc-client',
      client_secret: 'synthetic-cc-secret',
      token_endpoint: f.state.origin + '/owner/token',
    };
    const storage = createFileOAuthStorage({ configPath, agentKey: agent.id });
    await storage.saveAgent(agent);
    // Match the CLI CC alias path: it passes tokens and CC settings but omits
    // the independently saved authorization-code client and PKCE verifier.
    const runtimeAgent = {
      id: 'cli-agent',
      name: 'CLI Agent',
      agent_uri: agent.agent_uri,
      protocol: agent.protocol,
      oauth_tokens: agent.oauth_tokens,
      oauth_client_credentials: agent.oauth_client_credentials,
    };
    await ensureClientCredentialsTokens(runtimeAgent, { storage, force: true, allowPrivateIp: true });
    const saved = JSON.parse(await readFile(configPath, 'utf8')).agents[agent.id];
    assert.equal(f.state.posts.length, 1);
    assert.equal(f.state.posts[0].form.get('grant_type'), 'client_credentials');
    assert.equal(saved.oauth_tokens.access_token, 'fresh-synthetic-access');
    assert.deepEqual(saved.oauth_client, agent.oauth_client);
    assert.equal(saved.oauth_code_verifier, agent.oauth_code_verifier);
    assert.deepEqual(saved.oauth_client_credentials, agent.oauth_client_credentials);
    assert.equal(saved.auth_token, agent.auth_token);
    assert.equal(saved.url, agent.agent_uri);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('file-backed provider token save explicitly clears a completed PKCE verifier', async () => {
  const f = await fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'sdk-issuer-provider-pkce-'));
  try {
    const configPath = path.join(directory, 'config.json');
    const storage = createFileOAuthStorage({ configPath });
    const agent = f.agent();
    agent.oauth_code_verifier = 'synthetic-verifier';
    await storage.saveAgent(agent);
    const provider = createNonInteractiveOAuthProvider(agent, { storage, allowHttp: true });
    await provider.saveTokens({
      access_token: 'fresh-synthetic-access',
      token_type: 'Bearer',
      issuer: agent.oauth_client.issuer,
    });
    const saved = JSON.parse(await readFile(configPath, 'utf8')).agents[agent.id];
    assert.equal(saved.oauth_code_verifier, undefined);
    assert.deepEqual(saved.oauth_client, agent.oauth_client);
    assert.equal(saved.oauth_tokens.access_token, 'fresh-synthetic-access');
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('file-backed web callback explicitly clears a completed PKCE verifier', async () => {
  const f = await fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'sdk-issuer-web-pkce-'));
  try {
    const configPath = path.join(directory, 'config.json');
    const agentStorage = createFileOAuthStorage({ configPath });
    const agent = f.agent();
    agent.oauth_code_verifier = 'synthetic-verifier';
    await agentStorage.saveAgent(agent);
    const pendingFlowStore = new InMemoryPendingFlowStore();
    const started = await startWebOAuthFlow({
      agent,
      agentStorage,
      pendingFlowStore,
      redirectUri: f.state.origin + '/callback',
      allowHttp: true,
    });
    await completeWebOAuthFlow({
      state: started.state,
      expectedState: started.state,
      code: 'synthetic-code',
      pendingFlowStore,
      agentStorage,
      allowHttp: true,
    });
    const saved = JSON.parse(await readFile(configPath, 'utf8')).agents[agent.id];
    assert.equal(f.state.posts.length, 1);
    assert.equal(saved.oauth_code_verifier, undefined);
    assert.deepEqual(saved.oauth_client, agent.oauth_client);
    assert.equal(saved.oauth_tokens.issuer, agent.oauth_client.issuer);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('file-backed public owner clear removes persisted tokens, client and verifier', async () => {
  const f = await fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'sdk-issuer-helper-clear-'));
  try {
    const configPath = path.join(directory, 'config.json');
    const storage = createFileOAuthStorage({ configPath });
    const agent = f.agent();
    agent.auth_token = 'synthetic-static-bearer';
    agent.oauth_code_verifier = 'synthetic-verifier';
    await storage.saveAgent(agent);
    clearOAuthTokens(agent);
    await storage.saveAgent(agent);
    const saved = JSON.parse(await readFile(configPath, 'utf8')).agents[agent.id];
    assert.equal(saved.oauth_tokens, undefined);
    assert.equal(saved.oauth_client, undefined);
    assert.equal(saved.oauth_code_verifier, undefined);
    assert.equal(saved.auth_token, agent.auth_token);
    assert.equal(saved.url, agent.agent_uri);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
