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

function isCredentialName(name: string): boolean {
  return DEFAULT_CREDENTIAL_PATTERNS.some(rx => rx.test(name));
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
 *   - Destructured first param: `({ access_token }) => …` (flagged directly
 *     at the destructure)
 *
 * Returns `null` when the function takes no params; the caller skips.
 */
function firstParamIdentifierName(
  fn: TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration
): string | null {
  const first = fn.params[0];
  if (!first) return null;
  if (first.type === AST_NODE_TYPES.Identifier) return first.name;
  // ObjectPattern / AssignmentPattern wrapping an Identifier — destructure
  // cases are caught by the ObjectPattern scan below, not here.
  return null;
}

/**
 * If the function's first parameter is an ObjectPattern (destructured),
 * return the list of property names destructured. `({ access_token, foo })`
 * → `['access_token', 'foo']`. Used to flag the destructure form, which
 * never reaches a MemberExpression access.
 */
function destructuredKeys(
  fn: TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration
): { name: string; node: TSESTree.Node }[] {
  const first = fn.params[0];
  if (!first || first.type !== AST_NODE_TYPES.ObjectPattern) return [];
  const out: { name: string; node: TSESTree.Node }[] = [];
  for (const prop of first.properties) {
    if (prop.type !== AST_NODE_TYPES.Property) continue;
    const key = prop.key;
    if (key.type === AST_NODE_TYPES.Identifier) {
      out.push({ name: key.name, node: key });
    } else if (key.type === AST_NODE_TYPES.Literal && typeof key.value === 'string') {
      out.push({ name: key.value, node: key });
    }
  }
  return out;
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
 *   - Function declaration: `function extractContext(args) { … }`
 */
function methodNameForFunction(
  fn: TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration
): string | null {
  if (fn.type === AST_NODE_TYPES.FunctionDeclaration && fn.id) {
    return fn.id.name;
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

export default createRule<[], MessageIds>({
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
    schema: [],
  },
  defaultOptions: [],
  create(context) {
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

        // Destructure form: `({ access_token, ... }) => …` — flag at the
        // destructure site directly. MemberExpression traversal can't see
        // these because the access never happens.
        for (const { name, node } of destructuredKeys(fn)) {
          if (isCredentialName(name)) {
            context.report({
              node,
              messageId: 'credentialReadFromArgs',
              data: { path: `args.${name}` },
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
