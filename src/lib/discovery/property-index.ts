/**
 * In-memory property index for fast agent lookups
 *
 * Answers two key questions:
 * 1. "Who can sell this property?" (property_id -> agents[])
 * 2. "What can this agent sell?" (agent_url -> properties[])
 */

import type { Property, PropertyIdentifierTypes } from '../types/adcp';

export interface PropertyMatch {
  property: Property;
  agent_url: string;
  agent_name?: string;
  publisher_domain: string;
}

export interface AgentAuthorization {
  agent_url: string;
  properties: Property[];
  publisher_domains: string[];
}

export class PropertyIndex {
  // Map: property identifier -> list of agents authorized to sell it
  private propertyToAgents: Map<string, Set<string>> = new Map();

  // Map: agent_url -> list of properties they can sell
  private agentToProperties: Map<string, Property[]> = new Map();

  // Map: property identifier -> full Property object
  private propertyDetails: Map<string, Property> = new Map();

  // Map: agent_url -> publisher domains that authorized them
  private agentPublishers: Map<string, Set<string>> = new Map();

  /**
   * Add a property authorization to the index
   */
  addAuthorization(
    agentUrl: string,
    property: Property,
    publisherDomain: string
  ): void {
    // Index all identifiers for this property
    for (const identifier of property.identifiers) {
      const key = this.makeKey(identifier.type, identifier.value);

      // property -> agents
      if (!this.propertyToAgents.has(key)) {
        this.propertyToAgents.set(key, new Set());
      }
      this.propertyToAgents.get(key)!.add(agentUrl);

      // Store property details
      this.propertyDetails.set(key, property);
    }

    // agent -> properties
    if (!this.agentToProperties.has(agentUrl)) {
      this.agentToProperties.set(agentUrl, []);
    }
    this.agentToProperties.get(agentUrl)!.push(property);

    // Track which publishers authorized this agent
    if (!this.agentPublishers.has(agentUrl)) {
      this.agentPublishers.set(agentUrl, new Set());
    }
    this.agentPublishers.get(agentUrl)!.add(publisherDomain);
  }

  /**
   * Query 1: Who can sell this property?
   */
  findAgentsForProperty(
    identifierType: PropertyIdentifierTypes,
    identifierValue: string
  ): PropertyMatch[] {
    const key = this.makeKey(identifierType, identifierValue);
    const agents = this.propertyToAgents.get(key);
    const property = this.propertyDetails.get(key);

    if (!agents || !property) {
      return [];
    }

    return Array.from(agents).map(agent_url => ({
      property,
      agent_url,
      publisher_domain: property.publisher_domain
    }));
  }

  /**
   * Query 1b: Find agents by multiple identifiers (OR logic)
   */
  findAgentsForAnyProperty(
    identifiers: Array<{ type: PropertyIdentifierTypes; value: string }>
  ): PropertyMatch[] {
    const allMatches: PropertyMatch[] = [];
    const seen = new Set<string>(); // dedup by agent_url

    for (const { type, value } of identifiers) {
      const matches = this.findAgentsForProperty(type, value);
      for (const match of matches) {
        const key = `${match.agent_url}:${match.property.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          allMatches.push(match);
        }
      }
    }

    return allMatches;
  }

  /**
   * Query 1c: Find agents by property tags
   */
  findAgentsByPropertyTags(tags: string[]): PropertyMatch[] {
    const matches: PropertyMatch[] = [];
    const seen = new Set<string>();

    // Iterate through all properties and check tags
    for (const [key, property] of this.propertyDetails.entries()) {
      if (!property.tags) continue;

      // Check if property has any of the requested tags
      const hasMatchingTag = tags.some(tag => property.tags?.includes(tag));
      if (hasMatchingTag) {
        const agents = this.propertyToAgents.get(key) || new Set();
        for (const agent_url of agents) {
          const matchKey = `${agent_url}:${property.name}`;
          if (!seen.has(matchKey)) {
            seen.add(matchKey);
            matches.push({
              property,
              agent_url,
              publisher_domain: property.publisher_domain
            });
          }
        }
      }
    }

    return matches;
  }

  /**
   * Query 2: What can this agent sell?
   */
  getAgentAuthorizations(agentUrl: string): AgentAuthorization | null {
    const properties = this.agentToProperties.get(agentUrl);
    const publishers = this.agentPublishers.get(agentUrl);

    if (!properties) {
      return null;
    }

    return {
      agent_url: agentUrl,
      properties,
      publisher_domains: Array.from(publishers || [])
    };
  }

  /**
   * List all agents in the index
   */
  listAllAgents(): string[] {
    return Array.from(this.agentToProperties.keys());
  }

  /**
   * List all properties in the index
   */
  listAllProperties(): Property[] {
    return Array.from(new Set(this.propertyDetails.values()));
  }

  /**
   * Get statistics
   */
  getStats(): {
    total_agents: number;
    total_properties: number;
    total_property_identifiers: number;
    total_authorizations: number;
  } {
    let totalAuthorizations = 0;
    for (const agents of this.propertyToAgents.values()) {
      totalAuthorizations += agents.size;
    }

    return {
      total_agents: this.agentToProperties.size,
      total_properties: new Set(this.propertyDetails.values()).size,
      total_property_identifiers: this.propertyDetails.size,
      total_authorizations: totalAuthorizations
    };
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.propertyToAgents.clear();
    this.agentToProperties.clear();
    this.propertyDetails.clear();
    this.agentPublishers.clear();
  }

  /**
   * Create a unique key for a property identifier
   */
  private makeKey(type: PropertyIdentifierTypes, value: string): string {
    return `${type}:${value.toLowerCase()}`;
  }
}

// Singleton instance
let globalIndex: PropertyIndex | null = null;

export function getPropertyIndex(): PropertyIndex {
  if (!globalIndex) {
    globalIndex = new PropertyIndex();
  }
  return globalIndex;
}

export function resetPropertyIndex(): void {
  globalIndex = new PropertyIndex();
}
