// Runnable tests backing the composeMethod testing recipe at
// docs/recipes/composeMethod-testing.md.
//
// Each test corresponds 1-to-1 with a pattern in that doc. If a snippet there
// diverges from this file, this file is authoritative.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { composeMethod, requireAdvertiserMatch, PermissionDeniedError } = require('../dist/lib/server');

describe('composeMethod recipes (#1345)', () => {
  describe('Pattern 1 — mock the base, assert pass-through', () => {
    it('calls inner exactly once and returns its result unmodified', async () => {
      const inner = async (params, ctx) => ({ count: params.limit, region: ctx.region });
      let innerCalls = 0;
      const tracked = async (params, ctx) => {
        innerCalls++;
        return inner(params, ctx);
      };

      const wrapped = composeMethod(tracked, {});
      const result = await wrapped({ limit: 5 }, { region: 'us-east-1' });

      assert.strictEqual(innerCalls, 1, 'inner called exactly once');
      assert.deepStrictEqual(result, { count: 5, region: 'us-east-1' });
    });
  });

  describe('Pattern 2 — short-circuit from a before hook', () => {
    it('skips inner when before returns { shortCircuit: value }', async () => {
      let innerCalled = false;
      const inner = async () => {
        innerCalled = true;
        return { from: 'inner' };
      };
      const cached = { from: 'cache' };

      const wrapped = composeMethod(inner, {
        before: async params => (params.cached ? { shortCircuit: cached } : undefined),
      });

      // Cache hit — inner must be skipped
      innerCalled = false;
      const hit = await wrapped({ cached: true }, {});
      assert.strictEqual(innerCalled, false, 'inner must not run on cache hit');
      assert.deepStrictEqual(hit, { from: 'cache' });

      // Cache miss — inner must run
      innerCalled = false;
      const miss = await wrapped({ cached: false }, {});
      assert.strictEqual(innerCalled, true);
      assert.deepStrictEqual(miss, { from: 'inner' });
    });

    it('bare undefined return is a fall-through, not a short-circuit', async () => {
      let innerCalled = false;
      const inner = async () => {
        innerCalled = true;
        return 'inner-value';
      };

      const wrong = composeMethod(inner, { before: async () => undefined });
      innerCalled = false;
      await wrong({}, {});
      assert.strictEqual(innerCalled, true, 'undefined return must fall through to inner');
    });

    it('{ shortCircuit: undefined } short-circuits with undefined result', async () => {
      let innerCalled = false;
      const inner = async () => {
        innerCalled = true;
        return 'inner-value';
      };

      const right = composeMethod(inner, { before: async () => ({ shortCircuit: undefined }) });
      innerCalled = false;
      const result = await right({}, {});
      assert.strictEqual(innerCalled, false, 'inner must not run');
      assert.strictEqual(result, undefined);
    });
  });

  describe('Pattern 3 — layering two composeMethod calls', () => {
    it('outer before fires first; inner before only fires when outer falls through', async () => {
      const inner = async () => ({ ok: true });
      const log = [];

      const withB = composeMethod(inner, {
        before: async params => {
          log.push('B');
          return params.blockB ? { shortCircuit: { blocked: 'B' } } : undefined;
        },
      });
      const withAB = composeMethod(withB, {
        before: async params => {
          log.push('A');
          return params.blockA ? { shortCircuit: { blocked: 'A' } } : undefined;
        },
      });

      // A short-circuits — B never runs
      log.length = 0;
      const ra = await withAB({ blockA: true, blockB: false }, {});
      assert.deepStrictEqual(log, ['A'], 'B must not run when A short-circuits');
      assert.deepStrictEqual(ra, { blocked: 'A' });

      // A falls through — B short-circuits
      log.length = 0;
      const rb = await withAB({ blockA: false, blockB: true }, {});
      assert.deepStrictEqual(log, ['A', 'B']);
      assert.deepStrictEqual(rb, { blocked: 'B' });

      // Both fall through — inner runs
      log.length = 0;
      const rc = await withAB({ blockA: false, blockB: false }, {});
      assert.deepStrictEqual(log, ['A', 'B']);
      assert.deepStrictEqual(rc, { ok: true });
    });
  });

  describe('Pattern 4 — after hook enrichment', () => {
    it('after receives (result, params, ctx) and its return value reaches the caller', async () => {
      const inner = async () => ({ products: [{ id: 'p1', price_cpm: 5.0 }] });

      const wrapped = composeMethod(inner, {
        after: async (result, params, ctx) => ({
          ...result,
          ext: { enriched_by: ctx.region, count: result.products.length },
        }),
      });

      const result = await wrapped({ filter: 'active' }, { region: 'eu-west-1' });
      assert.deepStrictEqual(result.products, [{ id: 'p1', price_cpm: 5.0 }]);
      assert.deepStrictEqual(result.ext, { enriched_by: 'eu-west-1', count: 1 });
    });

    it('after also runs on short-circuit values from before', async () => {
      const inner = async () => ({ products: ['from-inner'] });

      const wrapped = composeMethod(inner, {
        before: async () => ({ shortCircuit: { products: [] } }),
        after: async result => ({ ...result, ext: { from: 'after' } }),
      });
      const r = await wrapped({}, {});
      assert.deepStrictEqual(r.ext, { from: 'after' }, 'after must run on short-circuit values');
    });
  });

  describe('Pattern 5 — composeMethod + typed errors', () => {
    it('typed error from inner propagates to caller', async () => {
      const inner = async params => {
        if (!params.account_id) throw new PermissionDeniedError('accounts.resolve');
        return { account_id: params.account_id };
      };
      const wrapped = composeMethod(inner, {});

      await assert.rejects(
        () => wrapped({}, {}),
        err => {
          assert.ok(err instanceof PermissionDeniedError);
          assert.strictEqual(err.code, 'PERMISSION_DENIED');
          return true;
        }
      );
      assert.deepStrictEqual(await wrapped({ account_id: 'acc_1' }, {}), { account_id: 'acc_1' });
    });

    it('typed error from a before hook propagates to caller', async () => {
      const inner2 = async () => ({ account_id: 'acc_1' });

      const wrapped2 = composeMethod(inner2, {
        before: async (_params, ctx) => {
          if (!ctx.authorized) throw new PermissionDeniedError('before-hook');
        },
      });

      await assert.rejects(() => wrapped2({}, { authorized: false }), PermissionDeniedError);
      const ok = await wrapped2({}, { authorized: true });
      assert.ok(ok !== null);
    });
  });

  describe('Pattern 6 — requireAdvertiserMatch with composeMethod', () => {
    const baseResolve = async (ref, _ctx) => ({
      account_id: ref?.account_id ?? 'acc_1',
      advertiser: 'brand_A',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    });

    it('allowed advertiser resolves', async () => {
      const guarded = composeMethod(
        baseResolve,
        requireAdvertiserMatch(async ctx => ctx?.allowedAdvertisers ?? [])
      );

      const allowed = await guarded({ account_id: 'acc_1' }, { allowedAdvertisers: ['brand_A'] });
      assert.ok(allowed !== null);
      assert.strictEqual(allowed.advertiser, 'brand_A');
    });

    it('disallowed advertiser resolves to null (silent deny)', async () => {
      const guarded = composeMethod(
        baseResolve,
        requireAdvertiserMatch(async ctx => ctx?.allowedAdvertisers ?? [])
      );

      const denied = await guarded({ account_id: 'acc_1' }, { allowedAdvertisers: ['brand_B'] });
      assert.strictEqual(denied, null);
    });

    it('null inner result propagates without running the predicate', async () => {
      const baseNull = async () => null;
      const guardedNull = composeMethod(
        baseNull,
        requireAdvertiserMatch(async () => ['brand_A'])
      );
      assert.strictEqual(await guardedNull({}, {}), null);
    });
  });

  describe('Pattern 7 — variadic composeMethod (hook-chain sugar)', () => {
    it('three hooks: before runs A→B→C, after runs C→B→A', async () => {
      const beforeLog = [];
      const afterLog = [];
      const inner = async () => ({ ok: true });

      const hookA = {
        before: async () => {
          beforeLog.push('A');
        },
        after: async result => {
          afterLog.push('A');
          return result;
        },
      };
      const hookB = {
        before: async () => {
          beforeLog.push('B');
        },
        after: async result => {
          afterLog.push('B');
          return result;
        },
      };
      const hookC = {
        before: async () => {
          beforeLog.push('C');
        },
        after: async result => {
          afterLog.push('C');
          return result;
        },
      };

      const wrapped = composeMethod(inner, hookA, hookB, hookC);
      const result = await wrapped({}, {});

      assert.deepStrictEqual(beforeLog, ['A', 'B', 'C'], 'before: A first, C last');
      assert.deepStrictEqual(afterLog, ['C', 'B', 'A'], 'after: C first, A last');
      assert.deepStrictEqual(result, { ok: true });
    });

    it('short-circuit from first hook: remaining befores and their afters are skipped', async () => {
      const log = [];
      const inner = async () => {
        log.push('inner');
        return { from: 'inner' };
      };

      const hookA = {
        before: async () => {
          log.push('A-before');
          return { shortCircuit: { blocked: 'A' } };
        },
        after: async result => {
          log.push('A-after');
          return result;
        },
      };
      const hookB = {
        before: async () => {
          log.push('B-before');
        },
        after: async result => {
          log.push('B-after');
          return result;
        },
      };
      const hookC = {
        before: async () => {
          log.push('C-before');
        },
        after: async result => {
          log.push('C-after');
          return result;
        },
      };

      const wrapped = composeMethod(inner, hookA, hookB, hookC);
      const result = await wrapped({}, {});

      // A short-circuits: wrappedBC never called, so B+C before+after all skipped.
      // Matches nesting equivalent: composeMethod(composeMethod(composeMethod(inner,C),B),A)
      assert.deepStrictEqual(log, ['A-before', 'A-after']);
      assert.deepStrictEqual(result, { blocked: 'A' });
    });

    it('short-circuit from middle hook: later befores+afters skipped, earlier afters still run', async () => {
      const log = [];
      const inner = async () => {
        log.push('inner');
        return { from: 'inner' };
      };

      const hookA = {
        before: async () => {
          log.push('A-before');
        },
        after: async result => {
          log.push('A-after');
          return result;
        },
      };
      const hookB = {
        before: async () => {
          log.push('B-before');
          return { shortCircuit: { blocked: 'B' } };
        },
        after: async result => {
          log.push('B-after');
          return result;
        },
      };
      const hookC = {
        before: async () => {
          log.push('C-before');
        },
        after: async result => {
          log.push('C-after');
          return result;
        },
      };

      const wrapped = composeMethod(inner, hookA, hookB, hookC);
      const result = await wrapped({}, {});

      // B short-circuits: C (inner of B) never called; B.after and A.after still run.
      assert.deepStrictEqual(log, ['A-before', 'B-before', 'B-after', 'A-after']);
      assert.deepStrictEqual(result, { blocked: 'B' });
    });

    it('variadic with one meaningful hook plus an empty no-op matches two-arg form', async () => {
      const inner = async params => ({ doubled: params.n * 2 });
      const hook = { after: async result => ({ ...result, tag: 'enriched' }) };

      const twoArg = composeMethod(inner, hook);
      // Explicitly exercises the variadic path (rest.length > 0) — empty {} is a no-op
      const variadic = composeMethod(inner, hook, {});

      const r1 = await twoArg({ n: 3 }, {});
      const r2 = await variadic({ n: 3 }, {});
      assert.deepStrictEqual(r1, r2);
    });

    it('empty {} hook in the array is a no-op at that position', async () => {
      const inner = async () => ({ value: 42 });
      const meaningful = { after: async result => ({ ...result, tag: 'enriched' }) };

      const wrapped = composeMethod(inner, {}, meaningful, {});
      const result = await wrapped({}, {});
      assert.deepStrictEqual(result, { value: 42, tag: 'enriched' });
    });

    it('non-function inner with variadic hooks throws TypeError', async () => {
      assert.throws(
        () => composeMethod(null, {}, {}),
        err => err instanceof TypeError && err.message.includes("'inner' must be a function")
      );
    });
  });
});
