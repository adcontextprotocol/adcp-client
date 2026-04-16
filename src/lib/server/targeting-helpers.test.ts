import { describe, it, expect } from 'vitest';
import {
  matchesPropertyList,
  matchesCollectionList,
  type ResolvedPropertyList,
  type ResolvedCollectionList,
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
