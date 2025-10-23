/**
 * Property Index for AdCP v2.2.0
 *
 * In-memory index for O(1) lookups:
 * - Query 1: Who can sell this property? (property identifier → agents)
 * - Query 2: What properties can this agent sell? (agent → properties)
 * - Query 3: What publisher domains does this agent represent? (agent → domains)
 */

import type { Property, PropertyIdentifierType } from './types';

export interface PropertyMatch {
  property: Property;
  agent_url: string;
  publisher_domain: string;
}

export interface AgentAuthorization {
  agent_url: string;
  publisher_domains: string[];
  properties: Property[];
}

/**
 * Singleton in-memory property index
 */
export class PropertyIndex {
  // property_identifier_key → PropertyMatch[]
  private identifierIndex: Map<string, PropertyMatch[]> = new Map();

  // agent_url → AgentAuthorization
  private agentIndex: Map<string, AgentAuthorization> = new Map();

  /**
   * Query 1: Find agents that can sell a specific property
   */
  findAgentsForProperty(identifierType: PropertyIdentifierType, identifierValue: string): PropertyMatch[] {
    const key = this.makeIdentifierKey(identifierType, identifierValue);
    return this.identifierIndex.get(key) || [];
  }

  /**
   * Query 2: Get all properties an agent can sell
   */
  getAgentAuthorizations(agentUrl: string): AgentAuthorization | null {
    return this.agentIndex.get(agentUrl) || null;
  }

  /**
   * Query 3: Find agents by property tags
   */
  findAgentsByPropertyTags(tags: string[]): PropertyMatch[] {
    const matches: PropertyMatch[] = [];
    const seen = new Set<string>();

    for (const auth of this.agentIndex.values()) {
      for (const property of auth.properties) {
        if (!property.tags) continue;

        // Check if property has any of the requested tags
        const hasTag = tags.some((tag) => property.tags?.includes(tag));
        if (hasTag) {
          const key = `${auth.agent_url}:${property.property_id || property.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            matches.push({
              property,
              agent_url: auth.agent_url,
              publisher_domain: property.publisher_domain || ''
            });
          }
        }
      }
    }

    return matches;
  }

  /**
   * Add a property to the index
   */
  addProperty(property: Property, agentUrl: string, publisherDomain: string): void {
    // Add to identifier index for all identifiers
    for (const identifier of property.identifiers) {
      const key = this.makeIdentifierKey(identifier.type, identifier.value);
      const match: PropertyMatch = {
        property: { ...property, publisher_domain: publisherDomain },
        agent_url: agentUrl,
        publisher_domain: publisherDomain
      };

      const existing = this.identifierIndex.get(key) || [];
      existing.push(match);
      this.identifierIndex.set(key, existing);
    }

    // Add to agent index
    let agentAuth = this.agentIndex.get(agentUrl);
    if (!agentAuth) {
      agentAuth = {
        agent_url: agentUrl,
        publisher_domains: [],
        properties: []
      };
      this.agentIndex.set(agentUrl, agentAuth);
    }

    agentAuth.properties.push({ ...property, publisher_domain: publisherDomain });

    if (!agentAuth.publisher_domains.includes(publisherDomain)) {
      agentAuth.publisher_domains.push(publisherDomain);
    }
  }

  /**
   * Add agent → publisher_domains authorization
   */
  addAgentAuthorization(agentUrl: string, publisherDomains: string[]): void {
    let agentAuth = this.agentIndex.get(agentUrl);
    if (!agentAuth) {
      agentAuth = {
        agent_url: agentUrl,
        publisher_domains: [],
        properties: []
      };
      this.agentIndex.set(agentUrl, agentAuth);
    }

    for (const domain of publisherDomains) {
      if (!agentAuth.publisher_domains.includes(domain)) {
        agentAuth.publisher_domains.push(domain);
      }
    }
  }

  /**
   * Clear all data from the index
   */
  clear(): void {
    this.identifierIndex.clear();
    this.agentIndex.clear();
  }

  /**
   * Get statistics about the index
   */
  getStats() {
    return {
      totalIdentifiers: this.identifierIndex.size,
      totalAgents: this.agentIndex.size,
      totalProperties: Array.from(this.agentIndex.values()).reduce((sum, auth) => sum + auth.properties.length, 0)
    };
  }

  private makeIdentifierKey(type: PropertyIdentifierType, value: string): string {
    return `${type}:${value.toLowerCase()}`;
  }
}

// Singleton instance
let propertyIndexInstance: PropertyIndex | null = null;

/**
 * Get the singleton PropertyIndex instance
 */
export function getPropertyIndex(): PropertyIndex {
  if (!propertyIndexInstance) {
    propertyIndexInstance = new PropertyIndex();
  }
  return propertyIndexInstance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetPropertyIndex(): void {
  propertyIndexInstance = null;
}
