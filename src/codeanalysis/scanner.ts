import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { SDKCall, SSTResource, ResourceRef } from "../graph/types.js";
import { lookupCommand } from "./patterns.js";

export interface ScanResult {
  sdkCalls: SDKCall[];
  resourceRefs: ResourceRef[];
}

/** Scan a compute resource's source code for AWS SDK calls and Resource.X references.
 *  Follows local imports recursively to find SDK calls in service/lib modules. */
export function scanFunction(
  projectRoot: string,
  resource: SSTResource,
): ScanResult {
  const entryPath = resolveHandlerPath(projectRoot, resource.handler);
  if (!entryPath) return { sdkCalls: [], resourceRefs: [] };

  // Collect all local files reachable from the handler
  const files = collectLocalImports(entryPath);

  const allCalls: SDKCall[] = [];
  const allRefs: ResourceRef[] = [];

  for (const file of files) {
    const result = scanFile(file);
    allCalls.push(...result.sdkCalls);
    allRefs.push(...result.resourceRefs);
  }

  return {
    sdkCalls: deduplicateCalls(allCalls),
    resourceRefs: deduplicateRefs(allRefs),
  };
}

/** Resolve a Lambda handler reference to an actual file path. */
function resolveHandlerPath(
  root: string,
  handler: string | null,
): string | null {
  if (!handler) return null;

  const lastDot = handler.lastIndexOf(".");
  const modulePath = lastDot !== -1 ? handler.slice(0, lastDot) : handler;

  return resolveModulePath(resolve(root, modulePath));
}

/** Try to resolve a module path to an actual file. */
function resolveModulePath(base: string): string | null {
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];

  for (const ext of extensions) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }

  for (const ext of extensions) {
    const candidate = resolve(base, "index" + ext);
    if (existsSync(candidate)) return candidate;
  }

  if (existsSync(base)) return base;

  return null;
}

/** Recursively collect all local files imported from the entry file. */
function collectLocalImports(entryPath: string): string[] {
  const visited = new Set<string>();
  const queue = [entryPath];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    let source: string;
    try {
      source = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);

    ts.forEachChild(sf, (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        // Only follow relative imports (local project files)
        if (specifier.startsWith(".")) {
          const resolved = resolveModulePath(resolve(dirname(file), specifier));
          if (resolved && !resolved.includes("node_modules")) {
            queue.push(resolved);
          }
        }
      }
    });
  }

  return [...visited];
}

/** Scan a single file for SDK calls and Resource.X references. */
function scanFile(filePath: string): ScanResult {
  let source: string;
  try {
    source = readFileSync(filePath, "utf-8");
  } catch {
    return { sdkCalls: [], resourceRefs: [] };
  }

  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, true);

  const sdkCalls: SDKCall[] = [];
  const resourceRefs: ResourceRef[] = [];

  // Track which command names are imported from AWS SDK packages
  const importedCommands = new Set<string>();

  // First pass: collect AWS SDK imports
  ts.forEachChild(sf, (node) => {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        const pkg = moduleSpecifier.text;
        if (pkg.startsWith("@aws-sdk/")) {
          const clause = node.importClause;
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const specifier of clause.namedBindings.elements) {
              const name = specifier.name.text;
              if (lookupCommand(name)) {
                importedCommands.add(name);
              }
            }
          }
        }
      }
    }
  });

  // Second pass: find SDK calls and Resource.X references
  function visit(node: ts.Node): void {
    // Detect: new XxxCommand(...)
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const commandName = node.expression.text;
      if (importedCommands.has(commandName)) {
        const pattern = lookupCommand(commandName);
        if (pattern) {
          const { line } = sf.getLineAndCharacterOfPosition(
            node.getStart(sf),
          );
          for (const action of pattern.requiredActions) {
            sdkCalls.push({
              service: pattern.service,
              method: commandName,
              action,
              filePath,
              lineNumber: line + 1,
            });
          }
        }
      }
    }

    // Detect: Resource.MyTable.name, Resource.MyBucket.url, etc.
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Resource"
    ) {
      const resourceName = node.expression.name.text;
      const property = node.name.text;
      const { line } = sf.getLineAndCharacterOfPosition(
        node.getStart(sf),
      );
      resourceRefs.push({
        resourceName,
        property,
        filePath,
        lineNumber: line + 1,
      });
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);

  return { sdkCalls, resourceRefs };
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

function deduplicateRefs(refs: ResourceRef[]): ResourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.resourceName}|${ref.filePath}|${ref.lineNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export { resolveHandlerPath as _resolveHandlerPath };
