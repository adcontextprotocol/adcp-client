import { syncAudiencesAdapter, syncEventSourcesAdapter } from './platform-ids';
import type { VersionAdapter } from '../types';

/** Adapters between AdCP 3.3 (next minor) and AdCP 3.2 (this key). */
export const v32Adapters: ReadonlyArray<VersionAdapter> = [syncEventSourcesAdapter, syncAudiencesAdapter];
