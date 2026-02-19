/**
 * Property List Adapter
 *
 * Server-side adapter for implementing property list management logic.
 * Publishers use this to manage buyer-defined property lists for filtering
 * available inventory.
 *
 * This is a stub implementation that stores lists in memory.
 * Publishers should extend or replace this with persistent storage.
 */

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
  PropertyList,
} from '../types/tools.generated';

/**
 * Resolved property identifier
 */
export interface ResolvedProperty {
  identifier_type: string;
  identifier_value: string;
  publisher_domain?: string;
  display_name?: string;
  status?: 'active' | 'inactive' | 'pending';
}

/**
 * Error thrown when property list operations fail
 */
export class PropertyListError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'PropertyListError';
  }
}

/**
 * Abstract interface for property list adapters.
 * Publishers implement this to provide their storage and resolution logic.
 */
export interface IPropertyListAdapter {
  /**
   * Check if property list management is supported by this server
   */
  isSupported(): boolean;

  /**
   * Create a new property list
   */
  createList(request: CreatePropertyListRequest): Promise<CreatePropertyListResponse>;

  /**
   * Update an existing property list
   */
  updateList(request: UpdatePropertyListRequest): Promise<UpdatePropertyListResponse>;

  /**
   * Get a property list with optional resolution
   */
  getList(request: GetPropertyListRequest): Promise<GetPropertyListResponse>;

  /**
   * List all property lists for a principal
   */
  listLists(request: ListPropertyListsRequest): Promise<ListPropertyListsResponse>;

  /**
   * Delete a property list
   */
  deleteList(request: DeletePropertyListRequest): Promise<DeletePropertyListResponse>;

  /**
   * Check if a property identifier is in a property list.
   * Used by get_products and create_media_buy for filtering.
   */
  isPropertyInList(listId: string, identifierType: string, identifierValue: string): Promise<boolean>;

  /**
   * Resolve a property list to its constituent identifiers.
   * Applies filters and returns matching properties.
   */
  resolveList(listId: string, maxResults?: number, cursor?: string): Promise<ResolvedProperty[]>;
}

/**
 * Error codes for property list operations
 */
export const PropertyListErrorCodes = {
  NOT_SUPPORTED: 'property_lists_not_supported',
  LIST_NOT_FOUND: 'list_not_found',
  INVALID_LIST: 'invalid_list',
  PERMISSION_DENIED: 'permission_denied',
  QUOTA_EXCEEDED: 'quota_exceeded',
} as const;

/**
 * Stub implementation of PropertyListAdapter.
 * Uses in-memory storage for development and testing.
 *
 * Publishers should extend this class or provide their own implementation
 * that integrates with their property management systems.
 */
export class PropertyListAdapter implements IPropertyListAdapter {
  private lists: Map<string, PropertyList> = new Map();
  private authTokens: Map<string, string> = new Map();
  private nextId = 1;

  /**
   * Check if property list management is supported.
   * Override this to return true when implementing real logic.
   */
  isSupported(): boolean {
    return false;
  }

  async createList(request: CreatePropertyListRequest): Promise<CreatePropertyListResponse> {
    if (!this.isSupported()) {
      throw new PropertyListError(
        PropertyListErrorCodes.NOT_SUPPORTED,
        'Property list management is not supported by this server'
      );
    }

    // Generate ID and auth token
    const listId = `pl_${this.nextId++}_${Date.now()}`;
    const authToken = `plat_${this.generateToken()}`;
    const now = new Date().toISOString();

    const list: PropertyList = {
      list_id: listId,
      name: request.name,
      description: request.description,
      base_properties: request.base_properties,
      filters: request.filters,
      brand: request.brand,
      created_at: now,
      updated_at: now,
      property_count: 0,
    };

    this.lists.set(listId, list);
    this.authTokens.set(listId, authToken);

    return {
      list,
      auth_token: authToken,
    };
  }

  async updateList(request: UpdatePropertyListRequest): Promise<UpdatePropertyListResponse> {
    if (!this.isSupported()) {
      throw new PropertyListError(
        PropertyListErrorCodes.NOT_SUPPORTED,
        'Property list management is not supported by this server'
      );
    }

    const existing = this.lists.get(request.list_id);
    if (!existing) {
      throw new PropertyListError(PropertyListErrorCodes.LIST_NOT_FOUND, `Property list not found: ${request.list_id}`);
    }

    // Update fields
    const updated: PropertyList = {
      ...existing,
      name: request.name ?? existing.name,
      description: request.description ?? existing.description,
      base_properties: request.base_properties ?? existing.base_properties,
      filters: request.filters ?? existing.filters,
      brand: request.brand ?? existing.brand,
      updated_at: new Date().toISOString(),
    };

    this.lists.set(request.list_id, updated);

    return { list: updated };
  }

  async getList(request: GetPropertyListRequest): Promise<GetPropertyListResponse> {
    if (!this.isSupported()) {
      throw new PropertyListError(
        PropertyListErrorCodes.NOT_SUPPORTED,
        'Property list management is not supported by this server'
      );
    }

    const list = this.lists.get(request.list_id);
    if (!list) {
      throw new PropertyListError(PropertyListErrorCodes.LIST_NOT_FOUND, `Property list not found: ${request.list_id}`);
    }

    // Resolve property identifiers if requested
    let identifiers: any[] | undefined;
    if (request.resolve !== false) {
      const resolved = await this.resolveList(
        request.list_id,
        request.pagination?.max_results,
        request.pagination?.cursor
      );
      identifiers = resolved.map(p => ({
        identifier_type: p.identifier_type,
        identifier_value: p.identifier_value,
      }));
    }

    return {
      list: {
        ...list,
        property_count: identifiers?.length ?? list.property_count,
      },
      identifiers,
      pagination: {
        has_more: false,
        total_count: identifiers?.length,
      },
      resolved_at: new Date().toISOString(),
    };
  }

  async listLists(request: ListPropertyListsRequest): Promise<ListPropertyListsResponse> {
    if (!this.isSupported()) {
      throw new PropertyListError(
        PropertyListErrorCodes.NOT_SUPPORTED,
        'Property list management is not supported by this server'
      );
    }

    // Filter by principal if provided
    let lists = Array.from(this.lists.values());
    if (request.principal) {
      lists = lists.filter(l => l.principal === request.principal);
    }

    // Filter by name if provided
    if (request.name_contains) {
      const searchTerm = request.name_contains.toLowerCase();
      lists = lists.filter(l => l.name.toLowerCase().includes(searchTerm));
    }

    // Apply pagination
    const maxResults = request.pagination?.max_results ?? 100;
    const paginatedLists = lists.slice(0, maxResults);

    return {
      lists: paginatedLists,
      pagination: {
        has_more: paginatedLists.length < lists.length,
        total_count: lists.length,
      },
    };
  }

  async deleteList(request: DeletePropertyListRequest): Promise<DeletePropertyListResponse> {
    if (!this.isSupported()) {
      throw new PropertyListError(
        PropertyListErrorCodes.NOT_SUPPORTED,
        'Property list management is not supported by this server'
      );
    }

    if (!this.lists.has(request.list_id)) {
      throw new PropertyListError(PropertyListErrorCodes.LIST_NOT_FOUND, `Property list not found: ${request.list_id}`);
    }

    this.lists.delete(request.list_id);
    this.authTokens.delete(request.list_id);

    return {
      deleted: true,
      list_id: request.list_id,
    };
  }

  /**
   * Check if a property is in a list.
   * Stub implementation returns false (property not found).
   */
  async isPropertyInList(listId: string, identifierType: string, identifierValue: string): Promise<boolean> {
    if (!this.isSupported()) {
      // When not supported, all properties are considered in-list (no filtering)
      return true;
    }

    // Override in subclass to implement actual lookup
    return false;
  }

  /**
   * Resolve a property list to identifiers.
   * Stub implementation returns empty array.
   */
  async resolveList(listId: string, maxResults?: number, cursor?: string): Promise<ResolvedProperty[]> {
    if (!this.isSupported()) {
      return [];
    }

    // Override in subclass to implement actual resolution
    return [];
  }

  /**
   * Generate a random token for auth
   */
  protected generateToken(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  }
}

/**
 * Helper to check if an error is a PropertyListError
 */
export function isPropertyListError(error: unknown): error is PropertyListError {
  return error instanceof PropertyListError;
}

/**
 * Default singleton instance for servers that don't need property list management
 */
export const defaultPropertyListAdapter = new PropertyListAdapter();
