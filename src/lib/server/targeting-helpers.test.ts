import { describe, it, expect } from 'vitest';
import {
  createResolvedListCache,
  matchesPropertyList,
  matchesCollectionList,
  resolveCollectionList,
  resolvePropertyList,
  type ResolvedPropertyList,
  type ResolvedCollectionList,
  type ResolveListCallTool,
} from './targeting-helpers';

describe('matchesPropertyList', () => {
  const list: ResolvedPropertyList = {
    listId: 'test-list',
    agentUrl: 'https://list.example',
    identifiers: [
      { type: 'domain', value: 'acmeoutdoor.example' },
      { type: 'domain', value: '*.sports.example' },
      { type: 'ios_bundle', value: 'com.acme.outdoor' },
    ],
  };

  it('matches exact domain', () => {
    expect(matchesPropertyList({ type: 'domain', value: 'acmeoutdoor.example' }, list)).toBe(true);
  });

  it('matches www. alias of base domain', () => {
    expect(matchesPropertyList({ type: 'domain', value: 'www.acmeoutdoor.example' }, list)).toBe(true);
  });

  it('matches m. alias of base domain', () => {
    expect(matchesPropertyList({ type: 'domain', value: 'm.acmeoutdoor.example' }, list)).toBe(true);
  });

  it('does not match unrelated subdomain of base entry', () => {
    expect(matchesPropertyList({ type: 'domain', value: 'blog.acmeoutdoor.example' }, list)).toBe(false);
  });

  it('wildcard matches any subdomain', () => {
    expect(matchesPropertyList({ type: 'domain', value: 'nfl.sports.example' }, list)).toBe(true);
    expect(matchesPropertyList({ type: 'domain', value: 'nba.sports.example' }, list)).toBe(true);
  });

  it('wildcard does NOT match base domain', () => {
    expect(matchesPropertyList({ type: 'domain', value: 'sports.example' }, list)).toBe(false);
  });

  it('non-domain identifiers use exact match', () => {
    expect(matchesPropertyList({ type: 'ios_bundle', value: 'com.acme.outdoor' }, list)).toBe(true);
    expect(matchesPropertyList({ type: 'ios_bundle', value: 'com.acme.other' }, list)).toBe(false);
  });

  it('returns false when identifier type differs', () => {
    expect(matchesPropertyList({ type: 'ios_bundle', value: 'acmeoutdoor.example' }, list)).toBe(false);
  });

  it('empty list matches nothing', () => {
    const empty: ResolvedPropertyList = { listId: 'e', agentUrl: 'x', identifiers: [] };
    expect(matchesPropertyList({ type: 'domain', value: 'acmeoutdoor.example' }, empty)).toBe(false);
  });
});

describe('matchesCollectionList', () => {
  const list: ResolvedCollectionList = {
    listId: 'test-collections',
    agentUrl: 'https://list.example',
    collections: [
      {
        collection_rid: 'rid:outdoor:trail_life',
        name: 'Trail Life',
        distribution_ids: [{ type: 'imdb_id', value: 'tt9100001' }],
      },
      {
        name: 'Summit Stories',
        distribution_ids: [
          { type: 'imdb_id', value: 'tt9100002' },
          { type: 'gracenote_id', value: 'SH_SUMMIT' },
        ],
      },
    ],
  };

  it('matches when collection_rid is equal on both sides', () => {
    expect(matchesCollectionList({ collection_rid: 'rid:outdoor:trail_life' }, list)).toBe(true);
  });

  it('matches when any distribution_id overlaps', () => {
    expect(matchesCollectionList({ distribution_ids: [{ type: 'gracenote_id', value: 'SH_SUMMIT' }] }, list)).toBe(
      true
    );
  });

  it('does not match when distribution_id type is same but value differs', () => {
    expect(matchesCollectionList({ distribution_ids: [{ type: 'imdb_id', value: 'tt_other' }] }, list)).toBe(false);
  });

  it('does not match when distribution_id value matches but type differs', () => {
    expect(matchesCollectionList({ distribution_ids: [{ type: 'gracenote_id', value: 'tt9100001' }] }, list)).toBe(
      false
    );
  });

  it('does not match when candidate has neither rid nor distribution_ids', () => {
    expect(matchesCollectionList({}, list)).toBe(false);
  });

  it('does not match when list entry lacks distribution_ids and rids differ', () => {
    const candidate = { collection_rid: 'rid:other' };
    expect(matchesCollectionList(candidate, list)).toBe(false);
  });
});

describe('resolvePropertyList cache', () => {
  const now = () => new Date('2026-06-02T12:00:00.000Z');
  const future = '2026-06-02T12:05:00.000Z';

  it('caches resolved identifiers until cache_valid_until and returns cloned values', async () => {
    const cache = createResolvedListCache();
    const calls: unknown[][] = [];
    const callTool: ResolveListCallTool = async (...args) => {
      calls.push(args);
      return {
        list: { list_id: 'pl-1', name: 'Allow list' },
        identifiers: [{ type: 'domain', value: `site-${calls.length}.example` }],
        cache_valid_until: future,
      };
    };

    const ref = { agent_url: 'https://lists.example/mcp', list_id: 'pl-1', auth_token: 'token-a' };
    const first = await resolvePropertyList(ref, { cache, now, callTool });
    first.identifiers[0]!.value = 'mutated.example';
    const second = await resolvePropertyList(ref, { cache, now, callTool });

    expect(calls).toHaveLength(1);
    expect(second.identifiers).toEqual([{ type: 'domain', value: 'site-1.example' }]);
  });

  it('scopes cache entries by auth token fingerprint', async () => {
    const cache = createResolvedListCache();
    const calls: unknown[][] = [];
    const callTool: ResolveListCallTool = async (...args) => {
      calls.push(args);
      return {
        list: { list_id: 'pl-1', name: 'Allow list' },
        identifiers: [{ type: 'domain', value: `site-${calls.length}.example` }],
        cache_valid_until: future,
      };
    };

    await resolvePropertyList({ agent_url: 'https://lists.example/mcp', list_id: 'pl-1', auth_token: 'token-a' }, {
      cache,
      now,
      callTool,
    });
    await resolvePropertyList({ agent_url: 'https://lists.example/mcp', list_id: 'pl-1', auth_token: 'token-b' }, {
      cache,
      now,
      callTool,
    });

    expect(calls).toHaveLength(2);
  });

  it('does not cache shared entries without auth token or cache scope', async () => {
    const cache = createResolvedListCache();
    const calls: unknown[][] = [];
    const callTool: ResolveListCallTool = async (...args) => {
      calls.push(args);
      return {
        list: { list_id: 'pl-1', name: 'Allow list' },
        identifiers: [{ type: 'domain', value: `site-${calls.length}.example` }],
        cache_valid_until: future,
      };
    };

    const ref = { agent_url: 'https://lists.example/mcp', list_id: 'pl-1' };
    await resolvePropertyList(ref, { cache, now, callTool });
    const second = await resolvePropertyList(ref, { cache, now, callTool });

    expect(calls).toHaveLength(2);
    expect(second.identifiers).toEqual([{ type: 'domain', value: 'site-2.example' }]);
  });

  it('uses cacheScopeKey to scope anonymous cache entries', async () => {
    const cache = createResolvedListCache();
    const calls: unknown[][] = [];
    const callTool: ResolveListCallTool = async (...args) => {
      calls.push(args);
      return {
        list: { list_id: 'pl-1', name: 'Allow list' },
        identifiers: [{ type: 'domain', value: `site-${calls.length}.example` }],
        cache_valid_until: future,
      };
    };

    const ref = { agent_url: 'https://lists.example/mcp', list_id: 'pl-1' };
    const first = await resolvePropertyList(ref, { cache, now, callTool, cacheScopeKey: 'tenant-a' });
    const second = await resolvePropertyList(ref, { cache, now, callTool, cacheScopeKey: 'tenant-a' });
    const third = await resolvePropertyList(ref, { cache, now, callTool, cacheScopeKey: 'tenant-b' });

    expect(calls).toHaveLength(2);
    expect(second.identifiers).toEqual(first.identifiers);
    expect(third.identifiers).toEqual([{ type: 'domain', value: 'site-2.example' }]);
  });

  it('returns cached property lists before default network DNS validation', async () => {
    const cache = createResolvedListCache();
    const ref = { agent_url: 'https://lists.example.invalid/mcp', list_id: 'pl-1', auth_token: 'token-a' };
    await resolvePropertyList(ref, {
      cache,
      now,
      callTool: async () => ({
        list: { list_id: 'pl-1', name: 'Allow list' },
        identifiers: [{ type: 'domain', value: 'cached.example' }],
        cache_valid_until: future,
      }),
    });

    const cached = await resolvePropertyList(ref, { cache, now });

    expect(cached.identifiers).toEqual([{ type: 'domain', value: 'cached.example' }]);
  });

  it('bypasses the process-global cache when a custom callTool is supplied without an explicit cache', async () => {
    const ref = { agent_url: 'https://lists.example/mcp', list_id: 'pl-1', auth_token: 'token-a' };
    const first = await resolvePropertyList(ref, {
      now,
      callTool: async () => ({
        list: { list_id: 'pl-1', name: 'Allow list' },
        identifiers: [{ type: 'domain', value: 'a.example' }],
        cache_valid_until: future,
      }),
    });
    const second = await resolvePropertyList(ref, {
      now,
      callTool: async () => ({
        list: { list_id: 'pl-1', name: 'Allow list' },
        identifiers: [{ type: 'domain', value: 'b.example' }],
        cache_valid_until: future,
      }),
    });

    expect(first.identifiers).toEqual([{ type: 'domain', value: 'a.example' }]);
    expect(second.identifiers).toEqual([{ type: 'domain', value: 'b.example' }]);
  });

  it('validates property list agent URLs before calling the resolver target', async () => {
    const calls: unknown[][] = [];
    const callTool: ResolveListCallTool = async (...args) => {
      calls.push(args);
      return { list: { list_id: 'pl-1', name: 'Allow list' }, identifiers: [] };
    };

    await expect(resolvePropertyList({ agent_url: 'file:///tmp/list', list_id: 'pl-1' }, { callTool })).rejects.toThrow(
      /list_agent_url_insecure/
    );
    await expect(
      resolvePropertyList({ agent_url: 'https://user:pass@lists.example/mcp?token=secret', list_id: 'pl-1' }, { callTool })
    ).rejects.toThrow(/list_agent_url_malformed/);
    expect(calls).toHaveLength(0);
  });

  it('refreshes expired cache entries', async () => {
    const cache = createResolvedListCache();
    const calls: unknown[][] = [];
    const callTool: ResolveListCallTool = async (...args) => {
      calls.push(args);
      return {
        list: { list_id: 'pl-1', name: 'Allow list' },
        identifiers: [{ type: 'domain', value: `site-${calls.length}.example` }],
        cache_valid_until: '2026-06-02T12:01:00.000Z',
      };
    };

    const ref = { agent_url: 'https://lists.example/mcp', list_id: 'pl-1', auth_token: 'token-a' };
    await resolvePropertyList(ref, { cache, now, callTool });
    const refreshed = await resolvePropertyList(ref, {
      cache,
      now: () => new Date('2026-06-02T12:02:00.000Z'),
      callTool,
    });

    expect(calls).toHaveLength(2);
    expect(refreshed.identifiers).toEqual([{ type: 'domain', value: 'site-2.example' }]);
  });

  it('walks pagination before caching a resolved property list', async () => {
    const cache = createResolvedListCache();
    const calls: Array<{ args: Record<string, unknown> }> = [];
    const callTool: ResolveListCallTool = async (_agentUrl, _toolName, args) => {
      calls.push({ args });
      const pagination = args.pagination as { cursor?: string } | undefined;
      if (!pagination?.cursor) {
        return {
          list: { list_id: 'pl-1', name: 'Allow list' },
          identifiers: [{ type: 'domain', value: 'first.example' }],
          pagination: { has_more: true, cursor: 'page-2' },
          cache_valid_until: future,
        };
      }
      return {
        list: { list_id: 'pl-1', name: 'Allow list' },
        identifiers: [{ type: 'domain', value: 'second.example' }],
        pagination: { has_more: false },
        cache_valid_until: future,
      };
    };

    const ref = { agent_url: 'https://lists.example/mcp', list_id: 'pl-1', auth_token: 'token-a' };
    const resolved = await resolvePropertyList(ref, { cache, now, callTool, pageSize: 1 });
    const cached = await resolvePropertyList(ref, { cache, now, callTool, pageSize: 1 });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual({ list_id: 'pl-1', resolve: true, pagination: { max_results: 1 } });
    expect(calls[1]!.args).toEqual({
      list_id: 'pl-1',
      resolve: true,
      pagination: { max_results: 1, cursor: 'page-2' },
    });
    expect(resolved.identifiers).toEqual([
      { type: 'domain', value: 'first.example' },
      { type: 'domain', value: 'second.example' },
    ]);
    expect(cached.identifiers).toEqual(resolved.identifiers);
  });

  it('rejects property-list pagination cursors without has_more true', async () => {
    const callTool: ResolveListCallTool = async () => ({
      list: { list_id: 'pl-1', name: 'Allow list' },
      identifiers: [{ type: 'domain', value: 'first.example' }],
      pagination: { cursor: 'page-2' },
      cache_valid_until: future,
    });

    await expect(
      resolvePropertyList(
        { agent_url: 'https://lists.example/mcp', list_id: 'pl-1', auth_token: 'token-a' },
        { cache: createResolvedListCache(), now, callTool }
      )
    ).rejects.toThrow(/property_list_invalid_pagination/);
  });
});

describe('resolveCollectionList cache', () => {
  it('validates collection list agent URLs before calling the resolver target', async () => {
    const calls: unknown[][] = [];
    const callTool: ResolveListCallTool = async (...args) => {
      calls.push(args);
      return { list: { list_id: 'cl-1', name: 'Shows' }, collections: [] };
    };

    await expect(
      resolveCollectionList({ agent_url: 'file:///tmp/list', list_id: 'cl-1' }, { callTool })
    ).rejects.toThrow(/list_agent_url_insecure/);
    expect(calls).toHaveLength(0);
  });

  it('caches resolved collections until cache_valid_until', async () => {
    const cache = createResolvedListCache();
    const calls: unknown[][] = [];
    const callTool: ResolveListCallTool = async (...args) => {
      calls.push(args);
      return {
        list: { list_id: 'cl-1', name: 'Shows' },
        collections: [{ collection_rid: `rid:${calls.length}`, name: 'Trail Life' }],
        cache_valid_until: '2026-06-02T12:05:00.000Z',
      };
    };

    const ref = { agent_url: 'https://lists.example/mcp', list_id: 'cl-1', auth_token: 'token-a' };
    const first = await resolveCollectionList(ref, {
      cache,
      now: () => new Date('2026-06-02T12:00:00.000Z'),
      callTool,
    });
    const second = await resolveCollectionList(ref, {
      cache,
      now: () => new Date('2026-06-02T12:00:30.000Z'),
      callTool,
    });

    expect(calls).toHaveLength(1);
    expect(second.collections).toEqual(first.collections);
  });

  it('returns cached collection lists before default network DNS validation', async () => {
    const cache = createResolvedListCache();
    const ref = { agent_url: 'https://lists.example.invalid/mcp', list_id: 'cl-1', auth_token: 'token-a' };
    await resolveCollectionList(ref, {
      cache,
      now: () => new Date('2026-06-02T12:00:00.000Z'),
      callTool: async () => ({
        list: { list_id: 'cl-1', name: 'Shows' },
        collections: [{ collection_rid: 'rid:cached', name: 'Cached Show' }],
        cache_valid_until: '2026-06-02T12:05:00.000Z',
      }),
    });

    const cached = await resolveCollectionList(ref, {
      cache,
      now: () => new Date('2026-06-02T12:00:30.000Z'),
    });

    expect(cached.collections).toEqual([{ collection_rid: 'rid:cached', name: 'Cached Show' }]);
  });

  it('rejects collection-list pagination cursors without has_more true', async () => {
    const callTool: ResolveListCallTool = async () => ({
      list: { list_id: 'cl-1', name: 'Shows' },
      collections: [{ collection_rid: 'rid:1', name: 'Trail Life' }],
      pagination: { cursor: 'page-2' },
      cache_valid_until: '2026-06-02T12:05:00.000Z',
    });

    await expect(
      resolveCollectionList(
        { agent_url: 'https://lists.example/mcp', list_id: 'cl-1', auth_token: 'token-a' },
        { cache: createResolvedListCache(), now: () => new Date('2026-06-02T12:00:00.000Z'), callTool }
      )
    ).rejects.toThrow(/collection_list_invalid_pagination/);
  });
});
