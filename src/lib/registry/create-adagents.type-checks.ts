// Type-only regression tests for RegistryClient.createAdagents request shape.
//
// Run with `npm run typecheck`. The library build excludes `*.type-checks.ts`.

import { RegistryClient } from './index';
import type { CreateAdagentsRequest } from './types';

const communityMirrorManifest: CreateAdagentsRequest = {
  authorized_agents: [],
  catalog_etag: 'meta-creative-formats-2026-05',
  properties: [
    {
      domain: 'creative.adcontextprotocol.org',
      platform: 'meta',
      note: 'AAO community mirror catalog for an unadopted platform',
    },
  ],
  formats: [
    {
      format_option_id: 'meta-feed-image',
      format_kind: 'display',
      v1_format_ref: [
        {
          // Namespace for the legacy format shape, not seller authorization.
          agent_url: 'https://creative.adcontextprotocol.org/translated/meta',
          id: 'feed_image',
        },
      ],
    },
  ],
  placements: [
    {
      placement_id: 'feed',
      format_option_ids: ['meta-feed-image'],
    },
  ],
  placement_tags: {
    feed: { label: 'Feed' },
  },
};

void communityMirrorManifest;

async function registryListCompatibility(client: RegistryClient): Promise<void> {
  await client.listAgents({ type: 'si' });

  const agents = await client.listAgents();
  const agentSources: Record<string, unknown> = agents.sources;
  void agentSources;

  const publishers = await client.listPublishers();
  const publisherSources: Record<string, unknown> = publishers.sources;
  void publisherSources;
}

void registryListCompatibility;
