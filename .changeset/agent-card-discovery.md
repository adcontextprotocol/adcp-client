---
'@adcp/client': patch
---

Support new A2A agent card discovery path with fallback to legacy path

- Add fallback agent card discovery to support new A2A spec standard path (/.well-known/agent.json)
- Try new standard path first, fall back to legacy path (/.well-known/agent-card.json) for backward compatibility
- Update protocol detection (detectProtocol, detectProtocolWithTimeout) to use fallback discovery
- Update A2A client initialization to resolve card URL with fallback support
- Update trace header logic to recognize both agent card paths (prevent trace leakage)
- Agents like OpenAds that implement new A2A spec now properly discoverable
- Maintains full backward compatibility with legacy agents
