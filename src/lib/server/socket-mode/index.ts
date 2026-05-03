/**
 * Socket Mode — outbound-WebSocket bridge so an adopter's MCP server
 * can be reached by a remote runner without a public DNS / firewall
 * hole. Slack Socket Mode pattern.
 *
 * Today the canonical consumer is Addie at agenticadvertising.org for
 * conformance assistance during agent development. The transport is
 * neutral — any third-party orchestrator that speaks the same handshake
 * could terminate the other end.
 *
 * Dev/staging only — see `ConformanceClient` JSDoc for the policy.
 */

export { ConformanceClient, type ConformanceClientOptions, type ConformanceStatus } from './conformance-client';
export { WebSocketTransport } from './ws-transport';
