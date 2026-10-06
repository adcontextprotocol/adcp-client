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
      if (state.tokenGate) {
        state.tokenEntered?.();
        await state.tokenGate;
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
    agent.oauth_discovery_state = {
      authorizationServerUrl: `${f.state.origin}/owner`,
      authorizationServerMetadata: { issuer: `${f.state.origin}/owner` },
    };
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
    assert.deepEqual(saved.oauth_discovery_state, agent.oauth_discovery_state);
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
    const provider = createCLIOAuthProvider(agent, { storage, allowHttp: true });
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

test('background discovery validation never saves metadata-only owner mutations', async () => {
  const f = await fixture();
  try {
    const agent = f.agent();
    const original = structuredClone(agent);
    let saves = 0;
    const provider = createNonInteractiveOAuthProvider(agent, {
      allowHttp: true,
      storage: {
        async saveAgent() {
          saves++;
        },
      },
    });
    await provider.saveDiscoveryState({
      authorizationServerUrl: `${f.state.origin}/owner`,
      authorizationServerMetadata: { issuer: `${f.state.origin}/owner` },
    });
    assert.equal(saves, 0);
    assert.deepEqual(agent, original);
  } finally {
    await f.close();
  }
});

test('restored legacy PKCE discovery refuses a forged metadata issuer without mutation', async () => {
  const f = await fixture();
  try {
    const agent = f.agent();
    agent.oauth_code_verifier = 'synthetic-verifier';
    agent.oauth_discovery_state = {
      authorizationServerUrl: `${f.state.origin}/owner`,
      authorizationServerMetadata: {
        issuer: `${f.state.origin}/attacker`,
        token_endpoint: `${f.state.origin}/attacker/token`,
      },
    };
    const original = structuredClone(agent);
    let saves = 0;
    const provider = createCLIOAuthProvider(agent, {
      storage: {
        async saveAgent() {
          saves++;
        },
      },
      allowHttp: true,
    });
    await assert.rejects(provider.discoveryState(), error => error.code === 'oauth_issuer_mismatch');
    assert.deepEqual(agent, original);
    assert.equal(saves, 0);
    assert.equal(f.state.posts.length, 0);
  } finally {
    await f.close();
  }
});

test('legacy no-context credential reads retain the validated discovery binding after a shared-agent edit', async () => {
  const f = await fixture();
  try {
    const agent = f.agent();
    const provider = createNonInteractiveOAuthProvider(agent, { allowHttp: true });
    await provider.saveDiscoveryState({
      authorizationServerUrl: `${f.state.origin}/owner`,
      authorizationServerMetadata: { issuer: `${f.state.origin}/owner` },
    });
    agent.oauth_client.issuer = `${f.state.origin}/attacker`;
    await assert.rejects(provider.clientInformation(), error => error.code === 'oauth_issuer_mismatch');
    agent.oauth_client.issuer = `${f.state.origin}/owner`;
    agent.oauth_tokens.issuer = `${f.state.origin}/attacker`;
    await assert.rejects(provider.tokens(), error => error.code === 'oauth_issuer_mismatch');
    assert.equal(f.state.posts.length, 0);
  } finally {
    await f.close();
  }
});

test('file-backed interactive discovery survives reconstruction and explicit discovery cleanup', async () => {
  const f = await fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'sdk-interactive-discovery-'));
  try {
    const storage = createFileOAuthStorage({ configPath: path.join(directory, 'config.json') });
    const agent = f.agent();
    const provider = new MCPOAuthProvider({
      agent,
      storage,
      flowHandler: {},
      clientMetadata: DEFAULT_CLIENT_METADATA,
      allowInteractiveAuthorization: true,
    });
    const state = {
      authorizationServerUrl: `${f.state.origin}/owner`,
      authorizationServerMetadata: {
        issuer: `${f.state.origin}/owner`,
        token_endpoint: `${f.state.origin}/owner/token`,
      },
    };
    await provider.saveDiscoveryState(state);
    await provider.saveCodeVerifier('synthetic-verifier');
    const loaded = await storage.loadAgent(agent.id);
    const reader = new MCPOAuthProvider({
      agent: loaded,
      storage,
      flowHandler: {},
      clientMetadata: DEFAULT_CLIENT_METADATA,
      allowInteractiveAuthorization: true,
    });
    const returned = await reader.discoveryState();
    assert.deepEqual(returned, state);
    returned.authorizationServerMetadata.issuer = `${f.state.origin}/attacker`;
    assert.deepEqual(await reader.discoveryState(), state);
    await reader.invalidateCredentials('discovery');
    const cleared = await storage.loadAgent(agent.id);
    assert.equal(cleared.oauth_discovery_state, undefined);
    assert.deepEqual(cleared.oauth_client, loaded.oauth_client);
    assert.deepEqual(cleared.oauth_tokens, loaded.oauth_tokens);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await f.close();
  }
});

function ownerPendingDiscovery(f) {
  return {
    authorizationServerUrl: `${f.state.origin}/owner`,
    authorizationServerMetadata: {
      issuer: `${f.state.origin}/owner`,
      authorization_endpoint: `${f.state.origin}/owner/authorize`,
      token_endpoint: `${f.state.origin}/owner/token`,
      registration_endpoint: `${f.state.origin}/owner/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    },
  };
}

for (const era of ['modern', 'legacy']) {
  test(`${era} background registered client without a grant preserves pending owner PKCE before refusing sign-in`, async () => {
    const f = await fixture();
    try {
      const agent = f.agent();
      delete agent.oauth_tokens;
      agent.oauth_code_verifier = 'existing-owner-verifier';
      agent.oauth_discovery_state = ownerPendingDiscovery(f);
      const original = structuredClone(agent);
      let saves = 0;
      const provider = createNonInteractiveOAuthProvider(agent, {
        allowHttp: true,
        storage: {
          async saveAgent() {
            saves++;
          },
        },
      });
      const auth =
        era === 'modern'
          ? require('@modelcontextprotocol/client').auth
          : (await import('@modelcontextprotocol/sdk/client/auth.js')).auth;
      const [outcome] = await Promise.allSettled([auth(provider, { serverUrl: agent.agent_uri })]);
      assert.equal(saves, 0, 'unsupported sign-in must refuse before any owner persistence');
      assert.deepEqual(agent, original);
      assert.equal(f.state.posts.length, 0);
      assert.equal(outcome.status, 'rejected');
      assert.equal(outcome.reason.code, 'owner_reauthorization_required');
    } finally {
      await f.close();
    }
  });

  test(`${era} background matching refresh preserves an independently pending owner PKCE flow`, async () => {
    const f = await fixture();
    try {
      const agent = f.agent();
      agent.oauth_code_verifier = 'existing-owner-verifier';
      agent.oauth_discovery_state = ownerPendingDiscovery(f);
      const original = structuredClone(agent);
      const saved = [];
      const provider = createNonInteractiveOAuthProvider(agent, {
        allowHttp: true,
        storage: {
          async saveAgent(a) {
            saved.push(structuredClone(a));
          },
        },
      });
      const auth =
        era === 'modern'
          ? require('@modelcontextprotocol/client').auth
          : (await import('@modelcontextprotocol/sdk/client/auth.js')).auth;
      assert.equal(await auth(provider, { serverUrl: agent.agent_uri }), 'AUTHORIZED');
      assert.equal(f.state.posts.length, 1);
      assert.equal(f.state.posts[0].path, '/owner/token');
      assert.equal(saved.length, 1);
      assert.equal(saved[0].oauth_tokens.refresh_token, 'rotated-synthetic-refresh');
      assert.equal(saved[0].oauth_tokens.issuer, `${f.state.origin}/owner`);
      assert.equal(Object.hasOwn(saved[0], 'oauth_code_verifier'), false);
      assert.equal(Object.hasOwn(saved[0], 'oauth_discovery_state'), false);
      assert.equal(agent.oauth_code_verifier, original.oauth_code_verifier);
      assert.deepEqual(agent.oauth_discovery_state, original.oauth_discovery_state);
      assert.deepEqual(saved[0].oauth_client, original.oauth_client);
    } finally {
      await f.close();
    }
  });
}

for (const scope of ['discovery', 'verifier']) {
  test(`background ${scope} invalidation clears only private discovery and preserves owner pending state`, async () => {
    const f = await fixture();
    try {
      const agent = f.agent();
      agent.oauth_code_verifier = 'existing-owner-verifier';
      agent.oauth_discovery_state = ownerPendingDiscovery(f);
      const original = structuredClone(agent);
      let saves = 0;
      const provider = createNonInteractiveOAuthProvider(agent, {
        allowHttp: true,
        storage: {
          async saveAgent() {
            saves++;
          },
        },
      });
      await provider.saveDiscoveryState(ownerPendingDiscovery(f));
      await provider.invalidateCredentials(scope);
      assert.equal(saves, 0);
      assert.deepEqual(agent, original);
      assert.equal(
        await provider.discoveryState(),
        undefined,
        'a cleared private cache cannot borrow owner PKCE state'
      );
      assert.equal(f.state.posts.length, 0);
    } finally {
      await f.close();
    }
  });
}

test('background PKCE access and writes refuse before borrowing or overwriting owner state', async () => {
  const f = await fixture();
  try {
    const agent = f.agent();
    agent.oauth_code_verifier = 'existing-owner-verifier';
    agent.oauth_discovery_state = ownerPendingDiscovery(f);
    const original = structuredClone(agent);
    let saves = 0;
    const provider = createNonInteractiveOAuthProvider(agent, {
      allowHttp: true,
      storage: {
        async saveAgent() {
          saves++;
        },
      },
    });
    await assert.rejects(
      provider.saveCodeVerifier('replacement-verifier'),
      error => error.code === 'owner_reauthorization_required'
    );
    await assert.rejects(provider.codeVerifier(), error => error.code === 'owner_reauthorization_required');
    assert.deepEqual(agent, original);
    assert.equal(saves, 0);
  } finally {
    await f.close();
  }
});

for (const era of ['modern', 'legacy']) {
  test(`${era} file-backed background refresh preserves owner PKCE created during the token request`, async () => {
    const f = await fixture();
    const directory = await mkdtemp(path.join(tmpdir(), 'sdk-issuer-background-inflight-'));
    let releaseToken;
    try {
      const storage = createFileOAuthStorage({ configPath: path.join(directory, 'config.json') });
      const original = f.agent();
      await storage.saveAgent(original);
      const staleAgent = await storage.loadAgent(original.id);
      assert.equal(Object.hasOwn(staleAgent, 'oauth_code_verifier'), true);
      assert.equal(staleAgent.oauth_code_verifier, undefined);
      assert.equal(Object.hasOwn(staleAgent, 'oauth_discovery_state'), true);
      assert.equal(staleAgent.oauth_discovery_state, undefined);
      const entered = new Promise(resolve => {
        f.state.tokenEntered = resolve;
      });
      f.state.tokenGate = new Promise(resolve => {
        releaseToken = resolve;
      });
      const provider = createNonInteractiveOAuthProvider(staleAgent, { storage, allowHttp: true });
      const auth =
        era === 'modern'
          ? require('@modelcontextprotocol/client').auth
          : (await import('@modelcontextprotocol/sdk/client/auth.js')).auth;
      const operation = auth(provider, { serverUrl: staleAgent.agent_uri });
      await entered;
      const owner = await storage.loadAgent(original.id);
      owner.oauth_code_verifier = 'new-owner-verifier';
      owner.oauth_discovery_state = ownerPendingDiscovery(f);
      await storage.saveAgent(owner);
      releaseToken();
      assert.equal(await operation, 'AUTHORIZED');
      const saved = await storage.loadAgent(original.id);
      assert.equal(f.state.posts.length, 1);
      assert.equal(f.state.posts[0].path, '/owner/token');
      assert.equal(saved.oauth_tokens.refresh_token, 'rotated-synthetic-refresh');
      assert.equal(saved.oauth_tokens.issuer, `${f.state.origin}/owner`);
      assert.equal(saved.oauth_code_verifier, owner.oauth_code_verifier);
      assert.deepEqual(saved.oauth_discovery_state, owner.oauth_discovery_state);
      assert.deepEqual(saved.oauth_client, original.oauth_client);
      assert.equal(staleAgent.oauth_code_verifier, undefined);
      assert.equal(staleAgent.oauth_discovery_state, undefined);
    } finally {
      releaseToken?.();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const era of ['modern', 'legacy']) {
  test(`${era} public-client issuer back-stamp preserves file-backed owner PKCE created during auth`, async () => {
    const f = await fixture();
    const directory = await mkdtemp(path.join(tmpdir(), 'sdk-issuer-public-client-inflight-'));
    let releaseGate;
    try {
      const storage = createFileOAuthStorage({ configPath: path.join(directory, 'config.json') });
      const original = f.agent();
      delete original.oauth_client.issuer;
      delete original.oauth_client.client_secret;
      await storage.saveAgent(original);
      const staleAgent = await storage.loadAgent(original.id);
      assert.equal(Object.hasOwn(staleAgent, 'oauth_code_verifier'), true);
      assert.equal(staleAgent.oauth_code_verifier, undefined);
      assert.equal(Object.hasOwn(staleAgent, 'oauth_discovery_state'), true);
      assert.equal(staleAgent.oauth_discovery_state, undefined);
      const entered = new Promise(resolve => {
        if (era === 'modern') f.state.metadataEntered = resolve;
        else f.state.tokenEntered = resolve;
      });
      const gate = new Promise(resolve => {
        releaseGate = resolve;
      });
      if (era === 'modern') f.state.metadataGate = gate;
      else f.state.tokenGate = gate;
      const provider = createNonInteractiveOAuthProvider(staleAgent, { storage, allowHttp: true });
      const auth =
        era === 'modern'
          ? require('@modelcontextprotocol/client').auth
          : (await import('@modelcontextprotocol/sdk/client/auth.js')).auth;
      const operation = auth(provider, { serverUrl: staleAgent.agent_uri });
      await entered;
      const owner = await storage.loadAgent(original.id);
      owner.oauth_code_verifier = 'new-owner-verifier';
      owner.oauth_discovery_state = ownerPendingDiscovery(f);
      await storage.saveAgent(owner);
      releaseGate();
      assert.equal(await operation, 'AUTHORIZED');
      const saved = await storage.loadAgent(original.id);
      assert.equal(f.state.posts.length, 1);
      assert.equal(f.state.posts[0].path, '/owner/token');
      assert.equal(saved.oauth_tokens.refresh_token, 'rotated-synthetic-refresh');
      assert.equal(saved.oauth_tokens.issuer, `${f.state.origin}/owner`);
      assert.equal(saved.oauth_code_verifier, owner.oauth_code_verifier);
      assert.deepEqual(saved.oauth_discovery_state, owner.oauth_discovery_state);
      assert.equal(saved.oauth_client.client_id, original.oauth_client.client_id);
      assert.equal(saved.oauth_client.client_secret, undefined);
      assert.equal(saved.oauth_client.issuer, `${f.state.origin}/owner`);
      assert.equal(staleAgent.oauth_code_verifier, undefined);
      assert.equal(staleAgent.oauth_discovery_state, undefined);
    } finally {
      releaseGate?.();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('file-loaded client-credentials refresh preserves owner PKCE created during the token request', async () => {
  const f = await fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'sdk-issuer-cc-inflight-'));
  let releaseToken;
  try {
    const storage = createFileOAuthStorage({ configPath: path.join(directory, 'config.json') });
    const original = f.agent();
    original.oauth_client_credentials = {
      client_id: 'synthetic-cc-client',
      client_secret: 'synthetic-cc-secret',
      token_endpoint: `${f.state.origin}/owner/token`,
    };
    await storage.saveAgent(original);
    const staleAgent = await storage.loadAgent(original.id);
    assert.equal(Object.hasOwn(staleAgent, 'oauth_code_verifier'), true);
    assert.equal(staleAgent.oauth_code_verifier, undefined);
    assert.equal(Object.hasOwn(staleAgent, 'oauth_discovery_state'), true);
    assert.equal(staleAgent.oauth_discovery_state, undefined);
    const entered = new Promise(resolve => {
      f.state.tokenEntered = resolve;
    });
    f.state.tokenGate = new Promise(resolve => {
      releaseToken = resolve;
    });
    const operation = ensureClientCredentialsTokens(staleAgent, { storage, force: true, allowPrivateIp: true });
    await entered;
    const owner = await storage.loadAgent(original.id);
    owner.oauth_code_verifier = 'new-owner-verifier';
    owner.oauth_discovery_state = ownerPendingDiscovery(f);
    await storage.saveAgent(owner);
    releaseToken();
    await operation;
    const saved = await storage.loadAgent(original.id);
    assert.equal(f.state.posts.length, 1);
    assert.equal(f.state.posts[0].path, '/owner/token');
    assert.equal(f.state.posts[0].form.get('grant_type'), 'client_credentials');
    assert.equal(saved.oauth_tokens.access_token, 'fresh-synthetic-access');
    assert.equal(saved.oauth_code_verifier, owner.oauth_code_verifier);
    assert.deepEqual(saved.oauth_discovery_state, owner.oauth_discovery_state);
    assert.deepEqual(saved.oauth_client, original.oauth_client);
    assert.deepEqual(saved.oauth_client_credentials, original.oauth_client_credentials);
    assert.equal(staleAgent.oauth_code_verifier, undefined);
    assert.equal(staleAgent.oauth_discovery_state, undefined);
  } finally {
    releaseToken?.();
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
