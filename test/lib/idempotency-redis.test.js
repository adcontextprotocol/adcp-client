/**
 * Redis idempotency backend integration tests.
 *
 * Requires a running Redis instance. Set REDIS_URL to run:
 *   NODE_ENV=test REDIS_URL=redis://localhost:6379/15 node --test test/lib/idempotency-redis.test.js
 *
 * Use a dedicated db index (e.g., /15) — these tests FLUSHDB between runs.
 * Skipped entirely when REDIS_URL is not set.
 */

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const REDIS_URL = process.env.REDIS_URL;

// ────────── pure-function tests (no live Redis required) ──────────
//
// detectNodeRedisDbIndex + the default-prefix warning gate work off
// the client object's shape, not a live connection. Run them
// unconditionally so the warn behavior gets coverage in CI even when
// REDIS_URL isn't set.

describe('redisBackend — default-prefix-on-db-0 warning', () => {
  let redisBackend, __resetDefaultPrefixWarningForTests;
  let originalWarn;
  let warnings;

  before(() => {
    const server = require('../../dist/lib/server/index.js');
    redisBackend = server.redisBackend;
    // Reset hook is exported from the backend module but not surfaced
    // through the public server index — reach into the inner module.
    __resetDefaultPrefixWarningForTests =
      require('../../dist/lib/server/idempotency/backends/redis.js').__resetDefaultPrefixWarningForTests;
  });

  beforeEach(() => {
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    __resetDefaultPrefixWarningForTests();
  });

  after(() => {
    console.warn = originalWarn;
  });

  // Stub clients — never connected. The redisBackend constructor never
  // calls into them; only `detectNodeRedisDbIndex` reads `.options`.
  const stubClient = options => ({
    options,
    get: async () => null,
    set: async () => null,
    del: async () => 0,
    eval: async () => null,
    ping: async () => 'PONG',
  });

  test('warns once on default prefix + db 0 (options.database)', () => {
    redisBackend(stubClient({ database: 0 }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /default keyPrefix/);
    assert.match(warnings[0], /db 0/);
  });

  test('warns once on default prefix + db 0 (parsed from options.url)', () => {
    redisBackend(stubClient({ url: 'redis://localhost:6379' })); // implicit db 0
    assert.equal(warnings.length, 1);
  });

  test('warns once on default prefix + explicit /0 in url', () => {
    redisBackend(stubClient({ url: 'redis://localhost:6379/0' }));
    assert.equal(warnings.length, 1);
  });

  test('does NOT warn on db 15 (explicit dedicated db index)', () => {
    redisBackend(stubClient({ database: 15 }));
    assert.equal(warnings.length, 0);
  });

  test('does NOT warn on db 7 parsed from url', () => {
    redisBackend(stubClient({ url: 'redis://localhost:6379/7' }));
    assert.equal(warnings.length, 0);
  });

  test('warns when keyPrefix is explicitly set to the shared default', () => {
    redisBackend(stubClient({ database: 0 }), { keyPrefix: 'adcp:idem:' });
    assert.equal(warnings.length, 1);
  });

  test('does NOT warn when suppressDefaultPrefixWarning is set', () => {
    redisBackend(stubClient({ database: 0 }), { suppressDefaultPrefixWarning: true });
    assert.equal(warnings.length, 0);
  });

  test('does NOT warn for escape-hatch clients without an introspectable options.database / options.url', () => {
    // RedisLikeClient adapter path — no `options` object at all.
    redisBackend({
      get: async () => null,
      del: async () => 0,
      eval: async () => null,
      ping: async () => 'PONG',
    });
    assert.equal(warnings.length, 0);
  });

  test('warns at most once per process across multiple backend constructions', () => {
    redisBackend(stubClient({ database: 0 }));
    redisBackend(stubClient({ database: 0 }));
    redisBackend(stubClient({ database: 0 }));
    assert.equal(warnings.length, 1);
  });

  test('rediss:// (TLS) URL also triggers the warn on db 0', () => {
    redisBackend(stubClient({ url: 'rediss://prod.example.com:6380' }));
    assert.equal(warnings.length, 1);
  });

  test('does NOT warn when url has a non-numeric path component', () => {
    // Defensive — a malformed url path shouldn't be assumed to be db 0.
    redisBackend(stubClient({ url: 'redis://localhost:6379/notanumber' }));
    assert.equal(warnings.length, 0);
  });

  test('non-development environments require an explicit deployment prefix or isolation acknowledgement', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      for (const env of [undefined, 'staging', 'production']) {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        assert.throws(() => redisBackend(stubClient({ database: 0 })), /deployment-unique keyPrefix/);
        assert.doesNotThrow(() => redisBackend(stubClient({ database: 0 }), { keyPrefix: 'buyer-prod:' }));
        assert.doesNotThrow(() => redisBackend(stubClient({ database: 0 }), { acknowledgeIsolatedDatabase: true }));
        assert.throws(
          () => redisBackend(stubClient({ database: 0 }), { suppressDefaultPrefixWarning: true }),
          /deployment-unique keyPrefix/
        );
        assert.throws(
          () => redisBackend(stubClient({ database: 0 }), { keyPrefix: '' }),
          /deployment-unique keyPrefix/
        );
        assert.throws(
          () => redisBackend(stubClient({ database: 0 }), { keyPrefix: 'adcp:idem:' }),
          /deployment-unique keyPrefix/
        );
      }
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('rejects a client that lacks Lua eval support at construction', () => {
    assert.throws(
      () =>
        redisBackend({ get: async () => null, set: async () => null, del: async () => 0, ping: async () => 'PONG' }),
      /client must implement eval\(\)/
    );
  });
});

test('redisBackend redacts client errors from every runtime operation', async () => {
  const { redisBackend } = require('../../dist/lib/server/index.js');
  const driverError = new Error('WRONGPASS redis://secret-host scoped-tenant-key');
  const client = {
    get: async () => {
      throw driverError;
    },
    set: async () => {
      throw driverError;
    },
    del: async () => {
      throw driverError;
    },
    eval: async () => {
      throw driverError;
    },
    ping: async () => 'PONG',
  };
  const backend = redisBackend(client, { keyPrefix: 'test-runtime-errors:' });
  const entry = {
    payloadHash: 'owner-token',
    response: {},
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  const operations = [
    ['get', () => backend.get('scoped-key')],
    ['put', () => backend.put('scoped-key', entry)],
    ['putIfAbsent', () => backend.putIfAbsent('scoped-key', entry)],
    ['replaceIfPayloadHash', () => backend.replaceIfPayloadHash('scoped-key', 'owner-token', entry)],
    [
      'replaceIfPayloadHashAndExpired',
      () => backend.replaceIfPayloadHashAndExpired('scoped-key', 'owner-token', entry),
    ],
    ['deleteIfPayloadHash', () => backend.deleteIfPayloadHash('scoped-key', 'owner-token')],
    ['delete', () => backend.delete('scoped-key')],
  ];

  for (const [name, operation] of operations) {
    await assert.rejects(operation, error => {
      assert.equal(error.message, `redisBackend.${name}: database operation failed`);
      assert.doesNotMatch(error.message, /WRONGPASS|secret-host|scoped-tenant-key/);
      assert.strictEqual(error.cause, driverError);
      return true;
    });
  }
});

test('redisBackend putIfAbsent is absent-only and derives physical TTL from Redis server time', async () => {
  const { redisBackend } = require('../../dist/lib/server/index.js');
  let observedScript;
  let observedArguments;
  const client = {
    get: async () => null,
    set: async () => null,
    del: async () => 0,
    eval: async (script, options) => {
      observedScript = script;
      observedArguments = options.arguments;
      return 1;
    },
    ping: async () => 'PONG',
  };
  const backend = redisBackend(client, { keyPrefix: 'clock-skew-test:' });
  const entry = {
    payloadHash: 'owner',
    response: null,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  const claimed = await backend.putIfAbsent('scope', entry);

  assert.equal(claimed, true);
  assert.match(observedScript, /if raw then return 0 end/);
  assert.match(observedScript, /redis\.call\('TIME'\)/);
  assert.match(observedScript, /local ttl = tonumber\(ARGV\[2\]\) - now \+ 1/);
  assert.deepEqual(observedArguments, [JSON.stringify(entry), String(entry.expiresAt + 120)]);
});

test('redisBackend expired-owner replacement combines payload hash and Redis-time expiry predicates', async () => {
  const { redisBackend } = require('../../dist/lib/server/index.js');
  let observedScript;
  let observedArguments;
  const client = {
    get: async () => null,
    set: async () => null,
    del: async () => 0,
    eval: async (script, options) => {
      observedScript = script;
      observedArguments = options.arguments;
      return 0;
    },
    ping: async () => 'PONG',
  };
  const backend = redisBackend(client, { keyPrefix: 'expired-cas-test:' });
  const entry = {
    payloadHash: 'new-owner',
    response: { version: 2 },
    expiresAt: 2_000_000_000,
    retainUntil: 2_000_000_200,
  };

  assert.equal(await backend.replaceIfPayloadHashAndExpired('scope', 'expected-owner', entry), false);
  assert.match(observedScript, /if current\.payloadHash ~= ARGV\[1\] then return 0 end/);
  assert.match(observedScript, /redis\.call\('TIME'\)/);
  assert.match(observedScript, /if tonumber\(current\.expiresAt\) >= now then return 0 end/);
  assert.match(observedScript, /local ttl = tonumber\(ARGV\[3\]\) - now \+ 1/);
  assert.match(observedScript, /redis\.call\('SET'/);
  assert.deepEqual(observedArguments, ['expected-owner', JSON.stringify(entry), String(entry.retainUntil)]);
});

test('redisBackend derives physical expiry from retainUntil using Redis server time despite application clock skew', async () => {
  const { redisBackend } = require('../../dist/lib/server/index.js');
  let observedScript;
  let observedArguments;
  const client = {
    get: async () => null,
    set: async () => 'OK',
    del: async () => 0,
    eval: async (script, options) => {
      observedScript = script;
      observedArguments = options.arguments;
      return 1;
    },
    ping: async () => 'PONG',
  };
  const redisServerNow = Math.floor(Date.now() / 1000);
  const applicationNow = redisServerNow + 600;
  const backend = redisBackend(client, {
    keyPrefix: 'retention-horizon-test:',
    expiredGraceSeconds: 0,
  });
  const entry = {
    payloadHash: 'owner',
    response: null,
    expiresAt: applicationNow + 3600,
    retainUntil: applicationNow + 3690,
  };
  const originalDateNow = Date.now;
  Date.now = () => applicationNow * 1000;
  try {
    await backend.put('scope', entry);
  } finally {
    Date.now = originalDateNow;
  }

  assert.match(observedScript, /redis\.call\('TIME'\)/);
  assert.match(observedScript, /local ttl = tonumber\(ARGV\[2\]\) - now \+ 1/);
  assert.deepEqual(observedArguments, [JSON.stringify(entry), String(entry.retainUntil)]);
  assert.equal(Number(observedArguments[1]) - redisServerNow + 1, 4291);
});

test('redisBackend validates legacy retention grace against store clock skew', () => {
  const { redisBackend, createIdempotencyStore } = require('../../dist/lib/server/index.js');
  const client = {
    get: async () => null,
    set: async () => 'OK',
    del: async () => 0,
    eval: async () => 1,
    ping: async () => 'PONG',
  };
  const backend = redisBackend(client, { keyPrefix: 'legacy-grace-test:', expiredGraceSeconds: 30 });
  assert.throws(
    () => createIdempotencyStore({ backend, clockSkewSeconds: 60 }),
    /legacy retention grace \(30s\) must be at least clockSkewSeconds \(60s\)/
  );
});

test('redisBackend assigns configured retention to legacy serialized entries', async () => {
  const { redisBackend } = require('../../dist/lib/server/index.js');
  const client = {
    get: async () => JSON.stringify({ payloadHash: 'legacy', response: {}, expiresAt: 1_000 }),
    set: async () => 'OK',
    del: async () => 0,
    eval: async () => 1,
    ping: async () => 'PONG',
  };
  const backend = redisBackend(client, { keyPrefix: 'legacy-entry-test:', expiredGraceSeconds: 90 });
  const entry = await backend.get('scope');
  assert.equal(entry.retainUntil, 1_090);
});

test('redisBackend payload-hash fencing replaces and deletes only the current owner', async () => {
  const values = new Map();
  const client = {
    get: async key => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
      return 'OK';
    },
    del: async key => (values.delete(key) ? 1 : 0),
    eval: async (script, options) => {
      const key = options.keys[0];
      if (!/current\.payloadHash/.test(script)) {
        assert.match(script, /redis\.call\('TIME'\)/);
        assert.match(script, /redis\.call\('SET'/);
        values.set(key, options.arguments[0]);
        return 1;
      }
      assert.match(script, /if current\.payloadHash ~= ARGV\[1\] then return 0 end/);
      const raw = values.get(key);
      if (raw === undefined) return 0;
      const current = JSON.parse(raw);
      if (current.payloadHash !== options.arguments[0]) return 0;
      if (/redis\.call\('SET'/.test(script)) {
        assert.match(script, /redis\.call\('TIME'\)/);
        assert.match(script, /local ttl = tonumber\(ARGV\[3\]\) - now \+ 1/);
        assert.equal(options.arguments[2], String(JSON.parse(options.arguments[1]).retainUntil));
        values.set(key, options.arguments[1]);
        return 1;
      }
      assert.match(script, /redis\.call\('DEL'/);
      return values.delete(key) ? 1 : 0;
    },
    ping: async () => 'PONG',
  };
  const { redisBackend } = require('../../dist/lib/server/index.js');
  const backend = redisBackend(client, { keyPrefix: 'cas-test:' });
  const now = Math.floor(Date.now() / 1000);
  await backend.put('scope', {
    payloadHash: 'owner-a',
    response: { version: 1 },
    expiresAt: now + 3600,
    retainUntil: now + 3700,
  });
  const replacement = {
    payloadHash: 'owner-b',
    response: { version: 2 },
    expiresAt: now + 7200,
    retainUntil: now + 7500,
  };

  assert.equal(await backend.replaceIfPayloadHash('scope', 'stale-owner', replacement), false);
  assert.deepEqual(await backend.get('scope'), {
    payloadHash: 'owner-a',
    response: { version: 1 },
    expiresAt: now + 3600,
    retainUntil: now + 3700,
  });

  assert.equal(await backend.replaceIfPayloadHash('scope', 'owner-a', replacement), true);
  assert.deepEqual(await backend.get('scope'), replacement);

  assert.equal(await backend.deleteIfPayloadHash('scope', 'owner-a'), false);
  assert.deepEqual(await backend.get('scope'), replacement);
  assert.equal(await backend.deleteIfPayloadHash('scope', 'owner-b'), true);
  assert.equal(await backend.get('scope'), null);
});

describe('redisBackend', { skip: !REDIS_URL && 'REDIS_URL not set' }, () => {
  let client;
  let redisBackend, createIdempotencyStore;

  before(async () => {
    const { createClient } = require('redis');
    client = createClient({ url: REDIS_URL });
    client.on('error', err => console.error('redis test client error', err));
    await client.connect();

    const server = require('../../dist/lib/server/index.js');
    redisBackend = server.redisBackend;
    createIdempotencyStore = server.createIdempotencyStore;

    await client.flushDb();
  });

  beforeEach(async () => {
    await client.flushDb();
  });

  after(async () => {
    if (client) {
      await client.flushDb();
      await client.quit();
    }
  });

  // ────────── options validation ──────────

  test('rejects negative expiredGraceSeconds', () => {
    assert.throws(() => redisBackend(client, { expiredGraceSeconds: -1 }), /must be a non-negative/);
  });

  test('rejects fractional expiredGraceSeconds', () => {
    assert.throws(() => redisBackend(client, { expiredGraceSeconds: 1.5 }), /must be a non-negative safe integer/);
  });

  // ────────── backend primitives ──────────

  test('probe resolves against a live client', async () => {
    const backend = redisBackend(client);
    await backend.probe();
  });

  test('get returns null for missing key', async () => {
    const backend = redisBackend(client);
    const result = await backend.get('missing-key');
    assert.equal(result, null);
  });

  test('put + get round-trip', async () => {
    const backend = redisBackend(client);
    const entry = {
      payloadHash: 'deadbeef',
      response: { media_buy_id: 'mb_42', packages: [{ id: 'p1' }] },
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    await backend.put('pk', entry);
    const got = await backend.get('pk');
    assert.deepEqual(got.response, entry.response);
    assert.equal(got.payloadHash, entry.payloadHash);
    assert.equal(got.expiresAt, entry.expiresAt);
  });

  test('put overwrites existing entry', async () => {
    const backend = redisBackend(client);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    await backend.put('pk', { payloadHash: 'h1', response: { v: 1 }, expiresAt });
    await backend.put('pk', { payloadHash: 'h2', response: { v: 2 }, expiresAt });

    const got = await backend.get('pk');
    assert.equal(got.payloadHash, 'h2');
    assert.deepEqual(got.response, { v: 2 });
  });

  test('putIfAbsent returns true on fresh key', async () => {
    const backend = redisBackend(client);
    const claimed = await backend.putIfAbsent('pk', {
      payloadHash: 'h1',
      response: null,
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    });
    assert.equal(claimed, true);
  });

  test('putIfAbsent returns false when an unexpired entry exists', async () => {
    const backend = redisBackend(client);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await backend.put('pk', { payloadHash: 'h1', response: { v: 1 }, expiresAt });

    const claimed = await backend.putIfAbsent('pk', {
      payloadHash: 'h2',
      response: { v: 2 },
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    });
    assert.equal(claimed, false);

    // Original entry untouched
    const got = await backend.get('pk');
    assert.equal(got.payloadHash, 'h1');
    assert.deepEqual(got.response, { v: 1 });
  });

  test('putIfAbsent leaves a retained expired entry for exact-generation reclaim', async () => {
    const backend = redisBackend(client);
    await client.set(
      'adcp:idem:preclaim',
      JSON.stringify({
        payloadHash: 'stale',
        response: null,
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      }),
      { EX: 60 }
    );

    const replacement = {
      payloadHash: 'fresh',
      response: { fresh: true },
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    };
    assert.equal(await backend.putIfAbsent('preclaim', replacement), false);
    assert.equal(await backend.replaceIfPayloadHashAndExpired('preclaim', 'stale', replacement), true);

    const got = await backend.get('preclaim');
    assert.equal(got.payloadHash, 'fresh');
    assert.deepEqual(got.response, { fresh: true });
  });

  test('Redis refuses to write an entry whose physical retention horizon is already past', async () => {
    const backend = redisBackend(client);
    // expiresAt 3600s in the past — even with the 120s grace window,
    // the resulting Redis TTL would be deeply negative. Must throw
    // rather than silently clamp to EX 1 (which would let the entry
    // vanish in 1s and let the next caller re-execute the side effect).
    await assert.rejects(
      () =>
        backend.put('pstale', {
          payloadHash: 'h',
          response: {},
          expiresAt: Math.floor(Date.now() / 1000) - 3600,
        }),
      /redisBackend\.put: database operation failed/
    );
  });

  test('concurrent putIfAbsent — only one caller wins the claim', async () => {
    const backend = redisBackend(client);
    const entry = {
      payloadHash: 'claim',
      response: null,
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    };

    const results = await Promise.all(Array.from({ length: 10 }, () => backend.putIfAbsent('prace', entry)));
    const winners = results.filter(x => x === true);
    assert.equal(winners.length, 1, 'exactly one concurrent putIfAbsent must win');
  });

  test('delete removes the entry', async () => {
    const backend = redisBackend(client);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await backend.put('pk', { payloadHash: 'h', response: {}, expiresAt });
    await backend.delete('pk');
    assert.equal(await backend.get('pk'), null);
  });

  test('payload-hash fencing replaces and deletes only the current Redis value', async () => {
    const backend = redisBackend(client);
    const now = Math.floor(Date.now() / 1000);
    await backend.put('pcas', {
      payloadHash: 'owner-a',
      response: { version: 1 },
      expiresAt: now + 3600,
      retainUntil: now + 3700,
    });
    const replacement = {
      payloadHash: 'owner-b',
      response: { version: 2 },
      expiresAt: now + 7200,
      retainUntil: now + 7500,
    };

    assert.equal(await backend.replaceIfPayloadHash('pcas', 'stale-owner', replacement), false);
    assert.equal((await backend.get('pcas')).payloadHash, 'owner-a');
    assert.equal(await backend.replaceIfPayloadHash('pcas', 'owner-a', replacement), true);
    assert.deepEqual(await backend.get('pcas'), replacement);

    assert.equal(await backend.deleteIfPayloadHash('pcas', 'owner-a'), false);
    assert.deepEqual(await backend.get('pcas'), replacement);
    assert.equal(await backend.deleteIfPayloadHash('pcas', 'owner-b'), true);
    assert.equal(await backend.get('pcas'), null);

    await backend.put('pexpired-cas', {
      payloadHash: 'expired-owner',
      response: { version: 1 },
      expiresAt: now - 2,
      retainUntil: now + 3700,
    });
    assert.equal(await backend.replaceIfPayloadHashAndExpired('pexpired-cas', 'stale-owner', replacement), false);
    assert.equal(await backend.replaceIfPayloadHashAndExpired('pexpired-cas', 'expired-owner', replacement), true);
    assert.deepEqual(await backend.get('pexpired-cas'), replacement);
  });

  test('keyPrefix isolates writes from other apps on the same db', async () => {
    const a = redisBackend(client, { keyPrefix: 'appA:' });
    const b = redisBackend(client, { keyPrefix: 'appB:' });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    await a.put('shared', { payloadHash: 'A', response: { from: 'a' }, expiresAt });
    await b.put('shared', { payloadHash: 'B', response: { from: 'b' }, expiresAt });

    assert.equal((await a.get('shared')).payloadHash, 'A');
    assert.equal((await b.get('shared')).payloadHash, 'B');
  });

  test('corrupt cached value surfaces an error rather than silently missing', async () => {
    const backend = redisBackend(client);
    await client.set('adcp:idem:pcorrupt', 'not json', { EX: 60 });
    await assert.rejects(
      () => backend.get('pcorrupt'),
      err => {
        // Generic public message — no scoped key, no parse-error detail.
        assert.match(err.message, /corrupt cache entry/);
        assert.doesNotMatch(err.message, /p\x1fcorrupt/, 'public error must not leak the scoped key');
        // Underlying parse error attached as Error.cause for server-side logs.
        assert.ok(err.cause instanceof Error, 'parse error must ride on Error.cause');
        return true;
      }
    );
  });

  // ────────── store + backend end-to-end ──────────

  test('store check/save round-trip works against real redis', async () => {
    const store = createIdempotencyStore({ backend: redisBackend(client), ttlSeconds: 3600 });
    const payload = { budget: 5000, tags: ['a', 'b'] };

    const miss = await store.check({ principal: 'p', key: 'e2e_key_abcdefghij', payload });
    assert.equal(miss.kind, 'miss');

    await store.save({
      principal: 'p',
      key: 'e2e_key_abcdefghij',
      payloadHash: miss.payloadHash,
      claimToken: miss.claimToken,
      response: { media_buy_id: 'mb_77' },
    });

    const replay = await store.check({ principal: 'p', key: 'e2e_key_abcdefghij', payload });
    assert.equal(replay.kind, 'replay');
    assert.deepEqual(replay.response, { media_buy_id: 'mb_77' });
  });

  test('store returns conflict on same-key different-payload', async () => {
    const store = createIdempotencyStore({ backend: redisBackend(client), ttlSeconds: 3600 });
    const { payloadHash, claimToken } = await store.check({
      principal: 'p',
      key: 'conflict_key_abcdefg',
      payload: { a: 1 },
    });
    await store.save({
      principal: 'p',
      key: 'conflict_key_abcdefg',
      payloadHash,
      claimToken,
      response: { ok: true },
    });

    const conflict = await store.check({
      principal: 'p',
      key: 'conflict_key_abcdefg',
      payload: { a: 2 },
    });
    assert.equal(conflict.kind, 'conflict');
  });

  test('store refuses stale-owner save and release after a Redis claim is reclaimed', async () => {
    const backend = redisBackend(client);
    const store = createIdempotencyStore({ backend, ttlSeconds: 3600 });
    const key = 'stale_redis_owner_abcd';
    const payload = { a: 1 };
    const stale = await store.check({ principal: 'p', key, payload });
    assert.equal(stale.kind, 'miss');
    await backend.delete(`p\u001f${key}`);
    const current = await store.check({ principal: 'p', key, payload });
    assert.equal(current.kind, 'miss');

    await assert.rejects(
      store.save({
        principal: 'p',
        key,
        payloadHash: stale.payloadHash,
        claimToken: stale.claimToken,
        response: 'stale',
      }),
      /claim is no longer owned/
    );
    await assert.rejects(
      store.release({ principal: 'p', key, claimToken: stale.claimToken }),
      /claim is no longer owned/
    );
    await store.save({
      principal: 'p',
      key,
      payloadHash: current.payloadHash,
      claimToken: current.claimToken,
      response: 'current',
    });
    assert.equal((await store.check({ principal: 'p', key, payload })).response, 'current');
  });

  test('store returns expired when expires_at is past TTL + skew (grace window keeps key visible)', async () => {
    // Backend default grace (120s) keeps the value present after expiresAt,
    // so the store layer can detect `expired` rather than collapsing to `miss`.
    const backend = redisBackend(client);
    const store = createIdempotencyStore({ backend, ttlSeconds: 3600, clockSkewSeconds: 60 });

    // Write directly with a past expiresAt but a future Redis TTL so the
    // store sees the value and applies its own skew check.
    await client.set(
      'adcp:idem:pexp',
      JSON.stringify({ payloadHash: 'h', response: {}, expiresAt: Math.floor(Date.now() / 1000) - 120 }),
      { EX: 60 }
    );

    const result = await store.check({ principal: 'p', key: 'exp', payload: {} });
    assert.equal(result.kind, 'expired');
  });

  // ────────── unicode / nested edge cases ──────────

  test('round-trips nested structures and unicode', async () => {
    const backend = redisBackend(client);
    const response = {
      media_buy_id: 'mb_日本',
      packages: [
        { name: 'café', price: 5000.5 },
        { name: 'tag\\with\\slashes', nested: { deep: ['a', 'b', null] } },
      ],
    };
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await backend.put('pjson', { payloadHash: 'h', response, expiresAt });
    const got = await backend.get('pjson');
    assert.deepEqual(got.response, response);
  });
});
