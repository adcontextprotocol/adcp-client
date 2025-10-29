# Contributing to @adcp/client

We love your input! We want to make contributing to the AdCP client library as easy and transparent as possible, whether it's:

- Reporting a bug
- Discussing the current state of the code
- Submitting a fix
- Proposing new features
- Becoming a maintainer

## Intellectual Property Rights
Before contributing to the AdCP project, ensure that you have read and agree with our [Intellectual Property Rights Policy](https://github.com/adcontextprotocol/adcp/blob/main/IPR_POLICY.md).

## Development Process

We use GitHub to host code, to track issues and feature requests, as well as accept pull requests.

### 1. Fork and Clone

```bash
# Fork the repository on GitHub, then:
git clone https://github.com/your-username/adcp-client.git
cd adcp-client
npm install
```

### 2. Set Up Development Environment

```bash
# Install dependencies
npm install

# Run the test suite
npm test

# Start the development server (testing UI)
npm run dev

# Build the library
npm run build:lib

# Build everything (library + server)
npm run build
```

## Project Structure

```
├── src/
│   ├── lib/               # Core library code (published to NPM)
│   │   ├── index.ts       # Main library exports
│   │   ├── types/         # TypeScript type definitions
│   │   ├── protocols/     # MCP/A2A protocol implementations
│   │   ├── auth/          # Authentication helpers
│   │   ├── validation/    # Validation utilities
│   │   └── utils/         # Shared utilities
│   ├── server/            # Testing framework (not published)
│   └── public/            # Web UI assets
├── examples/              # Usage examples
├── test/                  # Test files
└── docs/                  # Additional documentation
```

## Development Guidelines

### Code Style

- **TypeScript**: All new code should be written in TypeScript
- **ESLint**: Follow the existing linting rules
- **Prettier**: Format code with Prettier (automatically on commit)
- **JSDoc**: Add comprehensive documentation for all public APIs

### Library vs Server Code

**Library Code (`src/lib/`)**:
- Must be framework-agnostic
- Minimal dependencies (only protocol SDKs)
- Pure functions where possible
- Comprehensive error handling
- Full TypeScript types

**Server Code (`src/server/`)**:
- Can use web frameworks (Fastify, Express)
- Server-specific dependencies
- Primarily for testing/demo purposes

### Testing

- **Unit tests** for all library functions
- **Integration tests** for protocol implementations
- **End-to-end tests** for the complete workflow
- Tests should be in `test/` directory
- Use Node.js built-in test runner

```bash
# Run all tests
npm test

# Run specific test file
npm test test/client.test.js

# Run tests with coverage
npm run test:coverage
```

### Commit Messages

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation changes
- `style:` formatting, missing semicolons, etc.
- `refactor:` code changes that neither fix bugs nor add features
- `test:` adding tests
- `chore:` updating build tasks, package manager configs, etc.

Examples:
```bash
feat: add request interceptors for custom processing
fix: handle MCP connection timeouts gracefully
docs: update README with new authentication examples
test: add unit tests for circuit breaker functionality
```

## Pull Request Process

### 1. Create a Feature Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/issue-description
```

### 2. Make Your Changes

- Follow the coding guidelines above
- Add tests for new functionality
- Update documentation as needed
- Ensure all tests pass

### 3. Test Your Changes

```bash
# Run the full test suite
npm test

# Test the library build
npm run build:lib

# Test the complete build
npm run build

# Start the dev server to test manually
npm run dev
```

### 4. Update Documentation

- Update the README if you've changed the API
- Add JSDoc comments for new public methods
- Update examples if needed
- Add entry to CHANGELOG.md

### 5. Submit Pull Request

- Push your branch to your fork
- Create a pull request from your branch to our `main` branch
- Fill out the pull request template
- Link any related issues

### Pull Request Requirements

Your PR will be reviewed for:

✅ **Code Quality**
- Follows TypeScript best practices
- Has comprehensive error handling
- Includes appropriate logging
- No console.log statements in library code

✅ **Testing**
- All existing tests pass
- New tests for new functionality
- Tests cover edge cases
- Integration tests for protocol changes

✅ **Documentation**
- JSDoc comments for all public APIs
- README updates for API changes
- Examples demonstrate new features
- CHANGELOG.md entry

✅ **Compatibility**
- Works with Node.js >=18.0.0
- Compatible with both CommonJS and ESM
- No breaking changes without major version bump
- Backward compatible when possible

## Bug Reports

Great bug reports tend to have:

- A quick summary and/or background
- Steps to reproduce
  - Be specific!
  - Give sample code if you can
- What you expected would happen
- What actually happens
- Notes (possibly including why you think this might be happening, or stuff you tried that didn't work)

Use our [bug report template](https://github.com/your-org/adcp-client/issues/new?template=bug_report.md).

## Feature Requests

We love feature requests! Please:

- Check if the feature already exists or is planned
- Explain the problem you're trying to solve
- Provide use cases and examples
- Consider if this belongs in the core library or as a plugin

Use our [feature request template](https://github.com/your-org/adcp-client/issues/new?template=feature_request.md).

## API Design Principles

When contributing to the library API:

### 1. **Developer Experience First**
- APIs should be intuitive and hard to misuse
- Provide sensible defaults
- Clear error messages with actionable advice

### 2. **Type Safety**
- Use TypeScript extensively
- Avoid `any` types
- Provide generic type parameters where helpful

### 3. **Protocol Agnostic**
- Library users shouldn't need to know about MCP vs A2A differences
- Hide protocol complexity behind clean abstractions
- Consistent error handling across protocols

### 4. **Performance Conscious**
- Avoid unnecessary object creation
- Use connection pooling where appropriate
- Implement timeouts and circuit breakers

### 5. **Security First**
- Validate all inputs
- Prevent SSRF attacks
- Handle authentication securely
- No secrets in logs

## Architecture Decisions

### Protocol Abstraction

The library provides protocol-agnostic APIs while supporting both MCP and A2A:

```typescript
// ✅ Good: Protocol-agnostic
const result = await client.callTool('agent-id', 'get_products', args);

// ❌ Avoid: Protocol-specific
const mcpResult = await mcpClient.callTool(args);
const a2aResult = await a2aClient.sendMessage(payload);
```

### Error Handling

Use consistent error handling patterns:

```typescript
// ✅ Good: Structured error responses
interface TestResult {
  success: boolean;
  data?: any;
  error?: string;
  debug_logs?: any[];
}

// ❌ Avoid: Throwing exceptions for expected failures
throw new Error('Agent returned no products');
```

### Configuration

Prefer environment-based configuration:

```typescript
// ✅ Good: Environment configuration
const agents = ConfigurationManager.loadAgentsFromEnv();

// ✅ Also good: Explicit configuration
const agents: AgentConfig[] = [{ id: 'test', ... }];

// ❌ Avoid: Hardcoded configuration
const agent = { agent_uri: 'https://hardcoded.example.com' };
```

## Release Process

1. Update version in `package.json`
2. Update `CHANGELOG.md` with new features/fixes
3. Create release PR
4. Tag release after merge
5. Publish to NPM (maintainers only)

## Getting Help

- **Discord**: Join our [Discord server](https://discord.gg/adcp) for real-time help
- **Issues**: Use GitHub issues for bugs and feature requests
- **Email**: Contact maintainers at [maintainers@adcontextprotocol.org](mailto:maintainers@adcontextprotocol.org)
- **Documentation**: Check the [API docs](./API.md) and [examples](./examples/)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). By participating, you're expected to uphold this code.

## License

By contributing, you agree that your contributions will be licensed under the same [Apache 2.0 License](./LICENSE) that covers the project.

## Recognition

Contributors are recognized in:
- README.md contributor section
- Release notes for their contributions
- Annual contributor highlights

Thank you for contributing to the AdCP ecosystem! 🚀
