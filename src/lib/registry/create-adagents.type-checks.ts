// Type-only regression tests for RegistryClient.createAdagents request shape.
//
// Run with `npm run typecheck`. The library build excludes `*.type-checks.ts`.

import { RegistryClient, buildCommunityMirrorAdagents } from './index';
import type {
  AdagentsCatalogFormat,
  AdagentsPlacementDefinition,
  CreateAdagentsRequest,
  CommunityMirrorAdagentsConfig,
} from './types';

const metaFeedImageFormat: AdagentsCatalogFormat = {
  format_option_id: 'meta-feed-image',
  format_kind: 'image',
  params: {
    width: 1080,
    height: 1080,
  },
  v1_format_ref: [
    {
      // Namespace for the legacy format shape, not seller authorization.
      agent_url: 'https://creative.adcontextprotocol.org/translated/meta',
      id: 'feed_image',
    },
  ],
};

const feedPlacement: AdagentsPlacementDefinition = {
  placement_id: 'feed',
  name: 'Feed',
  property_tags: ['feed'],
  format_options: [{ format_option_id: 'meta-feed-image' }],
};

const communityMirrorConfig: CommunityMirrorAdagentsConfig = {
  catalog_etag: 'meta-creative-formats-2026-05',
  properties: [
    {
      domain: 'creative.adcontextprotocol.org',
      platform: 'meta',
      note: 'AAO community mirror catalog for an unadopted platform',
    },
  ],
  formats: [metaFeedImageFormat],
  placements: [feedPlacement],
  placement_tags: {
    feed: { name: 'Feed', description: 'Main feed placement' },
  },
};

const communityMirrorManifest: CreateAdagentsRequest = buildCommunityMirrorAdagents(communityMirrorConfig);
void communityMirrorManifest;

// @ts-expect-error Community mirror helper must not accept seller authorization claims.
buildCommunityMirrorAdagents({ ...communityMirrorConfig, authorized_agents: [] });

const directCreateRequest: CreateAdagentsRequest = {
  authorized_agents: [],
  catalog_etag: 'meta-creative-formats-2026-05',
  formats: [metaFeedImageFormat],
  placements: [feedPlacement],
  placement_tags: {
    feed: { name: 'Feed', description: 'Main feed placement' },
  },
};

void directCreateRequest;

async function registryListCompatibility(client: RegistryClient): Promise<void> {
  await client.listAgents({ type: 'si' });
  await client.createCommunityMirrorAdagents(communityMirrorConfig);

  const agents = await client.listAgents();
  const agentSources: Record<string, unknown> = agents.sources;
  void agentSources;

  const publishers = await client.listPublishers();
  const publisherSources: Record<string, unknown> = publishers.sources;
  void publisherSources;
}

void registryListCompatibility;
