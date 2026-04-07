import ts from "typescript";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SDKCall, Resource } from "../graph/types.js";
import { lookupCommand } from "./patterns.js";

/** Scan a compute resource's source code for AWS SDK calls using the TS compiler API. */
export function scanFunction(
  projectRoot: string,
  resource: Resource,
): SDKCall[] {
  const filePath = resolveHandlerPath(projectRoot, resource.handler);
  if (!filePath) return [];

  return scanFile(filePath);
}

/** Resolve a Lambda handler reference to an actual file path. */
function resolveHandlerPath(
  root: string,
  handler: string | null,
): string | null {
  if (!handler) return null;

  // Strip the export name after the last dot: "src/email.handler" -> "src/email"
  const lastDot = handler.lastIndexOf(".");
  const modulePath = lastDot !== -1 ? handler.slice(0, lastDot) : handler;

  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];

  for (const ext of extensions) {
    const candidate = resolve(root, modulePath + ext);
    if (existsSync(candidate)) return candidate;
  }

  // Try as directory with index file
  for (const ext of extensions) {
    const candidate = resolve(root, modulePath, "index" + ext);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** Scan a single file using the TypeScript compiler API. */
function scanFile(filePath: string): SDKCall[] {
  const program = ts.createProgram([filePath], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    noEmit: true,
    skipLibCheck: true,
  });

  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return [];

  const calls: SDKCall[] = [];

  // Track which command names are imported from AWS SDK packages
  const importedCommands = new Set<string>();

  // First pass: collect AWS SDK imports
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        const pkg = moduleSpecifier.text;
        if (pkg.startsWith("@aws-sdk/")) {
          // Collect named imports
          const clause = node.importClause;
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const specifier of clause.namedBindings.elements) {
              const name = specifier.name.text;
              // Only track names that match known commands
              if (lookupCommand(name)) {
                importedCommands.add(name);
              }
            }
          }
        }
      }
    }
  });

  // Second pass: find `new XxxCommand(...)` expressions
  function visit(node: ts.Node): void {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const commandName = node.expression.text;
      if (importedCommands.has(commandName)) {
        const pattern = lookupCommand(commandName);
        if (pattern) {
          const { line } = sourceFile!.getLineAndCharacterOfPosition(
            node.getStart(sourceFile!),
          );
          for (const action of pattern.requiredActions) {
            calls.push({
              service: pattern.service,
              method: commandName,
              action,
              filePath,
              lineNumber: line + 1, // 1-based
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  return deduplicateCalls(calls);
}

function deduplicateCalls(calls: SDKCall[]): SDKCall[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.action}|${call.filePath}|${call.lineNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export { resolveHandlerPath as _resolveHandlerPath };
