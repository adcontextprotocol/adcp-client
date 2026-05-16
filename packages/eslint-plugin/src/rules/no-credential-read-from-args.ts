/**
 * Flag credential-shaped reads off the buyer-supplied `args` bag inside
 * platform method implementations.
 *
 * Adopters keep reading `args.<vendor>_access_token` (and similar) inside
 * `extractContext` / `synthesizeFromArgs`, silently trusting buyer-supplied
 * identity material. The SDK's `credentialPolicy: 'authInfo-only'` catches
 * this at dispatch; this rule catches it at code-write time.
 *
 * Detection is method-name keyed (`extractContext`, `synthesizeFromArgs`),
 * not interface-type keyed — TypeScript type-graph analysis is unreliable
 * against duck-typed `definePlatform` shapes and class methods that don't
 * `implements` the interface explicitly.
 *
 * Credential-name patterns are the {@link DEFAULT_CREDENTIAL_PATTERNS}
 * exported from `@adcp/sdk/server`. Importing the constant directly keeps
 * the rule and the runtime guard in lockstep — adding a regex to the SDK
 * surfaces it at lint time automatically on next adopter `npm install`.
 *
 * @see adcontextprotocol/adcp-client#1541
 */

import { ESLintUtils, AST_NODE_TYPES, TSESTree } from '@typescript-eslint/utils';
import { DEFAULT_CREDENTIAL_PATTERNS } from '@adcp/sdk/server';

const FLAGGED_METHOD_NAMES = new Set(['extractContext', 'synthesizeFromArgs']);

const createRule = ESLintUtils.RuleCreator(
  name => `https://github.com/adcontextprotocol/adcp-client/blob/main/packages/eslint-plugin/README.md#${name}`
);

type MessageIds = 'credentialReadFromArgs';

type Options = [
  {
    additionalPatterns?: string[];
  }?,
];

/**
 * Build the active pattern set from the SDK defaults plus any
 * adopter-supplied `additionalPatterns`. Adopters using
 * `credentialPolicy.patterns.extend(...)` at runtime mirror the same
 * strings here for lint parity. A fully-replaceable
 * `credentialPolicy.matcher` function has no lint analogue — that's a
 * known gap documented in the README.
 */
function buildPatternMatcher(extra: string[]): (name: string) => boolean {
  const extraRegexes = extra.map(p => new RegExp(p, 'i'));
  const patterns = [...DEFAULT_CREDENTIAL_PATTERNS, ...extraRegexes];
  return (name: string) => patterns.some(rx => rx.test(name));
}

/**
 * Return the property name from a MemberExpression's `property` slot when
 * the access is a plain identifier (`foo.bar`) or a string-literal computed
 * access (`foo['bar']`). Returns `null` for dynamic / non-literal accesses
 * — the rule cannot statically evaluate those and stays silent rather than
 * false-positive.
 */
function propertyNameOf(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (node.computed && node.property.type === AST_NODE_TYPES.Literal && typeof node.property.value === 'string') {
    return node.property.value;
  }
  return null;
}

/**
 * Walk an arbitrary expression and return `true` when it bottoms out on
 * `<argsParamName>` — handles direct reference, `args.<x>`, and
 * `args.<x>.<y>` chains. The rule fires when ANY MemberExpression in
 * the chain reads a credential-shaped key, so detection is per-segment;
 * this helper is the "is this rooted at args?" check used to scope the
 * traversal.
 */
function isRootedAtIdentifier(expr: TSESTree.Expression, name: string): boolean {
  let cur: TSESTree.Expression = expr;
  while (cur.type === AST_NODE_TYPES.MemberExpression) {
    cur = cur.object as TSESTree.Expression;
  }
  return cur.type === AST_NODE_TYPES.Identifier && cur.name === name;
}

/**
 * Extract the parameter name to scan for. The platform-method shape is
 * `(args, ctx) => …` or `(args: SomeArgs, ctx) => …`. We key on the
 * first parameter regardless of declared type — the rule is structural.
 *
 * Handles:
 *   - Plain identifier: `(args) => …`
 *   - Typed identifier: `(args: Foo) => …`
 *   - Default-value: `(args = {}) => …` — unwrap `AssignmentPattern.left`
 *   - Destructured first param: `({ access_token }) => …` (flagged via
 *     the destructure scan, not via this name)
 *   - Destructured with default: `({ access_token } = {}) => …` (same)
 *
 * Returns `null` when the function takes no params or when the first
 * param has no nameable identifier (pure destructure).
 */
function firstParamIdentifierName(
  fn: TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration
): string | null {
  const first = fn.params[0];
  if (!first) return null;
  if (first.type === AST_NODE_TYPES.Identifier) return first.name;
  if (first.type === AST_NODE_TYPES.AssignmentPattern) {
    const left = first.left;
    if (left.type === AST_NODE_TYPES.Identifier) return left.name;
  }
  // ObjectPattern / ArrayPattern — destructure cases are caught by the
  // ObjectPattern scan below, not here.
  return null;
}

/**
 * Walk the first parameter's `ObjectPattern` (including when wrapped in
 * an `AssignmentPattern` for default-value forms like
 * `({ access_token } = {})`) and collect every destructured key, including
 * nested patterns. Reports paths like `args.context.access_token` so the
 * error message reflects the depth of the destructure.
 *
 * Recurses through nested `ObjectPattern`s (`{ context: { access_token } }`)
 * and handles renamed properties (`{ access_token: tok }` — fires on
 * `access_token`, the source key, not the alias). `RestElement` is
 * recorded as a binding but never matched against credential patterns:
 * the post-extraction `rest.access_token` read is an aliasing pattern
 * documented as out-of-scope.
 */
function destructuredKeys(
  fn: TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration
): { path: string; node: TSESTree.Node }[] {
  const first = fn.params[0];
  if (!first) return [];

  let pattern: TSESTree.Node = first;
  if (pattern.type === AST_NODE_TYPES.AssignmentPattern) {
    pattern = pattern.left;
  }
  if (pattern.type !== AST_NODE_TYPES.ObjectPattern) return [];

  const out: { path: string; node: TSESTree.Node }[] = [];
  collectObjectPatternKeys(pattern, ['args'], out);
  return out;
}

/**
 * Walk an ObjectPattern's properties, recursing into nested
 * ObjectPatterns. `pathSoFar` accumulates the dotted-path segments used
 * to render the error message (e.g. `['args', 'context']` →
 * `args.context.access_token`).
 */
function collectObjectPatternKeys(
  pattern: TSESTree.ObjectPattern,
  pathSoFar: string[],
  out: { path: string; node: TSESTree.Node }[]
): void {
  for (const prop of pattern.properties) {
    if (prop.type === AST_NODE_TYPES.RestElement) continue;
    if (prop.type !== AST_NODE_TYPES.Property) continue;

    const keyName = propertyKeyName(prop.key, prop.computed);
    if (keyName === null) continue;

    // `prop.value` is the binding target — either an Identifier (plain or
    // renamed), an ObjectPattern (nested destructure), or an
    // AssignmentPattern wrapping either of those.
    let valueNode: TSESTree.Node = prop.value;
    if (valueNode.type === AST_NODE_TYPES.AssignmentPattern) {
      valueNode = valueNode.left;
    }

    if (valueNode.type === AST_NODE_TYPES.ObjectPattern) {
      collectObjectPatternKeys(valueNode, [...pathSoFar, keyName], out);
      continue;
    }

    // Leaf binding — report at the source key (`prop.key`), not the
    // alias (`prop.value`), so the error highlights the credential name
    // the buyer would supply, not the local variable name the adopter
    // chose.
    out.push({
      path: [...pathSoFar, keyName].join('.'),
      node: prop.key,
    });
  }
}

function propertyKeyName(key: TSESTree.PropertyName | TSESTree.Expression, computed: boolean): string | null {
  if (!computed && key.type === AST_NODE_TYPES.Identifier) return key.name;
  if (key.type === AST_NODE_TYPES.Literal && typeof key.value === 'string') return key.value;
  return null;
}

/**
 * Return the method name for any function node, when that function is
 * itself the value of a property / method in an object literal or a class
 * body. Returns `null` for free-standing function declarations or
 * arrow-callback expressions whose enclosing context isn't a method
 * binding. The rule fires only when this returns a name in
 * {@link FLAGGED_METHOD_NAMES}.
 *
 * Cases handled:
 *   - Object property: `{ extractContext: (args) => … }` / `{ extractContext(args) { … } }`
 *   - Class method: `class Foo { extractContext(args) { … } }`
 *
 * `FunctionDeclaration`s (`function extractContext(args) { … }`) are
 * intentionally NOT matched — free-standing functions named
 * `extractContext` are rare and the false-positive cost outweighs the
 * duck-typed coverage win.
 */
function methodNameForFunction(
  fn: TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration
): string | null {
  if (fn.type === AST_NODE_TYPES.FunctionDeclaration) {
    return null;
  }
  const parent = (fn as unknown as { parent?: TSESTree.Node }).parent;
  if (!parent) return null;

  if (parent.type === AST_NODE_TYPES.Property) {
    const key = parent.key;
    if (!parent.computed && key.type === AST_NODE_TYPES.Identifier) return key.name;
    if (key.type === AST_NODE_TYPES.Literal && typeof key.value === 'string') return key.value;
    return null;
  }

  if (parent.type === AST_NODE_TYPES.MethodDefinition) {
    const key = parent.key;
    if (!parent.computed && key.type === AST_NODE_TYPES.Identifier) return key.name;
    if (key.type === AST_NODE_TYPES.Literal && typeof key.value === 'string') return key.value;
    return null;
  }

  return null;
}

export default createRule<Options, MessageIds>({
  name: 'no-credential-read-from-args',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow reading credential-shaped keys off the buyer-supplied args bag inside extractContext / synthesizeFromArgs.',
    },
    messages: {
      credentialReadFromArgs:
        'Reading credential-shaped key {{path}} from `args` trusts buyer-supplied identity. Re-derive bearers per request from `ctx.authInfo` + your token cache; embed only non-secret upstream IDs in `args`.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          additionalPatterns: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Extra regex patterns appended to DEFAULT_CREDENTIAL_PATTERNS. Mirror your credentialPolicy.patterns.extend contents here for lint parity.',
          },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{}],
  create(context) {
    const options = context.options[0] ?? {};
    const isCredentialName = buildPatternMatcher(options.additionalPatterns ?? []);

    /**
     * Stack of `{ argsParamName }` frames for the platform methods we're
     * currently inside. The rule fires only when the stack is non-empty.
     * Nested functions inside a flagged method inherit the parent frame;
     * arrow callbacks that close over `args` still trip the scan.
     */
    const stack: { argsParamName: string | null }[] = [];

    function enterFunction(
      fn: TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration
    ): void {
      const methodName = methodNameForFunction(fn);
      if (methodName !== null && FLAGGED_METHOD_NAMES.has(methodName)) {
        const argsParamName = firstParamIdentifierName(fn);
        stack.push({ argsParamName });

        // Destructure form: `({ access_token, ... }) => …` (with or
        // without an `AssignmentPattern` default-value wrapper, and
        // including nested patterns) — flag at each leaf destructure
        // site. MemberExpression traversal can't see these because the
        // access never happens.
        for (const { path, node } of destructuredKeys(fn)) {
          // `path` is `args.<...>.<key>`; the leaf segment is the key
          // whose name decides credential-shape.
          const segments = path.split('.');
          const leaf = segments[segments.length - 1];
          if (leaf && isCredentialName(leaf)) {
            context.report({
              node,
              messageId: 'credentialReadFromArgs',
              data: { path },
            });
          }
        }
      }
    }

    function exitFunction(
      fn: TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration
    ): void {
      const methodName = methodNameForFunction(fn);
      if (methodName !== null && FLAGGED_METHOD_NAMES.has(methodName)) {
        stack.pop();
      }
    }

    function currentFrame(): { argsParamName: string | null } | null {
      if (stack.length === 0) return null;
      return stack[stack.length - 1] ?? null;
    }

    return {
      FunctionDeclaration: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      FunctionExpression: enterFunction,
      'FunctionExpression:exit': exitFunction,
      ArrowFunctionExpression: enterFunction,
      'ArrowFunctionExpression:exit': exitFunction,

      VariableDeclarator(node: TSESTree.VariableDeclarator): void {
        const frame = currentFrame();
        if (!frame || frame.argsParamName === null) return;

        // Only handle `const { ... } = args` shapes — the args parameter
        // name has to appear on the right-hand side as an Identifier.
        if (!node.init || node.init.type !== AST_NODE_TYPES.Identifier) return;
        if (node.init.name !== frame.argsParamName) return;
        if (node.id.type !== AST_NODE_TYPES.ObjectPattern) return;

        const out: { path: string; node: TSESTree.Node }[] = [];
        collectObjectPatternKeys(node.id, [frame.argsParamName], out);
        for (const entry of out) {
          const segments = entry.path.split('.');
          const leaf = segments[segments.length - 1];
          if (leaf && isCredentialName(leaf)) {
            context.report({
              node: entry.node,
              messageId: 'credentialReadFromArgs',
              data: { path: entry.path },
            });
          }
        }
      },

      MemberExpression(node: TSESTree.MemberExpression): void {
        const frame = currentFrame();
        if (!frame || frame.argsParamName === null) return;

        // Only scan accesses rooted at the args parameter.
        if (!isRootedAtIdentifier(node.object as TSESTree.Expression, frame.argsParamName)) {
          return;
        }

        const propName = propertyNameOf(node);
        if (propName === null) return;
        if (!isCredentialName(propName)) return;

        // Reconstruct the dotted path for the error message. Walk from the
        // member expression's leftmost identifier through each step.
        const segments: string[] = [];
        let cur: TSESTree.Expression = node;
        while (cur.type === AST_NODE_TYPES.MemberExpression) {
          const seg = propertyNameOf(cur);
          if (seg === null) {
            // Dynamic segment in the middle of the chain — bail; the error
            // message would be misleading. The current node's read is still
            // flagged on the way back up if it itself matches.
            segments.unshift('<dynamic>');
          } else {
            segments.unshift(seg);
          }
          cur = cur.object as TSESTree.Expression;
        }
        const path = `${frame.argsParamName}.${segments.join('.')}`;

        context.report({
          node,
          messageId: 'credentialReadFromArgs',
          data: { path },
        });
      },
    };
  },
});
