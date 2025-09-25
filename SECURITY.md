# Security Policy

## Supported Versions

We actively support the following versions of @adcp/client with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | ✅ Yes            |
| < 1.0   | ❌ No             |

## Security Features

### Built-in Security Measures

The @adcp/client library implements several security measures by default:

#### 🛡️ **URL Validation & SSRF Protection**
- All agent URLs are validated before making requests
- Private IP ranges (127.0.0.1, 192.168.x.x, 10.x.x.x, 172.16-31.x.x) are blocked in production
- Localhost and metadata endpoints (169.254.169.254) are blocked in production
- Only HTTP/HTTPS protocols are allowed
- URL length limits prevent excessively long URLs

#### 🔐 **Authentication Security**
- Bearer token authentication with secure header handling
- Environment variable-based token management (never hardcode tokens)
- Support for both direct tokens and environment variable references
- Automatic token detection and validation

#### ⚡ **Rate Limiting & Circuit Breakers**
- Built-in circuit breaker pattern prevents overwhelming failing agents
- Configurable request timeouts (default: 30 seconds)
- Concurrent request limiting (default: 5 simultaneous requests)
- Automatic retry with exponential backoff

#### 🔍 **Input Validation**
- All agent configurations are validated before use
- Tool parameters are sanitized and validated
- JSON schema validation for responses
- Type safety with TypeScript prevents many injection attacks

#### 📝 **Secure Logging**
- Debug logs never contain sensitive authentication tokens
- Request/response logging excludes authorization headers
- Configurable log levels for production environments

## Security Best Practices

### For Library Users

#### 🔒 **Token Management**
```bash
# ✅ Good: Use environment variables
export AGENT_TOKEN=your-secure-token-here

# ❌ Bad: Hardcoding tokens
const config = { auth_token_env: 'NEVER_HARDCODE_TOKENS_LIKE_THIS' }
```

#### 🌐 **Agent URL Configuration**
```typescript
// ✅ Good: Use HTTPS and validated domains
const agent = {
  agent_uri: 'https://trusted-agent.example.com/mcp/',
  requiresAuth: true
};

// ❌ Bad: HTTP or untrusted domains
const agent = {
  agent_uri: 'http://unknown-agent.com/',
  requiresAuth: false
};
```

#### 🚫 **Network Security**
```typescript
// ✅ Good: Validate responses
const result = await client.callTool('agent-id', 'get_products', args);
if (result.success) {
  // Validate data before using
  if (result.data?.products?.length > 0) {
    // Use validated data
  }
}

// ❌ Bad: Trust responses blindly
const products = result.data.products; // Could be undefined or malicious
```

#### 🔧 **Production Configuration**
```typescript
// ✅ Good: Production settings
process.env.NODE_ENV = 'production'; // Enables additional security checks
process.env.REQUEST_TIMEOUT = '10000'; // Shorter timeout for production
process.env.MAX_CONCURRENT = '3'; // Lower concurrency for stability
```

### For Contributors

#### 🧪 **Security Testing**
- Always test with both valid and invalid inputs
- Test authentication failure scenarios
- Verify URL validation prevents SSRF attacks
- Test with malformed responses and network errors

#### 📦 **Dependency Security**
- Use `npm audit` to check for vulnerabilities
- Keep protocol SDKs updated to latest versions
- Review new dependencies for security issues
- Use `npm ci` for reproducible builds

## Vulnerability Reporting

### 🚨 **Reporting Security Issues**

**Please DO NOT report security vulnerabilities through public GitHub issues.**

Instead, please report security vulnerabilities to:

**Email**: [security@adcontextprotocol.org](mailto:security@adcontextprotocol.org)

Include the following information:
- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact assessment
- Any suggested fixes or mitigations

### 📧 **What to Include**

A good security report should include:

1. **Summary**: Brief description of the vulnerability
2. **Impact**: What could an attacker accomplish?
3. **Reproduction**: Step-by-step instructions to reproduce
4. **Evidence**: Screenshots, logs, or proof-of-concept code
5. **Mitigation**: Suggested fixes or workarounds

### ⏱️ **Response Timeline**

We will acknowledge receipt of your vulnerability report within **48 hours** and provide a more detailed response within **7 days** indicating our plan for addressing the issue.

### 🎯 **Scope**

Security issues we're particularly interested in:

- **Authentication bypass** - Circumventing token validation
- **SSRF vulnerabilities** - Accessing internal services
- **Code injection** - Executing arbitrary code
- **Data exfiltration** - Accessing sensitive information
- **DoS attacks** - Overwhelming the client or agents
- **Man-in-the-middle** - Intercepting communications

### 📋 **Out of Scope**

The following are generally **not** considered security vulnerabilities:

- Rate limiting bypass (circuit breakers are for reliability, not security)
- Client-side issues in the testing UI (it's for development/testing only)
- Social engineering attacks
- Issues requiring physical access to the machine
- Issues in third-party dependencies (report to them directly)

## Security Updates

### 🚀 **Release Process**

Security fixes follow this process:

1. **Assessment**: Evaluate severity and impact
2. **Fix Development**: Create and test fix in private
3. **Security Advisory**: Prepare advisory with details
4. **Release**: Publish patched version immediately
5. **Notification**: Notify users through multiple channels

### 📢 **Notification Channels**

Security updates are announced through:

- GitHub Security Advisories
- NPM package releases with security tags
- Email to security@adcontextprotocol.org subscribers
- Discord #security-announcements channel

### 🏷️ **Severity Levels**

| Level | Criteria | Response Time |
|-------|----------|---------------|
| **Critical** | Remote code execution, authentication bypass | 24 hours |
| **High** | Data exposure, privilege escalation | 72 hours |
| **Medium** | DoS, information disclosure | 1 week |
| **Low** | Minor information leaks | 2 weeks |

## Threat Model

### 🎯 **Assets We Protect**

- **Authentication tokens** - API keys and bearer tokens
- **Agent communications** - Request/response data
- **User applications** - Code using our library
- **Infrastructure** - Agents and services we connect to

### 👤 **Threat Actors**

- **Malicious agents** - Compromised or malicious AdCP agents
- **Network attackers** - Man-in-the-middle attacks
- **Malicious users** - Users of the library with bad intentions
- **Supply chain attacks** - Compromised dependencies

### 🛡️ **Mitigations**

| Threat | Mitigation |
|--------|------------|
| Malicious agent responses | Response validation, schema checking |
| SSRF attacks | URL validation, IP range blocking |
| Token exposure | Environment variables, secure logging |
| DoS attacks | Rate limiting, timeouts, circuit breakers |
| MITM attacks | HTTPS enforcement, certificate validation |
| Code injection | Input sanitization, type safety |

## Responsible Disclosure

We believe in responsible disclosure and will:

- Acknowledge security researchers who report vulnerabilities
- Work with researchers to understand and fix issues
- Provide credit in security advisories (unless requested otherwise)
- Maintain confidentiality until patches are released

### 🏆 **Hall of Fame**

Security researchers who have helped improve @adcp/client security:

- *Your name here!* - Report your first vulnerability to get listed

## Compliance & Standards

### 📜 **Standards We Follow**

- **OWASP Top 10** - Web application security risks
- **NIST Cybersecurity Framework** - Risk management
- **ISO 27001** - Information security management
- **SOC 2 Type II** - Security controls and compliance

### 🔍 **Security Audits**

We conduct regular security audits:

- **Code reviews** - All changes reviewed for security implications
- **Dependency audits** - Regular `npm audit` and security updates
- **Penetration testing** - Annual third-party security assessments
- **Static analysis** - Automated security scanning in CI/CD

---

**Last Updated**: September 20, 2025

For questions about this security policy, contact: [security@adcontextprotocol.org](mailto:security@adcontextprotocol.org)