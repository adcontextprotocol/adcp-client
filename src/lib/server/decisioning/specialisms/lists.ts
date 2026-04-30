/**
 * PropertyListsPlatform + CollectionListsPlatform — list-publishing
 * specialisms (v6.0).
 *
 * Two distinct specialisms with parallel CRUD shapes:
 *
 *   - **`property-lists`** — agent publishes/maintains authorized property
 *     lists (which sellers can sell what for which advertisers; buyer-side
 *     authorization graphs). Sellers FETCH and validate against these.
 *   - **`collection-lists`** — agent publishes/maintains authorized
 *     collection lists (program/show-level brand safety via IMDb /
 *     Gracenote / EIDR ids). Sellers FETCH and apply for inventory
 *     filtering.
 *
 * Both have CRUD on the same shape — create, update, get, list, delete —
 * just on different list types. Could fold into one interface if your
 * adopter implements both; today they're separated to match the spec
 * specialism-per-list-type shape.
 *
 * Shape: standard CRUD + token-issuance semantics. `create_*` returns a
 * one-time fetch token sellers store in their secret manager; `delete_*`
 * revokes the token. Tokens are scoped per-seller for revocation.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { Account } from '../account';
import type { RequestContext } from '../context';
import type {
  CreatePropertyListRequest,
  CreatePropertyListResponse,
  UpdatePropertyListRequest,
  UpdatePropertyListResponse,
  GetPropertyListRequest,
  GetPropertyListResponse,
  ListPropertyListsRequest,
  ListPropertyListsResponse,
  DeletePropertyListRequest,
  DeletePropertyListResponse,
  CreateCollectionListRequest,
  CreateCollectionListResponse,
  UpdateCollectionListRequest,
  UpdateCollectionListResponse,
  GetCollectionListRequest,
  GetCollectionListResponse,
  ListCollectionListsRequest,
  ListCollectionListsResponse,
  DeleteCollectionListRequest,
  DeleteCollectionListResponse,
} from '../../../types/tools.generated';

type Ctx<TCtxMeta> = RequestContext<Account<TCtxMeta>>;

export interface PropertyListsPlatform<TCtxMeta = Record<string, unknown>> {
  /**
   * Create a property list. Returns a `fetch_token` the buyer stores in
   * their secret manager. Token is scoped to this list_id; MUST NOT be
   * reused across lists.
   */
  createPropertyList(req: CreatePropertyListRequest, ctx: Ctx<TCtxMeta>): Promise<CreatePropertyListResponse>;

  /** Patch an existing property list. */
  updatePropertyList(req: UpdatePropertyListRequest, ctx: Ctx<TCtxMeta>): Promise<UpdatePropertyListResponse>;

  /** Read a property list by id. Sellers call this with the fetch_token. */
  getPropertyList(req: GetPropertyListRequest, ctx: Ctx<TCtxMeta>): Promise<GetPropertyListResponse>;

  /** Discover property lists the caller is authorized to read. */
  listPropertyLists(req: ListPropertyListsRequest, ctx: Ctx<TCtxMeta>): Promise<ListPropertyListsResponse>;

  /**
   * Delete a property list. MUST revoke the fetch_token immediately and
   * signal cache invalidation to sellers (reduced cache_valid_until or
   * a list-changed webhook). Compromise-driven revocation MUST also
   * trigger this path.
   */
  deletePropertyList(req: DeletePropertyListRequest, ctx: Ctx<TCtxMeta>): Promise<DeletePropertyListResponse>;
}

export interface CollectionListsPlatform<TCtxMeta = Record<string, unknown>> {
  createCollectionList(req: CreateCollectionListRequest, ctx: Ctx<TCtxMeta>): Promise<CreateCollectionListResponse>;
  updateCollectionList(req: UpdateCollectionListRequest, ctx: Ctx<TCtxMeta>): Promise<UpdateCollectionListResponse>;
  getCollectionList(req: GetCollectionListRequest, ctx: Ctx<TCtxMeta>): Promise<GetCollectionListResponse>;
  listCollectionLists(req: ListCollectionListsRequest, ctx: Ctx<TCtxMeta>): Promise<ListCollectionListsResponse>;
  deleteCollectionList(req: DeleteCollectionListRequest, ctx: Ctx<TCtxMeta>): Promise<DeleteCollectionListResponse>;
}
