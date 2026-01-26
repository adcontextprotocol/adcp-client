/**
 * Sponsored Intelligence (SI) Session Manager
 *
 * Server-side adapter for managing SI conversational commerce sessions.
 * Brands use this to handle session lifecycle and message routing to their
 * conversational AI systems.
 *
 * This is a stub implementation that doesn't support sessions.
 * Brands should extend or replace this with their conversation logic.
 */

import type {
  SIGetOfferingRequest,
  SIGetOfferingResponse,
  SIInitiateSessionRequest,
  SIInitiateSessionResponse,
  SISendMessageRequest,
  SISendMessageResponse,
  SITerminateSessionRequest,
  SITerminateSessionResponse,
  SICapabilities,
} from '../types/tools.generated';

/**
 * Internal session state
 */
export interface SISession {
  sessionId: string;
  createdAt: string;
  lastActiveAt: string;
  identity: any;
  mediaBuyId?: string;
  offeringId?: string;
  offeringToken?: string;
  placement?: string;
  negotiatedCapabilities?: SICapabilities;
  status: 'active' | 'pending_handoff' | 'complete' | 'terminated';
  messageCount: number;
  conversationHistory: {
    role: 'user' | 'brand';
    content: string;
    timestamp: string;
  }[];
  metadata?: Record<string, unknown>;
}

/**
 * Abstract interface for SI session managers.
 * Brands implement this to provide their conversational AI logic.
 */
export interface ISISessionManager {
  /**
   * Check if SI is supported by this server
   */
  isSupported(): boolean;

  /**
   * Get offering details for display to user
   */
  getOffering(request: SIGetOfferingRequest): Promise<SIGetOfferingResponse>;

  /**
   * Initiate a new SI session
   */
  initiateSession(request: SIInitiateSessionRequest): Promise<SIInitiateSessionResponse>;

  /**
   * Handle a message within a session
   */
  sendMessage(request: SISendMessageRequest): Promise<SISendMessageResponse>;

  /**
   * Terminate a session
   */
  terminateSession(request: SITerminateSessionRequest): Promise<SITerminateSessionResponse>;

  /**
   * Get session state (for internal use)
   */
  getSession(sessionId: string): Promise<SISession | null>;

  /**
   * Clean up stale sessions
   */
  cleanupStaleSessions(maxAgeMinutes: number): Promise<number>;
}

/**
 * Error codes for SI operations
 */
export const SIErrorCodes = {
  NOT_SUPPORTED: 'si_not_supported',
  SESSION_NOT_FOUND: 'session_not_found',
  SESSION_EXPIRED: 'session_expired',
  SESSION_TERMINATED: 'session_already_terminated',
  OFFERING_NOT_FOUND: 'offering_not_found',
  OFFERING_UNAVAILABLE: 'offering_unavailable',
  INVALID_MESSAGE: 'invalid_message',
  CAPABILITY_NOT_SUPPORTED: 'capability_not_supported',
} as const;

/**
 * Stub implementation of SISessionManager.
 * Uses in-memory storage and returns not-supported errors.
 *
 * Brands should extend this class or provide their own implementation
 * that integrates with their conversational AI systems.
 */
export class SISessionManager implements ISISessionManager {
  private sessions: Map<string, SISession> = new Map();
  private offerings: Map<string, any> = new Map(); // Offering cache
  private nextSessionId = 1;

  /**
   * Check if SI is supported.
   * Override this to return true when implementing real logic.
   */
  isSupported(): boolean {
    return false;
  }

  async getOffering(request: SIGetOfferingRequest): Promise<SIGetOfferingResponse> {
    if (!this.isSupported()) {
      return {
        available: false,
        unavailable_reason: 'SI not supported by this server',
        errors: [
          {
            code: SIErrorCodes.NOT_SUPPORTED,
            message: 'Sponsored Intelligence is not supported by this server',
          },
        ],
      };
    }

    // Override in subclass to implement actual offering lookup
    return {
      available: false,
      unavailable_reason: 'Offering not found',
      errors: [
        {
          code: SIErrorCodes.OFFERING_NOT_FOUND,
          message: `Offering not found: ${request.offering_id}`,
        },
      ],
    };
  }

  async initiateSession(request: SIInitiateSessionRequest): Promise<SIInitiateSessionResponse> {
    if (!this.isSupported()) {
      return {
        session_id: '',
        errors: [
          {
            code: SIErrorCodes.NOT_SUPPORTED,
            message: 'Sponsored Intelligence is not supported by this server',
          },
        ],
      };
    }

    // Create session
    const sessionId = this.generateSessionId();
    const now = new Date().toISOString();

    const session: SISession = {
      sessionId,
      createdAt: now,
      lastActiveAt: now,
      identity: request.identity,
      mediaBuyId: request.media_buy_id,
      offeringId: request.offering_id,
      offeringToken: request.offering_token,
      placement: request.placement,
      negotiatedCapabilities: this.negotiateCapabilities(request.supported_capabilities),
      status: 'active',
      messageCount: 0,
      conversationHistory: [],
    };

    this.sessions.set(sessionId, session);

    // Generate initial response
    const initialResponse = await this.generateInitialResponse(session, request.context);

    return {
      session_id: sessionId,
      response: initialResponse,
      negotiated_capabilities: session.negotiatedCapabilities,
    };
  }

  async sendMessage(request: SISendMessageRequest): Promise<SISendMessageResponse> {
    if (!this.isSupported()) {
      return {
        session_id: request.session_id,
        session_status: 'complete',
        errors: [
          {
            code: SIErrorCodes.NOT_SUPPORTED,
            message: 'Sponsored Intelligence is not supported by this server',
          },
        ],
      };
    }

    const session = await this.getSession(request.session_id);
    if (!session) {
      return {
        session_id: request.session_id,
        session_status: 'complete',
        errors: [
          {
            code: SIErrorCodes.SESSION_NOT_FOUND,
            message: `Session not found: ${request.session_id}`,
          },
        ],
      };
    }

    if (session.status === 'terminated' || session.status === 'complete') {
      return {
        session_id: request.session_id,
        session_status: 'complete',
        errors: [
          {
            code: SIErrorCodes.SESSION_TERMINATED,
            message: 'Session has already been terminated',
          },
        ],
      };
    }

    // Record user message
    if (request.message) {
      session.conversationHistory.push({
        role: 'user',
        content: request.message,
        timestamp: new Date().toISOString(),
      });
    }

    session.messageCount++;
    session.lastActiveAt = new Date().toISOString();

    // Generate response
    const response = await this.generateResponse(session, request);

    // Record brand response
    if (response.message) {
      session.conversationHistory.push({
        role: 'brand',
        content: response.message,
        timestamp: new Date().toISOString(),
      });
    }

    this.sessions.set(session.sessionId, session);

    return {
      session_id: session.sessionId,
      response,
      session_status: session.status,
    };
  }

  async terminateSession(request: SITerminateSessionRequest): Promise<SITerminateSessionResponse> {
    if (!this.isSupported()) {
      return {
        session_id: request.session_id,
        terminated: false,
        errors: [
          {
            code: SIErrorCodes.NOT_SUPPORTED,
            message: 'Sponsored Intelligence is not supported by this server',
          },
        ],
      };
    }

    const session = await this.getSession(request.session_id);
    if (!session) {
      return {
        session_id: request.session_id,
        terminated: false,
        errors: [
          {
            code: SIErrorCodes.SESSION_NOT_FOUND,
            message: `Session not found: ${request.session_id}`,
          },
        ],
      };
    }

    // Update session status
    session.status = 'terminated';
    this.sessions.set(session.sessionId, session);

    // Generate ACP handoff data if this is a transaction handoff
    let acpHandoff: SITerminateSessionResponse['acp_handoff'];
    if (request.reason === 'handoff_transaction') {
      acpHandoff = await this.generateACPHandoff(session, request.termination_context);
    }

    return {
      session_id: session.sessionId,
      terminated: true,
      acp_handoff: acpHandoff,
    };
  }

  /**
   * Generate ACP handoff data for checkout.
   * Override to implement actual checkout flow integration.
   */
  protected async generateACPHandoff(
    session: SISession,
    terminationContext?: SITerminateSessionRequest['termination_context']
  ): Promise<SITerminateSessionResponse['acp_handoff']> {
    // Stub returns undefined (no checkout URL)
    return undefined;
  }

  async getSession(sessionId: string): Promise<SISession | null> {
    return this.sessions.get(sessionId) || null;
  }

  async cleanupStaleSessions(maxAgeMinutes: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setMinutes(cutoff.getMinutes() - maxAgeMinutes);

    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (new Date(session.lastActiveAt) < cutoff) {
        this.sessions.delete(id);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Generate a unique session ID.
   */
  protected generateSessionId(): string {
    return `si_${this.nextSessionId++}_${Date.now()}`;
  }

  /**
   * Negotiate capabilities between host and brand.
   * Override to customize capability negotiation.
   */
  protected negotiateCapabilities(hostCapabilities?: SICapabilities): SICapabilities {
    // Stub returns minimal capabilities
    return {
      modalities: {
        conversational: true,
      },
    };
  }

  /**
   * Generate initial response when session is created.
   * Override to implement actual greeting/welcome logic.
   */
  protected async generateInitialResponse(
    session: SISession,
    context: string
  ): Promise<{ message?: string; ui_elements?: any[] }> {
    // Stub returns a generic greeting
    return {
      message: 'Welcome! How can I help you today?',
    };
  }

  /**
   * Generate response to a user message.
   * Override to implement actual conversational AI logic.
   */
  protected async generateResponse(
    session: SISession,
    request: SISendMessageRequest
  ): Promise<{ message?: string; ui_elements?: any[] }> {
    // Stub returns a generic response
    return {
      message: "I'm sorry, but I'm not able to help with that right now. Is there anything else I can assist you with?",
    };
  }

  /**
   * Generate a summary of the conversation.
   * Override to implement actual summarization logic.
   */
  protected async generateConversationSummary(session: SISession): Promise<string> {
    return `Conversation with ${session.messageCount} messages.`;
  }
}

/**
 * Example of an AI-powered SI session manager (stub).
 * Shows how brands might extend the base class.
 */
export class AISISessionManager extends SISessionManager {
  private aiEndpoint?: string;
  private brandConfig?: {
    brandName: string;
    welcomeMessage?: string;
    offerings?: Map<string, any>;
  };

  constructor(config?: { aiEndpoint?: string; brandName?: string; welcomeMessage?: string }) {
    super();
    this.aiEndpoint = config?.aiEndpoint;
    this.brandConfig = {
      brandName: config?.brandName || 'Brand',
      welcomeMessage: config?.welcomeMessage,
    };
  }

  isSupported(): boolean {
    return !!this.aiEndpoint;
  }

  protected async generateInitialResponse(
    session: SISession,
    context: string
  ): Promise<{ message?: string; ui_elements?: any[] }> {
    if (!this.isSupported()) {
      return super.generateInitialResponse(session, context);
    }

    // In a real implementation, this would:
    // 1. Parse the context to understand user intent
    // 2. Call AI service to generate personalized greeting
    // 3. Optionally include product recommendations
    return {
      message:
        this.brandConfig?.welcomeMessage ||
        `Welcome to ${this.brandConfig?.brandName}! I see you're interested in ${context}. How can I help?`,
    };
  }
}

/**
 * Default singleton instance for servers that don't support SI
 */
export const defaultSISessionManager = new SISessionManager();
