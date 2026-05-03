# Testing `composeMethod`-wrapped handlers

`composeMethod` wraps a single platform method with optional `before` / `after` hooks. This
recipe shows how to write tests for handlers built with it, covering six patterns that adopters
reach for most often.

All snippets here are running tests in
[`test/server-decisioning-compose-recipes.test.js`](../../test/server-decisioning-compose-recipes.test.js).
If a snippet and the test ever diverge, the test is authoritative (the test runs in CI; the
snippet does not). To verify locally: `node --test test/server-decisioning-compose-recipes.test.js`
from the repo root after `npm run build:lib`.

**Not this guide:** `docs/guides/HANDLER-PATTERNS-GUIDE.md` covers buyer-side `InputHandler`
patterns. This guide is for _server-side_ `composeMethod` — a different primitive on a different
surface, with a different test runner (Node built-in `assert`, not Jest).

## Import

```typescript
import { composeMethod } from '@adcp/sdk/server';
import type { ComposeHooks, ComposeShortCircuit } from '@adcp/sdk/server';
```

---

## When to use which approach

| Situation | Recommendation |
|---|---|
| Single security gate matching one of the shipped presets exactly | Use the preset via `composeMethod` — see [Pattern 6](#pattern-6--requireadvertisermatch-with-composemethod) |
| Multiple gates to stack, no per-gate unit testing needed | Consider inlining; chained `composeMethod` nesting is harder to read than equivalent inline guards — see [Pattern 3](#pattern-3--layering-two-composemethod-calls) for the nesting form, [Pattern 7](#pattern-7--variadic-composemethod-hook-chain-sugar) for the variadic sugar |
| Single gate with policy nuances the preset doesn't express (e.g. public-account fallthrough) | Inline or use `requireAccountMatch` with a custom predicate; presets are for the canonical case |
| Per-gate testability or reuse across multiple platforms | `composeMethod` per gate — accept the nesting verbosity for the test coverage benefit |
| `onDeny: 'throw'` needed on a guard | Use the preset with `{ onDeny: 'throw' }` — note that a throwing outer guard bypasses inner guards, making evaluation order load-bearing |

**`requireOrgScope` gotcha:** `requireOrgScope` uses strict equality and denies when _either_ `getAccountOrg` **or** `getCtxOrg` returns `undefined`. An account without an org field is **denied**, not treated as publicly accessible. For a public-account convention (accounts without an org scope are open to any authenticated buyer), use `requireAccountMatch` with a custom predicate instead:

```ts
import { composeMethod, requireAccountMatch } from '@adcp/sdk/server';

accounts: {
  resolve: composeMethod(
    baseResolve,
    requireAccountMatch((account, ctx) => {
      // Replace with your account's org field — e.g. account.ctx_metadata?.orgId
      const accountOrg = account.ctx_metadata?.orgScope;
      if (!accountOrg) return true; // no org scope → publicly accessible
      const ctxOrg = ctx?.authInfo?.extra?.orgId as string | undefined;
      return ctxOrg === accountOrg;
    })
  ),
}
```

---

## Pattern 1 — Mock the base, assert pass-through

When neither hook fires the wrapped method is a transparent proxy. Track calls on the inner
function with a simple counter — no mocking library needed.

```javascript
const inner = async (params, ctx) => ({ count: params.limit, region: ctx.region });
let innerCalls = 0;
const tracked = async (params, ctx) => { innerCalls++; return inner(params, ctx); };

const wrapped = composeMethod(tracked, {});
const result = await wrapped({ limit: 5 }, { region: 'us-east-1' });

assert.strictEqual(innerCalls, 1, 'inner called exactly once');
assert.deepStrictEqual(result, { count: 5, region: 'us-east-1' });
```

---

## Pattern 2 — Short-circuit from a `before` hook

A `before` hook returning `{ shortCircuit: value }` prevents `inner` from running. The
short-circuit value flows through `after` (if any) and back to the caller.

```javascript
let innerCalled = false;
const inner = async () => { innerCalled = true; return { from: 'inner' }; };
const cached = { from: 'cache' };

const wrapped = composeMethod(inner, {
  before: async (params) => params.cached ? { shortCircuit: cached } : undefined,
});

// Cache hit — inner must be skipped
innerCalled = false;
const hit = await wrapped({ cached: true }, {});
assert.strictEqual(innerCalled, false, 'inner must not run on cache hit');
assert.deepStrictEqual(hit, { from: 'cache' });

// Cache miss — inner must run
const miss = await wrapped({ cached: false }, {});
assert.strictEqual(innerCalled, true);
assert.deepStrictEqual(miss, { from: 'inner' });
```

**Gotcha — bare `undefined` is a fall-through, not a short-circuit.** Only the discriminated
wrapper `{ shortCircuit: value }` signals early exit. A `before` hook that returns `undefined`
(or nothing) always falls through to `inner`, even when the intended short-circuit value is
itself `undefined`. To short-circuit with an undefined result, return `{ shortCircuit: undefined }`.

```javascript
// Wrong: this is a fall-through
const wrong = composeMethod(inner, { before: async () => undefined });

// Right: this short-circuits with undefined as the result
const right = composeMethod(inner, { before: async () => ({ shortCircuit: undefined }) });
```

---

## Pattern 3 — Layering two `composeMethod` calls

`before` accepts a single function, not an array. To compose independent guards, nest
`composeMethod` calls. The outer `before` runs first; if it falls through, the inner `before`
runs. This is how the `requireAdvertiserMatch` / `requireOrgScope` presets are designed to be
composed. For three or more guards, [Pattern 7](#pattern-7--variadic-composemethod-hook-chain-sugar) provides sugar over this nesting.

```javascript
const inner = async () => ({ ok: true });
const log = [];

// Guard B is closer to inner; Guard A is the outer wrapper
const withB = composeMethod(inner, {
  before: async (params) => {
    log.push('B');
    return params.blockB ? { shortCircuit: { blocked: 'B' } } : undefined;
  },
});
const withAB = composeMethod(withB, {
  before: async (params) => {
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
```

---

## Pattern 4 — `after` hook enrichment

`after` receives `(result, params, ctx)` and must return the (possibly modified) result. Assert
both that the hook saw the right inner response and that its enrichment arrived at the caller.

```javascript
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
```

**Note on placement:** `after` runs before response-schema validation. Fields added outside
`ext` may fail schema validation — keep vendor-specific enrichment under `ext.*` (the spec's
typed extension surface).

`after` also runs on short-circuit values from `before`:

```javascript
const inner2 = async () => ({ products: ['from-inner'] });
const wrapped2 = composeMethod(inner2, {
  before: async () => ({ shortCircuit: { products: [] } }),
  after: async (result) => ({ ...result, ext: { from: 'after' } }),
});
const r = await wrapped2({}, {});
assert.deepStrictEqual(r.ext, { from: 'after' }, 'after runs on short-circuit values too');
```

---

## Pattern 5 — `composeMethod` + typed errors

`composeMethod` does not catch errors — typed errors thrown from `inner`, `before`, or `after`
propagate to the caller. This is by design: the AdCP framework translates `AdcpError` subclasses
to structured wire errors before they reach the buyer.

```javascript
const { PermissionDeniedError } = require('@adcp/sdk/server');

// Error thrown from inner propagates
const inner = async (params) => {
  if (!params.account_id) throw new PermissionDeniedError('accounts.resolve');
  return { account_id: params.account_id };
};
const wrapped = composeMethod(inner, {});

await assert.rejects(
  () => wrapped({}, {}),
  (err) => {
    assert.ok(err instanceof PermissionDeniedError);
    assert.strictEqual(err.code, 'PERMISSION_DENIED');
    return true;
  }
);
assert.deepStrictEqual(await wrapped({ account_id: 'acc_1' }, {}), { account_id: 'acc_1' });
```

A `before` hook may also throw instead of returning `{ shortCircuit: null }` when you want the
buyer to receive a typed wire error rather than a silent null. Use `{ shortCircuit: null }` to
look like "not found"; use `throw new PermissionDeniedError(...)` when the buyer is already
known to be authorized to know the account exists:

```javascript
const { PermissionDeniedError } = require('@adcp/sdk/server');
const inner2 = async () => ({ account_id: 'acc_1' });

const wrapped2 = composeMethod(inner2, {
  before: async (_params, ctx) => {
    if (!ctx.authorized) throw new PermissionDeniedError('before-hook');
  },
});

await assert.rejects(
  () => wrapped2({}, { authorized: false }),
  PermissionDeniedError
);
const ok = await wrapped2({}, { authorized: true });
assert.ok(ok !== null);
```

---

## Pattern 6 — `requireAdvertiserMatch` with `composeMethod`

The presets shipped in `@adcp/sdk/server` (`requireAccountMatch`, `requireAdvertiserMatch`,
`requireOrgScope`) are pre-built `ComposeHooks` objects for `accounts.resolve`. See [When to use which approach](#when-to-use-which-approach) for guidance on when a preset fits vs. when to inline. Each returns an
`after` hook that runs _after_ the inner resolver; a null inner result propagates unconditionally
(no predicate runs on a "not found" account). The snippet below uses `requireAdvertiserMatch`;
`requireAccountMatch` (general predicate) and `requireOrgScope` (org equality check) follow the
same shape — pass the result of any of them directly as the second argument to `composeMethod`.

```javascript
const { composeMethod, requireAdvertiserMatch } = require('@adcp/sdk/server');

const baseResolve = async (ref, _ctx) => ({
  account_id: ref?.account_id ?? 'acc_1',
  advertiser: 'brand_A',
  ctx_metadata: {},
  authInfo: { kind: 'api_key' },
});

const guarded = composeMethod(baseResolve, requireAdvertiserMatch(
  async (ctx) => ctx?.allowedAdvertisers ?? []
));

// Allowed advertiser — resolves
const allowed = await guarded(
  { account_id: 'acc_1' },
  { allowedAdvertisers: ['brand_A'] }
);
assert.ok(allowed !== null);
assert.strictEqual(allowed.advertiser, 'brand_A');

// Disallowed advertiser — silent null (avoids principal enumeration)
const denied = await guarded(
  { account_id: 'acc_1' },
  { allowedAdvertisers: ['brand_B'] }
);
assert.strictEqual(denied, null);

// Inner returns null (account not found) — propagates, predicate skipped
const baseNull = async () => null;
const guardedNull = composeMethod(baseNull, requireAdvertiserMatch(
  async () => ['brand_A']
));
assert.strictEqual(await guardedNull({}, {}), null);
```

The full preset API is documented in the JSDoc of `src/lib/server/decisioning/resolve-presets.ts`.

---

## Pattern 7 — Variadic `composeMethod` (hook-chain sugar)

When stacking three or more independent guards, the nested `composeMethod` calls become
hard to read. Pass multiple hooks as separate arguments instead — `composeMethod` chains
them internally, producing the same result as manual nesting.

```ts
// Equivalent forms:
composeMethod(inner, hookA, hookB, hookC)
composeMethod(composeMethod(composeMethod(inner, hookC), hookB), hookA)
```

**Execution order:** `before` hooks run left-to-right (A first, C last). `after` hooks run
right-to-left (C first, A last). A short-circuit from a `before` hook skips remaining
`before` hooks and their corresponding `after` hooks (the inner wrappers that were never
entered). `after` hooks for wrappers that _were_ entered (the short-circuiting hook itself
and any outer hooks) still run.

```javascript
const { composeMethod } = require('@adcp/sdk/server');

const inner = async () => ({ ok: true });

const authGate = {
  before: async (_params, ctx) =>
    ctx.token ? undefined : { shortCircuit: null },
};
const synthGate = {
  before: async (params) =>
    params.account_id?.startsWith('synthetic_') ? { shortCircuit: null } : undefined,
};
const orgGate = {
  before: async (params, ctx) =>
    ctx.orgId === params.expected_org ? undefined : { shortCircuit: null },
  after: async (result) => result && { ...result, org_checked: true },
};

// Sugar: authGate before runs first, orgGate before runs last.
// orgGate after runs first (closest to inner), authGate after runs last.
const guarded = composeMethod(inner, authGate, synthGate, orgGate);

// All gates pass — inner result, enriched by orgGate.after
const ok = await guarded({ account_id: 'acc_1', expected_org: 'org_A' }, { token: 'tok', orgId: 'org_A' });
assert.deepStrictEqual(ok, { ok: true, org_checked: true });

// authGate short-circuits — synthGate and orgGate before skipped;
// orgGate.after and synthGate.after still run (none here), authGate.after not present
const denied = await guarded({ account_id: 'acc_1', expected_org: 'org_A' }, { token: null, orgId: 'org_A' });
assert.strictEqual(denied, null);
```

When each gate needs its own unit tests or is reused across multiple platform methods, the
two-argument form with manual nesting (Pattern 3) keeps the test surface cleaner. Use the
variadic form when you're stacking gates inline and don't need per-gate isolation.
