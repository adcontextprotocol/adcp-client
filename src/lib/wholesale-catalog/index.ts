/**
 * Seller wholesale catalogue service. A seller writes `readCatalog(scope)`; the service answers
 * `list_products` and wholesale `get_products`, pages and versions the catalogue, answers conditional reads
 * with `unchanged`, and sends `product.*` change events to subscribed buyers.
 *
 * @packageDocumentation
 */
export { createWholesaleCatalogService } from './service';
export { catalogScopeKey, memoryCatalogSnapshotStore } from './memory-store';
export type {
  CatalogChangeV1,
  CatalogEventType,
  CatalogEventV1,
  CatalogProduct,
  CatalogScope,
  CatalogSelectionRequest,
  CatalogSnapshotStoreV1,
  CatalogSnapshotV1,
  CreateWholesaleCatalogServiceOptionsV1,
  WholesaleCatalogAdapterV1,
  WholesaleCatalogBulkChangeV1,
  WholesaleCatalogNotificationsV1,
  WholesaleCatalogSchedulerOptionsV1,
  WholesaleCatalogServiceV1,
  WholesaleCatalogUpdateResultV1,
} from './types';
