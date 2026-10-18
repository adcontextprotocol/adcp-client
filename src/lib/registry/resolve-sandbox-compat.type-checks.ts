import type { components, ResolveIdentifiersRequest } from './types';

// Adding a defaulted registry flag must preserve both public request surfaces.
const rawRequest: components['schemas']['ResolveRequest'] = {
  identifiers: [],
  provenance: { type: 'crawl' },
  mode: 'lookup',
};
const clientRequest: ResolveIdentifiersRequest = {
  identifiers: [],
  provenance: { type: 'crawl' },
};
const sandboxRequest: ResolveIdentifiersRequest = { ...clientRequest, sandbox: true };
void [rawRequest, clientRequest, sandboxRequest];
