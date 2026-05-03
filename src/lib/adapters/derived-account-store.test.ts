import { describe, it, expect } from 'vitest';
import { createDerivedAccountStore } from './derived-account-store';
import type { ResolvedAuthInfo, ResolveContext } from '../server/decisioning/account';

const apiKeyAuthInfo: ResolvedAuthInfo = {
  token: 'sk-test-key',
  credential: { kind: 'api_key', key_id: 'key_abc' },
};

function makeCtx(authInfo?: ResolvedAuthInfo): ResolveContext {
  return { authInfo, toolName: 'list_creative_formats' };
}

describe('createDerivedAccountStore', () => {
  it('sets resolution to derived', () => {
    const store = createDerivedAccountStore({
      toAccount: () => ({ id: 'x', name: 'X', status: 'active', ctx_metadata: {} }),
    });
    expect(store.resolution).toBe('derived');
  });

  it('calls toAccount with verified authInfo and returns the result', async () => {
    const store = createDerivedAccountStore({
      toAccount: (authInfo, _ctx) => {
        const cred = authInfo.credential;
        const keyId = cred?.kind === 'api_key' ? cred.key_id : 'unknown';
        return { id: `key:${keyId}`, name: 'Audiostack', status: 'active', ctx_metadata: {} };
      },
    });

    const ctx = makeCtx(apiKeyAuthInfo);
    const account = await store.resolve(undefined, ctx);
    expect(account).not.toBeNull();
    expect(account!.id).toBe('key:key_abc');
    expect(account!.name).toBe('Audiostack');
  });

  it('returns null when ctx is absent', async () => {
    const store = createDerivedAccountStore({
      toAccount: () => ({ id: 'x', name: 'X', status: 'active', ctx_metadata: {} }),
    });
    expect(await store.resolve(undefined, undefined)).toBeNull();
  });

  it('returns null when authInfo is absent', async () => {
    const store = createDerivedAccountStore({
      toAccount: () => ({ id: 'x', name: 'X', status: 'active', ctx_metadata: {} }),
    });
    expect(await store.resolve(undefined, makeCtx(undefined))).toBeNull();
  });

  it('ignores buyer-supplied AccountReference — single-tenant', async () => {
    const store = createDerivedAccountStore({
      toAccount: () => ({ id: 'singleton', name: 'Singleton', status: 'active', ctx_metadata: {} }),
    });

    const ctx = makeCtx(apiKeyAuthInfo);
    const withRef = await store.resolve(
      { account_id: 'buyer-supplied-id' } as Parameters<typeof store.resolve>[0],
      ctx
    );
    const withoutRef = await store.resolve(undefined, ctx);

    expect(withRef!.id).toBe('singleton');
    expect(withoutRef!.id).toBe('singleton');
  });

  it('supports async toAccount', async () => {
    const store = createDerivedAccountStore({
      toAccount: async (_authInfo, _ctx) => {
        await Promise.resolve();
        return { id: 'async', name: 'Async', status: 'active', ctx_metadata: {} };
      },
    });

    const account = await store.resolve(undefined, makeCtx(apiKeyAuthInfo));
    expect(account!.id).toBe('async');
  });

  it('omits list and upsert', () => {
    const store = createDerivedAccountStore({
      toAccount: () => ({ id: 'x', name: 'X', status: 'active', ctx_metadata: {} }),
    });
    expect(store.list).toBeUndefined();
    expect(store.upsert).toBeUndefined();
  });

  it('passes ctx to toAccount so adopters can read toolName etc.', async () => {
    let capturedCtx: ResolveContext | undefined;
    const store = createDerivedAccountStore({
      toAccount: (_authInfo, ctx) => {
        capturedCtx = ctx;
        return { id: 'x', name: 'X', status: 'active', ctx_metadata: {} };
      },
    });

    const ctx = makeCtx(apiKeyAuthInfo);
    await store.resolve(undefined, ctx);
    expect(capturedCtx?.toolName).toBe('list_creative_formats');
  });
});
