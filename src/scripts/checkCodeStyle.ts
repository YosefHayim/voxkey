import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { globSync } from "glob";
import ts from "typescript";
import { checkRuleCards } from "./checkRuleCards.js";

type CodeStyleViolation = {
  ruleId: string;
  file: string;
  line: number;
  message: string;
};

// Tooling answers to the shape rules; the application also answers to the boundary rules.
type FileKind = "application" | "tooling" | "root";

const KIND_BY_PREFIX: ReadonlyArray<readonly [string, FileKind]> = [
  ["src/scripts/", "tooling"],
  ["src/", "application"],
];

const fileKind = (file: string): FileKind => KIND_BY_PREFIX.find(([prefix]) => file.startsWith(prefix))?.[1] || "root";

const MAINTAINED: ReadonlyArray<FileKind> = ["application", "tooling"];

const failConfiguration = (message: string): never => {
  throw new Error(`Invalid code-style configuration: ${message}`);
};

const assertRuleCardsConform = (repositoryRoot: string): void => {
  const violations = checkRuleCards({ guide: readFileSync(join(repositoryRoot, "CODE-STYLE.md"), "utf8") });
  if (violations.length > 0) {
    const lines = violations.map((violation) => `  CODE-STYLE.md:${violation.line} ${violation.message}`);
    failConfiguration(`CODE-STYLE.md does not match the rule-card format:\n${lines.join("\n")}`);
  }
};

const isCallOn = (node: ts.Node, callee: { owner: string; method: RegExp }): boolean =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === callee.owner &&
  callee.method.test(node.expression.name.text);

const isNonArrowFunction = (
  node: ts.Node,
): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.MethodDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);

const isEffectGenCallback = (node: ts.FunctionDeclaration | ts.FunctionExpression | ts.MethodDeclaration): boolean => {
  const call = node.parent;
  return (
    ts.isFunctionExpression(node) &&
    !node.name &&
    ts.isCallExpression(call) &&
    call.arguments[0] === node &&
    isCallOn(call, { owner: "Effect", method: /^gen$/u })
  );
};

const isSchemaTaggedError = (expression: ts.Expression): boolean => {
  if (ts.isCallExpression(expression) || ts.isParenthesizedExpression(expression)) {
    return isSchemaTaggedError(expression.expression);
  }

  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Schema" &&
    expression.name.text === "TaggedError"
  );
};

const extendsSchemaTaggedError = (node: ts.ClassLikeDeclaration): boolean => {
  const base = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
  return base !== undefined && isSchemaTaggedError(base.expression);
};

const nearestStatement = (node: ts.Node): ts.Node => {
  if (ts.isStatement(node) || ts.isVariableDeclaration(node)) {
    return node;
  }

  return node.parent ? nearestStatement(node.parent) : node;
};

const precedingComment = (sourceFile: ts.SourceFile, node: ts.Node) =>
  ts.getLeadingCommentRanges(sourceFile.text, nearestStatement(node).getFullStart())?.at(-1);

const hasProofCommentAbove = (sourceFile: ts.SourceFile, node: ts.Node): boolean => {
  const comment = precedingComment(sourceFile, node);
  // Only whitespace and a single line break may sit between the proof and the statement.
  return (
    comment !== undefined &&
    /^[ \t]*\r?\n[ \t]*$/u.test(sourceFile.text.slice(comment.end, nearestStatement(node).getStart(sourceFile)))
  );
};

const hasExternalTypeProof = (sourceFile: ts.SourceFile, node: ts.Node): boolean => {
  const comment = precedingComment(sourceFile, node);
  return (
    comment !== undefined &&
    /external type|upstream|issue\s+#?\d+|https:\/\//iu.test(sourceFile.text.slice(comment.pos, comment.end))
  );
};

const isConstAssertion = (node: ts.AsExpression): boolean =>
  ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === "const";

const isControlNode = (node: ts.Node): boolean =>
  ts.isIfStatement(node) ||
  ts.isSwitchStatement(node) ||
  ts.isTryStatement(node) ||
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node) ||
  ts.isWhileStatement(node) ||
  ts.isDoStatement(node);

const nestingDepth = (node: ts.Node): number => {
  const parent = node.parent;
  if (!parent || ts.isFunctionLike(parent)) {
    return 1;
  }

  const isElseIf = ts.isIfStatement(parent) && parent.elseStatement === node && ts.isIfStatement(node);
  return nestingDepth(parent) + (isControlNode(parent) && !isElseIf ? 1 : 0);
};

const isFunctionStatement = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  (ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (declaration) => declaration.initializer !== undefined && ts.isArrowFunction(declaration.initializer),
    ));

const previousStatement = (node: ts.Node): ts.Statement | undefined => {
  const parent = node.parent;
  if (!ts.isStatement(node) || !parent || !(ts.isSourceFile(parent) || ts.isBlock(parent))) {
    return undefined;
  }

  return parent.statements[parent.statements.indexOf(node) - 1];
};

const lacksBlankLineAfterFunction = (node: ts.Node, sourceFile: ts.SourceFile): boolean => {
  const previous = isFunctionStatement(node) ? previousStatement(node) : undefined;
  if (!previous || !isFunctionStatement(previous)) {
    return false;
  }

  const gap = sourceFile.text.slice(previous.end, node.getStart(sourceFile));
  return (gap.match(/\r?\n/gu) || []).length < 2;
};

type ExecutableFunction =
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.GetAccessorDeclaration
  | ts.MethodDeclaration
  | ts.SetAccessorDeclaration;

const isExecutableFunction = (node: ts.Node): node is ExecutableFunction =>
  isNonArrowFunction(node) ||
  ts.isArrowFunction(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

const hasInvalidInputShape = (node: ExecutableFunction): boolean =>
  node.parameters.length > 2 ||
  node.parameters.some(
    (parameter) =>
      Boolean(parameter.dotDotDotToken) ||
      parameter.type?.kind === ts.SyntaxKind.BooleanKeyword ||
      parameter.initializer?.kind === ts.SyntaxKind.TrueKeyword ||
      parameter.initializer?.kind === ts.SyntaxKind.FalseKeyword,
  );

const hasExportModifier = (node: ts.TypeAliasDeclaration): boolean =>
  Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));

// Service shapes hold only functions, which no Schema can describe.
const isFunctionOnlyType = (typeLiteral: ts.TypeLiteralNode): boolean =>
  typeLiteral.members.length > 0 &&
  typeLiteral.members.every(
    (member) =>
      ts.isMethodSignature(member) ||
      (ts.isPropertySignature(member) && member.type !== undefined && ts.isFunctionTypeNode(member.type)),
  );

const MUTATING_METHODS = new Set(
  "add clear copyWithin delete fill pop push reverse set shift sort splice unshift".split(" "),
);

const mutationTarget = (node: ts.Node): ts.Expression | undefined => {
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment ? node.left : undefined;
  }

  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return node.operand;
  }

  if (ts.isDeleteExpression(node)) {
    return node.expression;
  }

  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    return MUTATING_METHODS.has(node.expression.name.text) ? node.expression.expression : undefined;
  }

  return undefined;
};

const rootIdentifier = (expression: ts.Expression): ts.Identifier | undefined => {
  if (ts.isIdentifier(expression)) {
    return expression;
  }

  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return rootIdentifier(expression.expression);
  }

  return undefined;
};

const isInsideParameter = (node: ts.Node): boolean => {
  if (ts.isParameter(node)) {
    return true;
  }

  if (ts.isVariableDeclaration(node) || ts.isCatchClause(node) || isExecutableFunction(node) || ts.isSourceFile(node)) {
    return false;
  }

  return node.parent ? isInsideParameter(node.parent) : false;
};

const mutatesInput = (node: ts.Node, typeChecker: ts.TypeChecker): boolean => {
  const target = mutationTarget(node);
  const root = target && rootIdentifier(target);
  return Boolean(root && typeChecker.getSymbolAtLocation(root)?.declarations?.some(isInsideParameter));
};

const FORBIDDEN_NAME_TOKENS = new Set(
  "body data final info outcome payload raw response result results temp tmp".split(" "),
);

const hasForbiddenNameToken = (identifier: string): boolean =>
  identifier
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .some((word) => FORBIDDEN_NAME_TOKENS.has(word.toLowerCase()));

const isBindingName = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent)) {
    return parent.name === node && parent.propertyName !== undefined;
  }

  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  );
};

// `typeof value === "string"` and friends: a hand-rolled reader that a Schema decoder replaces.
const isTypeofComparison = (node: ts.Node): boolean =>
  ts.isBinaryExpression(node) &&
  [
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ].includes(node.operatorToken.kind) &&
  (ts.isTypeOfExpression(node.left) || ts.isTypeOfExpression(node.right));

type NodeCheck = { node: ts.Node; file: string; sourceFile: ts.SourceFile; typeChecker: ts.TypeChecker };

type NodeRule = {
  ruleId: string;
  kinds: ReadonlyArray<FileKind>;
  message: string | ((node: ts.Node) => string);
  matches: (check: NodeCheck) => boolean;
};

const NODE_RULES: ReadonlyArray<NodeRule> = [
  {
    ruleId: "function.arrow-only",
    kinds: MAINTAINED,
    message: "Use an arrow function instead of a declaration, method, or function expression.",
    matches: ({ node }) => isNonArrowFunction(node) && !node.asteriskToken,
  },
  {
    ruleId: "function.effect-generator",
    kinds: MAINTAINED,
    message: "Anonymous generators are allowed only as the direct Effect.gen callback.",
    matches: ({ node }) => isNonArrowFunction(node) && Boolean(node.asteriskToken) && !isEffectGenCallback(node),
  },
  {
    ruleId: "function.input-shape",
    kinds: MAINTAINED,
    message: "Use at most two natural positional inputs, no rest input, and no positional boolean flag.",
    matches: ({ node }) => isExecutableFunction(node) && hasInvalidInputShape(node),
  },
  {
    ruleId: "function.blank-line",
    kinds: MAINTAINED,
    message: "Separate function declarations with one blank line.",
    matches: ({ node, sourceFile }) => lacksBlankLineAfterFunction(node, sourceFile),
  },
  {
    ruleId: "function.nesting",
    kinds: MAINTAINED,
    message: "Use a guard clause or extract a cohesive operation before a third nesting level.",
    matches: ({ node }) => isControlNode(node) && nestingDepth(node) > 2,
  },
  {
    ruleId: "class.tagged-error-only",
    kinds: MAINTAINED,
    message: "Classes are allowed only when they directly extend Schema.TaggedError.",
    matches: ({ node }) =>
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) && !extendsSchemaTaggedError(node),
  },
  {
    ruleId: "type.no-assertion",
    kinds: MAINTAINED,
    message: "Decode or narrow values instead of asserting a type.",
    matches: ({ node, sourceFile }) =>
      (ts.isAsExpression(node) && !isConstAssertion(node) && !hasExternalTypeProof(sourceFile, node)) ||
      ts.isTypeAssertionExpression(node) ||
      (ts.isNonNullExpression(node) && !ts.isElementAccessExpression(node.expression)),
  },
  {
    ruleId: "comment.index-proof",
    kinds: MAINTAINED,
    message: "Place the indexed-access proof comment immediately above this assertion.",
    matches: ({ node, sourceFile }) =>
      ts.isNonNullExpression(node) &&
      ts.isElementAccessExpression(node.expression) &&
      !hasProofCommentAbove(sourceFile, node),
  },
  {
    ruleId: "type.no-interface",
    kinds: MAINTAINED,
    message: "Use a Schema-derived or internal type unless external interoperation requires an interface.",
    matches: ({ node, file }) => ts.isInterfaceDeclaration(node) && !/\.d\.[cm]?ts$/u.test(file),
  },
  {
    ruleId: "type.no-enum",
    kinds: MAINTAINED,
    message: "Use schema literals or a literal union instead of an enum.",
    matches: ({ node }) => ts.isEnumDeclaration(node),
  },
  {
    ruleId: "type.no-conditional",
    kinds: MAINTAINED,
    message: "Authored conditional and infer type machinery is forbidden.",
    matches: ({ node }) => ts.isConditionalTypeNode(node),
  },
  {
    ruleId: "type.no-unsafe-any",
    kinds: MAINTAINED,
    message: "Use unknown at a trust boundary and prove the value before use.",
    matches: ({ node, sourceFile }) => node.kind === ts.SyntaxKind.AnyKeyword && !sourceFile.isDeclarationFile,
  },
  {
    ruleId: "type.schema-owned-runtime",
    kinds: ["application"],
    message: "Exported runtime object types must derive from an Effect Schema.",
    matches: ({ node }) =>
      ts.isTypeAliasDeclaration(node) &&
      hasExportModifier(node) &&
      ts.isTypeLiteralNode(node.type) &&
      !isFunctionOnlyType(node.type),
  },
  {
    ruleId: "type.decode-once",
    kinds: ["application"],
    message: "Decode the value with its Effect Schema instead of a hand-rolled typeof check.",
    matches: ({ node }) => isTypeofComparison(node),
  },
  {
    ruleId: "name.domain-specific",
    kinds: MAINTAINED,
    message: (node) => `Rename "${node.getText()}" for the domain value or job it represents.`,
    matches: ({ node }) => ts.isIdentifier(node) && isBindingName(node) && hasForbiddenNameToken(node.text),
  },
  {
    ruleId: "mutation.no-input",
    kinds: MAINTAINED,
    message: "Create a new value instead of mutating a function input.",
    matches: ({ node, typeChecker }) => mutatesInput(node, typeChecker),
  },
  {
    ruleId: "effect.no-promise-all",
    kinds: ["application"],
    message: "Use sequential Effect collection operators unless bounded concurrency is justified.",
    matches: ({ node }) => isCallOn(node, { owner: "Promise", method: /^all$/u }),
  },
  {
    ruleId: "effect.runtime-edge",
    kinds: ["application"],
    message: "Effect.run calls belong only at src/cli/main.ts.",
    matches: ({ node, file }) => file !== "src/cli/main.ts" && isCallOn(node, { owner: "Effect", method: /^run/u }),
  },
  {
    ruleId: "presentation.terminal-ui",
    kinds: ["application"],
    message: "Route application presentation through TerminalUI.",
    matches: ({ node }) => isCallOn(node, { owner: "console", method: /./u }),
  },
  {
    ruleId: "syntax.no-nullish",
    kinds: [...MAINTAINED, "root"],
    message: "Decode absence and defaults at the owning boundary instead of using `??`.",
    matches: ({ node }) =>
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken,
  },
];

type FileRule = { ruleId: string; message: string; matches: (file: string, sourceFile: ts.SourceFile) => boolean };

// Reported on line 1: they judge the file, not a node in it.
const FILE_RULES: ReadonlyArray<FileRule> = [
  {
    ruleId: "path.no-generic-bucket",
    message: "Use a filename that names the domain job.",
    matches: (file) =>
      /^(?:base|common|constants|core|helpers|index|misc|models|shared|types|utils)\.[cm]?[jt]sx?$/u.test(
        posix.basename(file),
      ),
  },
  {
    ruleId: "path.source-directory-case",
    message: "Authored source directories must use camelCase.",
    matches: (file) =>
      file
        .split("/")
        .slice(1, -1)
        .some((directory) => !/^[a-z][a-zA-Z0-9]*$/u.test(directory)),
  },
  {
    ruleId: "module.no-passive-barrel",
    message: "Import capabilities from their owning modules instead of maintaining a re-export module.",
    matches: (_file, sourceFile) =>
      sourceFile.statements.length > 0 && sourceFile.statements.every(ts.isExportDeclaration),
  },
];

const SUPPRESSION_DIRECTIVE =
  /(?:@ts-(?:ignore|expect-error|nocheck)|biome-ignore|prettier-ignore|eslint-disable(?:-next-line|-line)?|(?:c8|istanbul|v8)\s+ignore)\b/u;

const suppressionHasProof = (comment: string, file: string): boolean => {
  if (/issue\s+#?\d+|https:\/\//iu.test(comment)) {
    return true;
  }

  const explanation = comment.split("@ts-expect-error")[1]?.trim();
  return file.includes(".test.") && Boolean(explanation && explanation.length >= 12);
};

// Scan lexical comments so directive-looking strings stay ordinary text.
const unprovenSuppressionLines = (file: string, sourceFile: ts.SourceFile): ReadonlyArray<number> => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sourceFile.languageVariant, sourceFile.text);
  const lines: Array<number> = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const text = scanner.getTokenText();
    const isComment = token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia;
    if (isComment && SUPPRESSION_DIRECTIVE.test(text) && !suppressionHasProof(text, file)) {
      lines.push(sourceFile.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1);
    }
  }

  return lines;
};

const inspectFile = (request: {
  file: string;
  sourceFile: ts.SourceFile;
  typeChecker: ts.TypeChecker;
}): ReadonlyArray<CodeStyleViolation> => {
  const { file, sourceFile } = request;
  const kind = fileKind(file);
  const nodeRules = NODE_RULES.filter((rule) => rule.kinds.includes(kind));
  const violations: Array<CodeStyleViolation> = [];
  const visit = (node: ts.Node): void => {
    const check = { ...request, node };
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    violations.push(
      ...nodeRules
        .filter((rule) => rule.matches(check))
        .map((rule) => ({
          ruleId: rule.ruleId,
          file,
          line,
          message: typeof rule.message === "string" ? rule.message : rule.message(node),
        })),
    );
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  if (!MAINTAINED.includes(kind)) {
    return violations;
  }

  return [
    ...violations,
    ...FILE_RULES.filter((rule) => rule.matches(file, sourceFile)).map((rule) => ({
      ruleId: rule.ruleId,
      file,
      line: 1,
      message: rule.message,
    })),
    ...unprovenSuppressionLines(file, sourceFile).map((line) => ({
      ruleId: "type.no-suppression",
      file,
      line,
      message: "State the negative type contract or link the narrow external defect.",
    })),
  ];
};

export const checkCodeStyle = (repositoryRoot: string): ReadonlyArray<CodeStyleViolation> => {
  assertRuleCardsConform(repositoryRoot);

  const files = globSync(["src/**/*.{ts,tsx,js,mjs,mts,cts}", "*.{ts,tsx,js,mjs,mts,cts}"], {
    cwd: repositoryRoot,
    nodir: true,
    ignore: ["**/node_modules/**", "**/dist/**", "src/scripts/dev/**"],
  });
  const program = ts.createProgram({
    rootNames: files.map((file) => join(repositoryRoot, file)),
    options: { allowJs: true, jsx: ts.JsxEmit.Preserve, noLib: true, noResolve: true, target: ts.ScriptTarget.Latest },
  });
  const typeChecker = program.getTypeChecker();

  return files
    .flatMap((file) => {
      const sourceFile =
        program.getSourceFile(join(repositoryRoot, file)) || failConfiguration(`could not parse ${file}`);
      return inspectFile({ file, sourceFile, typeChecker });
    })
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) || left.line - right.line || left.ruleId.localeCompare(right.ruleId),
    );
};
