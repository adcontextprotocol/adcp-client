import {
  verifySupplyPath,
  annotateProductsSupplyPaths,
  type AuthorizationCollectionSelector,
  type ProductCollectionSelector,
  type CollectionDistribution,
  type AuthorizedAgent,
  type AdagentsAuthorizedAgent,
} from '../index';

const bulk: AuthorizationCollectionSelector = { publisher_domain: 'owner.example' };
const product: ProductCollectionSelector = { publisher_domain: 'owner.example', collection_ids: ['channel'] };
// @ts-expect-error Product selectors cannot use authorization bulk grants.
const invalidProduct: ProductCollectionSelector = bulk;
// @ts-expect-error Explicit product selection cannot be empty.
const emptyProduct: ProductCollectionSelector = { publisher_domain: 'owner.example', collection_ids: [] };
const byId: CollectionDistribution = { publisher_domain: 'host.example', property_ids: ['ctv'] };
const byIdentifier: CollectionDistribution = {
  publisher_domain: 'host.example',
  identifiers: [{ type: 'publisher_channel_id', value: 'channel' }],
};
const both: CollectionDistribution = { ...byId, identifiers: [{ type: 'publisher_channel_id', value: 'channel' }] };
// @ts-expect-error A distribution entry must identify carriage.
const emptyDistribution: CollectionDistribution = { publisher_domain: 'host.example' };
const discoveryGrant: AuthorizedAgent = {
  url: 'https://agent.example',
  authorized_for: 'channel',
  collections: [bulk],
};
const registryGrant: AdagentsAuthorizedAgent = {
  url: 'https://agent.example',
  authorized_for: 'channel',
  authorization_type: 'property_ids',
  property_ids: ['ctv'],
  collections: [bulk],
};
const request = {
  owner_domain: 'owner.example',
  host_domain: 'host.example',
  agent_url: 'https://agent.example',
  collection_id: 'channel',
};
async function check(): Promise<void> {
  const live = await verifySupplyPath(request);
  live.sources.evidence[0]?.sha256;
  const cached = await verifySupplyPath(request, { source: 'registry' });
  cached.legs.host_authorization.matched_entry?.collections?.[0]?.collection_ids;
  const products = await annotateProductsSupplyPaths(
    [{ product_id: 'seller-product', collections: [product] }],
    request.agent_url
  );
  products[0]?.product_id;
  const annotation = products[0]?.supply_path_verification;
  if (annotation?.source === 'authoritative') annotation.paths[0]?.sources.evidence;
  // @ts-expect-error Cached registry results cannot be passed off as live evidence.
  const forged: typeof live = cached;
  void forged;
}
void [invalidProduct, emptyProduct, byId, byIdentifier, both, emptyDistribution, discoveryGrant, registryGrant, check];
