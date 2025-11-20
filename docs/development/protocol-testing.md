# Protocol Testing Strategy for AdCP Client

## Overview

This document outlines a comprehensive testing strategy to prevent protocol validation issues like the recent A2A SDK bug where we were missing `kind: "message"` and using `input` instead of `parameters`. The strategy focuses on testing protocol compliance without relying on external servers.

## Root Cause Analysis

### What Went Wrong

The recent A2A protocol issue occurred because:

1. **Missing Protocol Contract Tests**: No tests validated the actual message format sent to the A2A SDK
2. **Over-Mocking at Wrong Boundaries**: Tests mocked HTTP calls instead of testing SDK integration
3. **No Schema Validation**: No verification that outgoing messages conform to A2A specification
4. **Inadequate Type Usage**: TypeScript types were available but not leveraged in tests

### Why Current Tests Missed It

- **Unit tests** focused on configuration and client setup, not message formatting
- **Integration tests** used mocked responses without validating request structure  
- **E2E tests** weren't run against real servers that would reject malformed messages
- **No contract tests** to validate protocol compliance

## New Testing Strategy

### 1. Protocol Compliance Tests (`test/lib/protocol-compliance.test.js`)

**Purpose**: Validate message format generation without external dependencies

**Approach**:
- Mock at SDK client level (not HTTP level)
- Capture actual messages sent to SDK methods
- Validate against protocol specifications
- Test both success and error scenarios

**Key Test Cases**:
```javascript
test('should generate correctly formatted A2A message with required fields', async () => {
  // Mock A2A client to capture sendMessage calls
  const mockClient = { sendMessage: async (payload) => capturedMessages.push(payload) };
  
  await callA2ATool('https://test.com', 'get_products', { category: 'electronics' });
  
  const message = capturedMessages[0].message;
  assert.strictEqual(message.kind, 'message');        // Catch missing kind
  assert.ok(message.parts[0].data.parameters);        // Catch input vs parameters
  assert.strictEqual(message.parts[0].data.input, undefined); // Prevent regression
});
```

**Benefits**:
- Catches protocol format errors before they reach servers
- Tests actual SDK integration, not just HTTP mocking
- Validates both required fields and deprecated field avoidance
- Fast execution with no external dependencies

### 2. Schema Validation Tests (`test/lib/protocol-schema-validation.test.js`)

**Purpose**: Validate messages against JSON schemas derived from protocol specifications

**Approach**:
- Create validation utilities for A2A and MCP message formats
- Test against both valid and invalid message structures  
- Provide clear error messages for debugging
- Support for protocol evolution and version checking

**Key Features**:
```javascript
function validateA2AMessagePayload(payload) {
  const errors = [];
  
  if (payload.message.kind !== 'message') {
    errors.push('Message must have kind: "message"');
  }

  if (payload.message.parts[0].data.input !== undefined) {
    errors.push("Use 'parameters' instead of deprecated 'input' field");
  }
  
  return { valid: errors.length === 0, errors };
}
```

**Benefits**:
- Systematic validation against protocol specifications
- Early detection of specification violations
- Reusable utilities for other test scenarios
- Clear error reporting for failed validations

### 3. Integration Contract Tests (`test/lib/protocol-integration-contract.test.js`)

**Purpose**: Test complete request/response cycles against protocol-compliant mock servers

**Approach**:
- Create mock servers that implement protocol validation
- Test full integration scenarios without external dependencies
- Validate both successful operations and error handling
- Ensure compatibility with protocol specifications

**Mock Server Features**:
```javascript
class MockA2AServer {
  validateA2ARequest(request) {
    // Implement full A2A specification validation
    if (request.params.message.kind !== "message") {
      return { valid: false, errors: ["Missing kind: 'message'"] };
    }
    // ... more validations
  }
  
  handleRequest(url, options) {
    const validation = this.validateA2ARequest(JSON.parse(options.body));
    if (!validation.valid) {
      return mockErrorResponse(validation.errors);
    }
    return mockSuccessResponse();
  }
}
```

**Benefits**:
- Tests against protocol-compliant servers without external dependencies
- Validates complete request/response cycles
- Catches integration issues early
- Provides realistic error scenarios for testing

### 4. Cross-Protocol Consistency Tests

**Purpose**: Ensure equivalent operations work consistently across A2A and MCP

**Key Test Cases**:
- Parameter format consistency
- Error handling consistency  
- Authentication integration
- Response format expectations

## Implementation Guidelines

### 1. Test Organization

```
test/
├── lib/
│   ├── protocol-compliance.test.js           # Message format validation
│   ├── protocol-schema-validation.test.js    # JSON schema compliance  
│   ├── protocol-integration-contract.test.js # Full integration testing
│   └── existing-tests...
└── utils/
    ├── mock-a2a-server.js                   # Reusable A2A mock server
    ├── mock-mcp-server.js                   # Reusable MCP mock server
    └── protocol-validators.js               # Schema validation utilities
```

### 2. Test Execution Strategy

**Development Workflow**:
```bash
# Run all protocol tests
npm run test:protocols

# Run specific protocol compliance tests  
npm run test:protocol-compliance

# Run integration contract tests
npm run test:protocol-integration

# Run all tests including protocol validation
npm test
```

**CI/CD Integration**:
- Protocol tests run on every commit
- Failed protocol tests block merges
- Test results include protocol compliance reports
- Performance benchmarks for message generation

### 3. Mock Implementation Standards

**A2A Mocking**:
```javascript
// Mock at SDK client level, not HTTP level
const mockA2AClient = {
  sendMessage: async (payload) => {
    // Capture for validation
    capturedPayloads.push(payload);
    
    // Return realistic response
    return { jsonrpc: "2.0", result: { /* valid A2A response */ } };
  }
};

// Replace SDK factory method
A2AClient.fromCardUrl = async () => mockA2AClient;
```

**MCP Mocking**:
```javascript
// Mock MCP client transport
const mockTransport = {
  send: async (request) => {
    capturedRequests.push(request);
    return { jsonrpc: "2.0", result: { /* valid MCP response */ } };
  }
};

// Replace MCP client initialization
MCPClient.connect = async () => ({ transport: mockTransport });
```

## Test Categories and Coverage

### 1. Message Format Validation
- [x] Required field presence (`kind`, `messageId`, `role`)
- [x] Correct field names (`parameters` vs `input`)
- [x] Valid field types and formats
- [x] Proper nesting structure
- [x] Multi-part message handling

### 2. Protocol Compliance
- [x] JSON-RPC 2.0 structure for both protocols
- [x] Method names and parameter formats
- [x] Error response handling
- [x] Authentication integration
- [x] Request/response correlation

### 3. Edge Cases and Error Conditions  
- [x] Malformed message handling
- [x] Missing required parameters
- [x] Invalid authentication
- [x] Network error simulation
- [x] Timeout handling

### 4. Cross-Protocol Consistency
- [x] Equivalent operations produce similar results
- [x] Parameter format consistency
- [x] Error message consistency
- [x] Authentication flow consistency

## Continuous Improvement

### 1. Protocol Evolution Support
- Update tests when protocol specifications change
- Version compatibility testing
- Backward compatibility validation
- Migration path testing

### 2. Performance Monitoring
- Message generation performance benchmarks
- Memory usage during protocol operations
- Concurrent operation testing
- Load testing with mock servers

### 3. Error Analysis
- Collect and analyze protocol error patterns
- Improve error messages based on real issues
- Update tests based on production incidents
- Document common pitfalls

## Tools and Dependencies

### Testing Frameworks
- **Node.js built-in test runner**: Primary test framework
- **Assert module**: Assertion library
- **Custom validators**: Protocol-specific validation utilities

### Mocking Strategy
- **SDK-level mocking**: Mock at client interface level
- **Transport-level mocking**: Mock network transport for integration tests  
- **Server-level mocking**: Full protocol-compliant mock servers
- **Avoid HTTP-level mocking**: Too low-level, misses SDK integration issues

### Schema Validation
- **JSON Schema**: Where available from protocol specifications
- **Custom validators**: For protocol-specific rules
- **Type checking**: Leverage TypeScript types for validation
- **Error reporting**: Clear, actionable error messages

## Success Metrics

### 1. Bug Prevention
- Zero protocol format regressions in production
- Catch protocol issues during development
- Reduce debugging time for protocol-related issues

### 2. Test Coverage
- 100% coverage of protocol message generation paths
- All error conditions tested
- Cross-protocol consistency validated

### 3. Development Velocity
- Fast test execution (< 1 second for protocol tests)
- Clear test failure messages
- Easy to add tests for new protocol features

### 4. Maintainability
- Tests remain stable as protocols evolve
- Clear separation between protocol and business logic testing
- Reusable test utilities across different test scenarios

---

This testing strategy ensures that protocol validation issues like the recent A2A bug are caught early in development, providing confidence that our SDK implementations correctly format messages according to A2A and MCP specifications.