/**
 * Proposal Manager
 *
 * Server-side adapter for managing media plan proposals in get_products.
 * Publishers use this to generate, store, and refine proposals based on
 * campaign briefs.
 *
 * This is a stub implementation that doesn't generate proposals.
 * Publishers should extend or replace this with their recommendation logic.
 */

import type { GetProductsRequest, Proposal, Product, ProductAllocation, BrandManifest } from '../types/tools.generated';

/**
 * Context for generating proposals
 */
export interface ProposalContext {
  /** Original brief text */
  brief?: string;
  /** Available products to allocate */
  products: Product[];
  /** Brand information if provided */
  brandManifest?: BrandManifest;
  /** Property list ID if filtering was applied */
  propertyListId?: string;
  /** Previous proposal being refined */
  previousProposal?: Proposal;
}

/**
 * Abstract interface for proposal managers.
 * Publishers implement this to provide their proposal generation logic.
 */
export interface IProposalManager {
  /**
   * Check if proposal generation is supported by this server
   */
  isSupported(): boolean;

  /**
   * Generate proposals for a get_products request
   */
  generateProposals(context: ProposalContext): Promise<Proposal[]>;

  /**
   * Refine an existing proposal based on new instructions
   */
  refineProposal(proposalId: string, refinementBrief: string, context: ProposalContext): Promise<Proposal | null>;

  /**
   * Get a stored proposal by ID
   */
  getProposal(proposalId: string): Promise<Proposal | null>;

  /**
   * Store a proposal for later retrieval
   */
  storeProposal(proposal: Proposal): Promise<void>;

  /**
   * Clean up expired proposals
   */
  cleanupExpiredProposals(): Promise<number>;
}

/**
 * Error codes for proposal operations
 */
export const ProposalErrorCodes = {
  NOT_SUPPORTED: 'proposals_not_supported',
  PROPOSAL_NOT_FOUND: 'proposal_not_found',
  PROPOSAL_EXPIRED: 'proposal_expired',
  INVALID_ALLOCATION: 'invalid_allocation',
  GENERATION_FAILED: 'generation_failed',
} as const;

/**
 * Stub implementation of ProposalManager.
 * Uses in-memory storage and doesn't generate proposals.
 *
 * Publishers should extend this class or provide their own implementation
 * that integrates with their media planning systems or AI.
 */
export class ProposalManager implements IProposalManager {
  private proposals: Map<string, Proposal> = new Map();
  private nextId = 1;

  /**
   * Check if proposal generation is supported.
   * Override this to return true when implementing real logic.
   */
  isSupported(): boolean {
    return false;
  }

  /**
   * Generate proposals for a get_products request.
   * Stub implementation returns empty array.
   *
   * Publishers should override this to implement:
   * - AI-powered media planning based on brief
   * - Rule-based allocation logic
   * - Historical performance-based recommendations
   */
  async generateProposals(context: ProposalContext): Promise<Proposal[]> {
    if (!this.isSupported()) {
      return [];
    }

    // Override in subclass to implement actual proposal generation
    // Example implementation would:
    // 1. Parse the brief to understand campaign objectives
    // 2. Score products against the brief requirements
    // 3. Generate optimal budget allocations
    // 4. Create one or more proposal variants
    return [];
  }

  /**
   * Refine an existing proposal based on new instructions.
   * Stub implementation returns null.
   *
   * Publishers should override this to implement:
   * - Parse refinement instructions (e.g., "more mobile", "increase German reach")
   * - Adjust allocations based on instructions
   * - Re-validate and return updated proposal
   */
  async refineProposal(
    proposalId: string,
    refinementBrief: string,
    context: ProposalContext
  ): Promise<Proposal | null> {
    if (!this.isSupported()) {
      return null;
    }

    const existing = await this.getProposal(proposalId);
    if (!existing) {
      return null;
    }

    // Check expiration
    if (existing.expires_at && new Date(existing.expires_at) < new Date()) {
      return null;
    }

    // Override in subclass to implement actual refinement logic
    return null;
  }

  /**
   * Get a stored proposal by ID.
   */
  async getProposal(proposalId: string): Promise<Proposal | null> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return null;
    }

    // Check expiration
    if (proposal.expires_at && new Date(proposal.expires_at) < new Date()) {
      this.proposals.delete(proposalId);
      return null;
    }

    return proposal;
  }

  /**
   * Store a proposal for later retrieval.
   */
  async storeProposal(proposal: Proposal): Promise<void> {
    this.proposals.set(proposal.proposal_id, proposal);
  }

  /**
   * Clean up expired proposals.
   * Returns the number of proposals removed.
   */
  async cleanupExpiredProposals(): Promise<number> {
    const now = new Date();
    let removed = 0;

    for (const [id, proposal] of this.proposals) {
      if (proposal.expires_at && new Date(proposal.expires_at) < now) {
        this.proposals.delete(id);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Generate a unique proposal ID.
   */
  protected generateProposalId(): string {
    return `prop_${this.nextId++}_${Date.now()}`;
  }

  /**
   * Helper to validate that allocations sum to 100%.
   */
  protected validateAllocations(allocations: ProductAllocation[]): boolean {
    const sum = allocations.reduce((acc, a) => acc + a.allocation_percentage, 0);
    return Math.abs(sum - 100) < 0.01; // Allow small floating point errors
  }

  /**
   * Helper to create a proposal with default expiration.
   */
  protected createProposal(
    name: string,
    description: string,
    allocations: [ProductAllocation, ...ProductAllocation[]],
    expirationHours: number = 24
  ): Proposal {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + expirationHours);

    return {
      proposal_id: this.generateProposalId(),
      name,
      description,
      allocations,
      expires_at: expiresAt.toISOString(),
    };
  }
}

/**
 * Example of an AI-powered proposal manager (stub).
 * Shows how publishers might extend the base class.
 */
export class AIProposalManager extends ProposalManager {
  private aiEndpoint?: string;

  constructor(aiEndpoint?: string) {
    super();
    this.aiEndpoint = aiEndpoint;
  }

  isSupported(): boolean {
    return !!this.aiEndpoint;
  }

  async generateProposals(context: ProposalContext): Promise<Proposal[]> {
    if (!this.isSupported() || !context.brief) {
      return [];
    }

    // In a real implementation, this would call an AI service
    // to generate recommendations based on the brief and products
    //
    // Example flow:
    // 1. Send brief + product catalog to AI
    // 2. AI returns recommended allocations with rationale
    // 3. Validate allocations sum to 100%
    // 4. Store and return proposals

    return [];
  }
}

/**
 * Default singleton instance for servers that don't need proposals
 */
export const defaultProposalManager = new ProposalManager();
